'use strict';
require('../helpers/tmp.cjs');
// wake-held-receipt.test.cjs — every wake a run found is in its receipt, written or suppressed with a reason, also one held for
// its release evaluation (BELAY_RELEASE_WAKE_HOLD_MS) when the run ends by timeout, by the stop hook, or the publisher stops.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const RE = require('../../src/run/release-eval.cjs');
const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
const { startWakePublisher } = require('../../src/run/wake-pipe.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const RUN = 'run-held';
const until = async (fn, ms, what) => { for (const end = Date.now() + ms; Date.now() < end;) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); } throw new Error(`timed out waiting for ${what}`); };

test('drainHeld hands back the held turn_ends once and leaves nothing held', async () => {
  const seen = new Map();
  const tasks = [{ id: 't1', run_id: 'r', state: 'released', handoff: { by: 'w1', at: 10 }, results: null }];
  await RE.enrichWakes({ task: { list: async () => ({ tasks }) } }, 'r', [{ worker_id: 'w1', event: 'turn_end', turn: 1, seq: 2 }], seen, { holdMs: 30000, now: () => 1000 });
  assert.deepStrictEqual(RE.evaluatingHolds(seen, [], 'r'), ['wake:w1']);
  assert.deepStrictEqual(RE.drainHeld(seen).map((e) => [e.worker_id, e.event, e.turn]), [['w1', 'turn_end', 1]]);
  assert.deepStrictEqual(RE.drainHeld(seen), []);
  assert.deepStrictEqual(RE.evaluatingHolds(seen, [], 'r'), []);
  assert.deepStrictEqual(RE.drainHeld(undefined), []);
});

async function headless(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-held-receipt-'));
  const sb = { worktree: fwd(path.join(root, 'wt')), dataDir: fwd(path.join(root, '.belay')), orchestratorDir: fwd(path.join(root, 'orch')) };
  fs.mkdirSync(sb.worktree, { recursive: true }); fs.mkdirSync(sb.dataDir, { recursive: true });
  const core = createFakeCore({ runId: RUN });
  const w1 = { turns: 0, seq: 1, mid: 1 };
  core.worker = { ...core.worker, list: async () => ({ workers: [{ id: 'w1', run_id: RUN, state: 'running', turns: w1.turns, seq: w1.seq, pid: process.pid, pid_alive: true, mid_turn: w1.mid }] }) };
  let handed = false; let taskLists = 0;
  core.task.list = async () => { taskLists += 1; return { tasks: handed ? [{ id: 't1', run_id: RUN, state: 'released', handoff: { by: 'w1', at: 1000 }, results: null }] : [] }; };
  core.task.worktreeSweep = async () => ({ kept: [] });
  core.memory.events = async () => ({ events: [] });
  const saved = { exe: process.env.BELAY_CLAUDE_EXE, hold: process.env.BELAY_RELEASE_WAKE_HOLD_MS };
  process.env.BELAY_CLAUDE_EXE = FAKE;
  process.env.BELAY_RELEASE_WAKE_HOLD_MS = '60000';
  let stopHook = null;
  try {
    const runP = runOrchestrator({ core, runId: RUN, dataDir: sb.dataDir, onAttached: async () => ({ ok: true }), stopControl: { attach: (h) => { stopHook = h; } }, spec: {
      worktree: sb.worktree, promptText: 'hello', orchestratorDir: sb.orchestratorDir, model: 'claude-sonnet-5', allowedTools: null,
      startupTimeoutMs: 15000, timeoutMs: mode === 'timeout' ? 4000 : 60000, mcpToolTimeoutMs: 60000, pollMs: 50, closeGraceMs: 3000,
    } });
    const results = () => { try { return fs.readFileSync(path.join(sb.orchestratorDir, 'stream.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"type":"result"')).length; } catch { return 0; } };
    await until(() => results() >= 1, 15000, 'the prompt turn');
    handed = true; w1.turns = 1; w1.seq = 2; w1.mid = 0; // w1 hands back and ends its turn: held for its evaluation
    const n = taskLists;
    await until(() => taskLists >= n + 3, 5000, 'passes that hold the turn_end');
    if (mode === 'stop') await stopHook.stop('belay stop');
    return await runP;
  } finally {
    for (const [k, v] of [['BELAY_CLAUDE_EXE', saved.exe], ['BELAY_RELEASE_WAKE_HOLD_MS', saved.hold]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    cleanup(root);
  }
}

for (const mode of ['timeout', 'stop']) {
  test(`a turn_end held for its evaluation is in the receipt when the run ends by ${mode}`, async () => {
    const out = await headless(mode);
    const all = [...out.wakes, ...out.wakes_suppressed];
    const mine = all.filter((x) => x.worker_id === 'w1' && x.event === 'turn_end');
    assert.strictEqual(mine.length, 1, `w1's turn_end is recorded once: ended_by ${out.ended_by}, wakes ${JSON.stringify(out.wakes)}, suppressed ${JSON.stringify(out.wakes_suppressed)}`);
    if (out.wakes_suppressed.includes(mine[0])) assert.match(mine[0].reason, /held for its release evaluation/);
  });
}

const uniquePipe = () => (process.platform === 'win32'
  ? `\\\\.\\pipe\\belay-test-held-${crypto.randomBytes(5).toString('hex')}`
  : path.join(os.tmpdir(), `belay-test-held-${crypto.randomBytes(5).toString('hex')}.sock`));

test('the interactive publisher records the held and the paused-queue wakes it drops when it stops', async () => {
  const s = { rows: [{ id: 'w1', run_id: 'r', state: 'running', turns: 0, seq: 1, pid_alive: true, mid_turn: 0 }, { id: 'w2', run_id: 'r', state: 'running', turns: 0, seq: 1, pid_alive: true, mid_turn: 0 }], tasks: [], polls: 0 };
  const core = { worker: { list: async () => { s.polls += 1; return { workers: s.rows.map((r) => ({ ...r })) }; } }, task: { list: async () => ({ tasks: s.tasks }) } };
  let held = false;
  const pub = startWakePublisher({ core, runId: 'r', pipeName: uniquePipe(), pollMs: 20, isHeld: () => held });
  await pub.listening;
  try {
    await until(() => s.polls >= 2, 10000, 'the baseline');
    s.tasks = [{ id: 't1', run_id: 'r', state: 'released', handoff: { by: 'w1', at: 10 }, results: null }];
    s.rows = [{ ...s.rows[0], turns: 1, seq: 2 }, s.rows[1]]; // w1 ends a turn: held for its evaluation
    const at = s.polls;
    await until(() => s.polls >= at + 3, 10000, 'w1 held over polls');
    held = true; // a run pause: what is found next is queued
    s.rows = [s.rows[0], { ...s.rows[1], turns: 1, seq: 2 }];
    await until(() => pub.stats().queued >= 1, 10000, 'w2 queued');
  } finally {
    await pub.stop();
  }
  const dropped = pub.droppedWakes();
  assert.deepStrictEqual(dropped.map((d) => [d.worker_id, d.event]).sort(), [['w1', 'turn_end'], ['w2', 'turn_end']]);
  assert.ok(dropped.every((d) => d.id && d.reason), JSON.stringify(dropped));
  assert.strictEqual(pub.stats().dropped, 2);
});
