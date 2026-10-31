'use strict';
// The headless poll holds its in-flight guard for the whole pass, not only the worker.list read. A turn end that lands while a
// pass still holds derived, unwritten wakes must not start a second pass: that pass would close stdin under those wakes
// (they would be filed as suppressed), leave a second poll chain running, and write a refuted note's wake twice.
// Every interleaving is forced by a core call the test stalls and releases by hand, and by the fake claude's answer gate file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
const { createFakeCore } = require('./fake-core.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const tick = () => new Promise((r) => setTimeout(r, 20));
async function until(pred, ms, what) {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await tick(); }
}
// A bounded observation window in which a second pass, if the guard let one start, would show itself.
const window = (ms) => new Promise((r) => setTimeout(r, ms));

function sandbox(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `belay-pass-${tag}-`));
  const sb = { root, worktree: fwd(path.join(root, 'wt')), dataDir: fwd(path.join(root, '.belay')), orchestratorDir: fwd(path.join(root, 'orch')), gate: fwd(path.join(root, 'gate')), recv: fwd(path.join(root, 'recv.jsonl')) };
  fs.mkdirSync(sb.worktree, { recursive: true }); fs.mkdirSync(sb.dataDir, { recursive: true });
  return sb;
}
const KEYS = ['BELAY_CLAUDE_EXE', 'FAKE_ANSWER_GATE_FILE', 'FAKE_RECV_FILE'];
async function withEnv(sb, fn) {
  const keep = KEYS.map((k) => process.env[k]);
  process.env.BELAY_CLAUDE_EXE = FAKE; process.env.FAKE_ANSWER_GATE_FILE = sb.gate; process.env.FAKE_RECV_FILE = sb.recv;
  try { return await fn(); } finally {
    KEYS.forEach((k, i) => { if (keep[i] === undefined) delete process.env[k]; else process.env[k] = keep[i]; });
    try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch { /* the suite's temp guard removes what is left */ }
  }
}
const start = (core, runId, sb, extra = {}) => runOrchestrator({ core, runId, dataDir: sb.dataDir, onAttached: async () => ({ ok: true }), spec: {
  worktree: sb.worktree, promptText: 'hello', orchestratorDir: sb.orchestratorDir, model: 'claude-sonnet-5', allowedTools: null,
  startupTimeoutMs: 15000, timeoutMs: 60000, mcpToolTimeoutMs: 60000, pollMs: 100, closeGraceMs: 3000, ...extra,
} });
const streamLines = (sb, needle) => {
  try { return fs.readFileSync(path.join(sb.orchestratorDir, 'stream.jsonl'), 'utf8').split('\n').filter((l) => l.includes(needle)).length; } catch { return 0; }
};

test('a turn end during a pass does not start a second pass that closes stdin under the first pass\'s wake', { timeout: 90000 }, async () => {
  const RUN = 'run-pass-close';
  const sb = sandbox('close');
  const core = createFakeCore({ runId: RUN });
  const w = { w1: { turns: 0, mid: 0, seq: 1 }, w2: { turns: 0, mid: 0, seq: 1 } };
  const rows = () => Object.entries(w).map(([id, r]) => ({ id, run_id: RUN, state: 'running', turns: r.turns, seq: r.seq, pid: process.pid, pid_alive: true, mid_turn: r.mid }));
  let listN = 0;
  core.worker = { ...core.worker, list: async () => { listN += 1; return { workers: rows() }; } };
  // The pre-close notice fires once (a kept tree), so it is already spent when the overlap happens.
  core.task.worktreeSweep = async () => { w.w1.mid = 1; return { kept: [{ reason: 'dirty', path: 'C:/x/tree', task_ids: ['t1'], paths: ['a.txt'] }] }; };
  let arm = false, stallRelease = null, stalled = false;
  core.task.list = async () => {
    if (arm) { arm = false; stalled = true; await new Promise((r) => { stallRelease = r; }); }
    return { tasks: [] };
  };
  fs.writeFileSync(sb.gate, '1');
  await withEnv(sb, async () => {
    const runP = start(core, RUN, sb);
    let out = null; runP.then((o) => { out = o; });
    await until(() => streamLines(sb, '"type":"result"') >= 2, 20000, 'the pre-close notice answered');
    const n0 = listN; await until(() => listN >= n0 + 2, 5000, 'idle passes holding on w1');
    fs.rmSync(sb.gate); // the orchestrator's next turn stays open
    w.w2.turns = 1; w.w2.seq = 2; w.w2.mid = 0;
    await until(() => streamLines(sb, '"subtype":"init"') >= 3, 10000, 'the orchestrator to take the w2 wake');
    arm = true; w.w1.turns = 1; w.w1.seq = 2; w.w1.mid = 0; // w1 ends its turn; the pass that derives it stalls in task.list
    await until(() => stalled, 5000, 'the pass to stall');
    const listAtStall = listN;
    fs.writeFileSync(sb.gate, '1'); // the orchestrator's turn ends while the pass holds w1's turn_end
    await until(() => streamLines(sb, '"type":"result"') >= 3 || out, 10000, 'the orchestrator turn to end');
    await window(600);
    assert.equal(out, null, 'the run must not close while a pass holds an unwritten wake');
    assert.equal(listN, listAtStall, 'no second pass reads the store while the first still holds its wakes');
    stallRelease();
    const res = await runP;
    assert.ok(res.wakes.some((x) => x.worker_id === 'w1' && x.event === 'turn_end'), `w1 turn_end written: ${JSON.stringify(res.wakes.map((x) => [x.worker_id, x.event]))}`);
    assert.deepEqual(res.wakes_suppressed, []);
  });
});

test('one poll chain runs after a turn end overlapped a pass', { timeout: 60000 }, async () => {
  const RUN = 'run-pass-chain';
  const sb = sandbox('chain');
  const core = createFakeCore({ runId: RUN });
  let turns = 0, mid = 1, listN = 0;
  core.worker = { ...core.worker, list: async () => { listN += 1; return { workers: [{ id: 'w1', run_id: RUN, state: 'running', turns, seq: turns + 1, pid: process.pid, pid_alive: true, mid_turn: mid }] }; } };
  let stallRelease = null, stalled = false, calls = 0;
  core.task.list = async () => { calls += 1; if (calls === 1) { stalled = true; await new Promise((r) => { stallRelease = r; }); } return { tasks: [] }; };
  await withEnv(sb, async () => {
    const runP = start(core, RUN, sb, { timeoutMs: 30000 });
    await until(() => listN >= 3, 15000, 'polls running');
    turns = 1; // the next pass derives a turn_end and stalls in task.list
    await until(() => stalled, 5000, 'the pass to stall');
    fs.writeFileSync(sb.gate, '1'); // the orchestrator's prompt turn ends while the pass is stalled
    await until(() => streamLines(sb, '"type":"result"') >= 1, 10000, 'the orchestrator turn to end');
    const nr = listN;
    stallRelease();
    await until(() => listN >= nr + 2, 5000, 'the pass to finish and poll again');
    await window(200); // let the immediate re-poll settle before counting
    const n0 = listN;
    await window(1000);
    const rate = listN - n0;
    assert.ok(rate <= 12, `one chain polls about 10 times in a second at pollMs 100, saw ${rate}`);
    mid = 0; // the worker is done: the run may close
    await runP;
  });
});

test('two passes never write the same refuted-note wake twice', { timeout: 60000 }, async () => {
  const RUN = 'run-pass-note';
  const sb = sandbox('note');
  const core = createFakeCore({ runId: RUN });
  let listN = 0;
  core.worker = { ...core.worker, list: async () => { listN += 1; return { workers: [] }; } };
  core.task.list = async () => ({ tasks: [] });
  core.task.worktreeSweep = async () => ({ kept: [] });
  let receipt = false;
  core.memory.events = async ({ kinds }) => ({ events: receipt && kinds.includes('note_refuted') ? [{ id: 'ev-1', seq: 9, kind: 'note_refuted', ok: 1, row_ids: ['n1'] }] : [] });
  let refN = 0, stallRelease = null, stalled = false;
  core.memory.noteRefutation = async ({ note_id }) => {
    refN += 1;
    if (refN === 1) { stalled = true; await new Promise((r) => { stallRelease = r; }); }
    return { note: { id: note_id }, review: { ref: 'r1' }, shown: [], notes_written_by_shown: [] };
  };
  await withEnv(sb, async () => {
    const runP = start(core, RUN, sb, { timeoutMs: 30000, notes: true });
    await until(() => listN >= 3, 15000, 'polls running');
    receipt = true;
    await until(() => stalled, 5000, 'the pass to stall in noteRefutation');
    fs.writeFileSync(sb.gate, '1'); // the prompt turn ends while the pass is stalled
    await until(() => streamLines(sb, '"type":"result"') >= 1, 10000, 'the orchestrator turn to end');
    await window(600);
    stallRelease();
    const res = await runP;
    const notes = res.wakes.filter((x) => x.event === 'note_refuted');
    assert.equal(notes.length, 1, `one note_refuted wake for one receipt, saw ${notes.length}`);
    assert.equal(refN, 1, 'the refutation is read once');
  });
});
