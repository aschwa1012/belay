'use strict';
require('../helpers/tmp.cjs');
// digest-wake-headless.test.cjs — ADR 0074 amendment 2, the headless path: every policy step reaches the orchestrator in exactly one digest,
// whether it waits for the run or is only woken. Before it, the headless run wrote wakes to stdin and never a digest, so an orchestrator that
// never called worker_wait saw none of belay's steps (a run woken 13 times with no wait had 11 steps in no digest). Through the run's own
// orchestrator loop (fake executable, fake core) and the run wait; the claim files are the record of what was shown.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const D = require('../../src/run/run-digest.cjs');
const DW = require('../../src/run/digest-wake.cjs');
const { createRunWait } = require('../../src/run/run-wait.cjs');
const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const RUN = 'r1';
const fwd = (p) => String(p).split(path.sep).join('/');
// A task under a plan whose release evaluation failed: one E5 exception, so the run writes one wake.
const W = {
  id: 'W', seq: 7, run_id: RUN, state: 'released', policy: { review: { worker: 'rv' }, fix: 'builder' }, depends_on: [], repairs: null, lease: null, review: null, integration: null, written_at: 50,
  handoff: { by: 'w1', at: 10 },
  results: { trigger: 'release', evaluated_at: 20, executable: true, passed: false, checks: [{ kind: 'command', argv: ['npm', 'test'], passed: false, exit_code: 1 }] },
};
const stepRow = (seq, step, taskId, ref) => ({ seq, run_id: RUN, step, task_id: taskId, outcome: 'done', row_ref: ref, error: null, worker_id: 'coder', trigger_table: 'task', trigger_id: taskId, trigger_seq: 1, finished_at: 1000 + seq });

function setup(tasks, steps) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-dw-headless-'));
  const sb = { worktree: fwd(path.join(root, 'wt')), dataDir: fwd(path.join(root, '.belay')), orchestratorDir: fwd(path.join(root, 'orch')) };
  fs.mkdirSync(sb.worktree, { recursive: true });
  fs.mkdirSync(sb.dataDir, { recursive: true });
  const core = createFakeCore();
  core.task = { ...(core.task || {}), list: async () => ({ tasks }) };
  core.policy = { list: async (a = {}) => { const rows = steps.filter((s) => s.seq > (a.since_seq || 0)); return { rows, last_seq: rows.length ? rows[rows.length - 1].seq : 0 }; } };
  return { root, sb, core };
}
const runWith = (core, sb) => runOrchestrator({ core, runId: RUN, dataDir: sb.dataDir, onAttached: async () => ({ ok: true }), spec: {
  worktree: sb.worktree, promptText: 'hello', orchestratorDir: sb.orchestratorDir, model: 'claude-sonnet-5', allowedTools: null, policy: true,
  startupTimeoutMs: 8000, timeoutMs: 60000, mcpToolTimeoutMs: 60000, pollMs: 50, closeGraceMs: 3000,
} });
async function withFake(fn) {
  const saved = process.env.BELAY_CLAUDE_EXE;
  process.env.BELAY_CLAUDE_EXE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
  try { return await fn(); } finally { if (saved === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = saved; }
}
const digestWakes = (out) => out.wakes.filter((w) => w.event === 'policy_digest');
const shownSeqs = (dataDir) => D.readDigests(dataDir, RUN).flatMap((d) => d.lines.map((l) => l.step_seq));
const clock = () => { const c = { t: 0, now: () => c.t, sleep: async (ms) => { c.t += ms; } }; return c; };

test('woken, never waiting: the steps reach the orchestrator in a digest written after the wake, once', async () => {
  const steps = [stepRow(1, 'fix', 'W', 'task:f1'), stepRow(2, 're_review', 'W', 'task:r2'), stepRow(3, 'integrate', 'W', 'integration:i1')];
  const { root, sb, core } = setup([W], steps);
  try {
    const out = await withFake(() => runWith(core, sb));
    assert.strictEqual(out.wakes.filter((w) => w.exception === 'E5').length, 1, JSON.stringify(out.wakes));
    assert.strictEqual(digestWakes(out).length, 1, `one digest wake: ${JSON.stringify(out.wakes)}`);
    assert.deepStrictEqual([digestWakes(out)[0].established_by, digestWakes(out)[0].digest_n], ['policy.list; digest d1', 1], 'the receipt names what established it, joined to digests[]');
    const ds = D.readDigests(sb.dataDir, RUN);
    assert.deepStrictEqual(ds.map((d) => d.via), ['wake']);
    assert.deepStrictEqual(shownSeqs(sb.dataDir), [1, 2, 3], 'every step shown, each once');
    const r = await createRunWait({ core, runId: RUN, dataDir: sb.dataDir, pollMs: 100, clock: clock() }).wait({ ms: 300, t0: 0, workers: [] });
    assert.strictEqual(r.digest, undefined, 'the wait does not show them again');
  } finally { cleanup(root); }
});

test('a step after the last wake: the idle close writes the digest first, then closes', async () => {
  const { root, sb, core } = setup([], [stepRow(1, 'integrate', 'X', 'integration:i9')]);
  try {
    const out = await withFake(() => runWith(core, sb));
    assert.strictEqual(digestWakes(out).length, 1, JSON.stringify(out.wakes));
    assert.deepStrictEqual(shownSeqs(sb.dataDir), [1]); // runOrchestrator returned: the run still closed, after the digest
  } finally { cleanup(root); }
});

test('a mix: steps a wait already showed are not in the wake\'s digest, and the rest are, once each', async () => {
  const steps = [stepRow(1, 'fix', 'W', 'task:f1'), stepRow(2, 're_review', 'W', 'task:r2')];
  const { root, sb, core } = setup([W], steps);
  try {
    const waited = D.claimDigest({ dataDir: sb.dataDir, runId: RUN, rows: steps.slice(0, 1), via: 'wait' }); // the orchestrator waited once, then only by the wake
    assert.deepStrictEqual(waited.lines.map((l) => l.step_seq), [1]);
    const out = await withFake(() => runWith(core, sb));
    assert.strictEqual(digestWakes(out).length, 1);
    const ds = D.readDigests(sb.dataDir, RUN);
    assert.deepStrictEqual(ds.map((d) => [d.via, d.lines.map((l) => l.step_seq)]), [['wait', [1]], ['wake', [2]]]);
  } finally { cleanup(root); }
});

test('the wait claimed every step first: the run writes no digest wake', async () => {
  const steps = [stepRow(1, 'fix', 'W', 'task:f1')];
  const { root, sb, core } = setup([W], steps);
  try {
    assert.ok(D.claimDigest({ dataDir: sb.dataDir, runId: RUN, rows: steps, via: 'wait' }));
    const out = await withFake(() => runWith(core, sb));
    assert.strictEqual(digestWakes(out).length, 0, JSON.stringify(out.wakes));
    assert.deepStrictEqual(D.readDigests(sb.dataDir, RUN).map((d) => d.via), ['wait']);
  } finally { cleanup(root); }
});

test('a digest wake the run could not write gives its claim back, so the steps stay for the next asker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-dw-unit-'));
  try {
    const dataDir = fwd(root);
    const rows = [stepRow(1, 'fix', 'W', 'task:f1')];
    const rec = D.claimDigest({ dataDir, runId: RUN, rows, via: 'wake' });
    const state = { wakesSuppressed: [] };
    const ev = { event: 'policy_digest', worker_id: `digest:${RUN}`, text: rec.text, digest_n: rec.n };
    assert.strictEqual(DW.deliver(ev, { writeWake: (e) => state.wakesSuppressed.push({ ...e, reason: 'stdin was broken' }), state, dataDir, runId: RUN }), false);
    const again = D.claimDigest({ dataDir, runId: RUN, rows, via: 'wait' });
    assert.ok(again && again.lines[0].step_seq === 1, 'released: the wait is offered the step');
  } finally { cleanup(root); }
});

// The idle close's digest (amendment 2, decision 2): one write per batch of steps, and a write that fails does not hold the close.
async function closePass(flushDigest, state) {
  let closed = null;
  await require('../../src/run/orchestrator-idle-close.cjs').idleClose({
    state, rows: [], runId: RUN, pending_deaths: [], turnAtCall: 1, hold: { isPaused: () => false }, awaitingWakeIds: () => [],
    callWatcher: { holds: () => [] }, preClose: { check: async () => ({ ran: false }) }, recordHold() {}, writeWake() {},
    closeThenKillOnDeadline: (why) => { closed = why; }, flushDigest,
  });
  return closed;
}

test('the idle close writes one digest per batch, then closes; a digest it cannot write does not hold the close', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-dw-close-'));
  try {
    const dataDir = fwd(root);
    const steps = [stepRow(1, 'integrate', 'X', 'integration:i1')];
    const core = { policy: { list: async () => ({ rows: steps.slice(), last_seq: steps.length }) } };
    const written = [];
    const state = { pendingWrites: [], evalSeen: new Map(), finishing: false, idle: true, wakesSuppressed: [] };
    const ctx = { core, dataDir, runId: RUN, state, writeWake: (e) => written.push(e), armed: () => true };
    assert.strictEqual(await closePass(() => DW.flush(ctx), state), null, 'the digest is written instead of closing');
    assert.deepStrictEqual(written.map((e) => e.event), ['policy_digest']);
    assert.ok(await closePass(() => DW.flush(ctx), state), 'nothing new: the next idle pass closes, with no second digest');
    assert.strictEqual(written.length, 1);
    // A new step, and stdin is broken: the write is suppressed, the claim given back, and the close goes ahead.
    steps.push(stepRow(2, 'fix', 'X', 'task:f2'));
    const broken = { ...ctx, writeWake: (e) => state.wakesSuppressed.push({ ...e, reason: 'stdin was broken when this event was found' }) };
    assert.ok(await closePass(() => DW.flush(broken), state), 'a failed digest write does not hold the close');
    assert.deepStrictEqual(D.readDigests(dataDir, RUN).map((d) => d.lines.map((l) => l.step_seq)), [[1]], 'the unwritten claim was released');
  } finally { cleanup(root); }
});

test('a claim that fails on a file error (EPERM) claims nothing and does not throw: the run goes on, and the steps are claimed later', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-dw-eperm-'));
  const nodeFs = require('node:fs');
  const realLink = nodeFs.linkSync;
  try {
    const dataDir = fwd(root);
    const steps = [stepRow(1, 'fix', 'W', 'task:f1')];
    const core = { policy: { list: async () => ({ rows: steps.slice(), last_seq: 1 }) } };
    const written = [];
    const state = { pendingWrites: [], wakesSuppressed: [], finishing: false };
    const ctx = { core, dataDir, runId: RUN, state, writeWake: (e) => written.push(e), armed: () => true };
    nodeFs.linkSync = () => { throw Object.assign(new Error('operation not permitted, link'), { code: 'EPERM' }); };
    assert.strictEqual(await DW.claim(ctx), null);
    await DW.writeAll([{ event: 'evaluated', worker_id: 'w1', text: 'a wake' }], ctx); // must not throw
    assert.strictEqual(await DW.flush(ctx), false);
    assert.deepStrictEqual(written.map((e) => e.event), ['evaluated'], 'the wake went out; no digest was claimed');
    nodeFs.linkSync = realLink;
    assert.strictEqual(await DW.flush(ctx), true, 'once the file call works again, the steps are claimed and written');
    assert.deepStrictEqual(D.readDigests(dataDir, RUN).map((d) => d.lines.map((l) => l.step_seq)), [[1]]);
  } finally { nodeFs.linkSync = realLink; cleanup(root); }
});

// The operator's rule for 0.4.0: the orchestrator does not use worker_wait. A run where it never calls it still gets every exception, every
// death and every step, each exactly once, by the wake, and still closes. The fake orchestrator makes no tool call at all.
test('an orchestrator that never calls worker_wait gets every exception, death and step once, by the wake, and the run closes', async () => {
  const steps = [stepRow(1, 'fix', 'W', 'task:f1'), stepRow(2, 're_review', 'W', 'task:r2'), stepRow(3, 'integrate', 'W', 'integration:i1')];
  const { root, sb, core } = setup([W], steps);
  try {
    core.worker = { ...(core.worker || {}), list: async () => ({ workers: [{ id: 'w2', run_id: RUN, state: 'dead', turns: 3, seq: 2, pid: 111, pid_created: 5, exit_code: 1, exit_signal: null, death_established_by: 'exit' }] }) };
    const out = await withFake(() => runWith(core, sb)); // returns: the run closed
    assert.strictEqual(out.wakes.filter((w) => w.exception === 'E5').length, 1, JSON.stringify(out.wakes));
    assert.strictEqual(out.wakes.filter((w) => w.event === 'death' && w.worker_id === 'w2').length, 1, 'the death, once');
    assert.deepStrictEqual(shownSeqs(sb.dataDir), [1, 2, 3], 'every step in a digest, once');
    assert.ok(D.readDigests(sb.dataDir, RUN).every((d) => d.via === 'wake'), 'no wait was needed');
    assert.deepStrictEqual(out.wakes_suppressed.filter((w) => w.reason === 'delivered by worker_wait'), [], 'nothing left to a wait');
  } finally { cleanup(root); }
});

// A wait that claimed an exception first and then gave the claim back (cancelled before its reply, or its adapter gone) leaves it to the
// stdin path, which offers it again: a released exception is not left to a later wait.
test('an exception a wait claimed and then released reaches the orchestrator by the stdin wake, once', async () => {
  const { root, sb, core } = setup([W], []);
  try {
    const PW = require('../../src/run/policy-wakes.cjs');
    const w = (await PW.createPolicyWatcher({ core, runId: RUN, enabled: true }).poll())[0];
    const uid = `${w.worker_id}:${w.key}`;
    assert.ok(D.claimException({ dataDir: sb.dataDir, runId: RUN, uid }), 'a wait claimed it first');
    let polls = 0;
    const list = core.worker && core.worker.list ? core.worker.list : async () => ({ workers: [] });
    core.worker = { ...(core.worker || {}), list: async (a) => { polls += 1; if (polls === 2) D.release({ dataDir: sb.dataDir, runId: RUN, uids: [uid] }); return list(a); } }; // the wait's reply was never sent
    const out = await withFake(() => runWith(core, sb));
    assert.strictEqual(out.wakes_suppressed.filter((s) => s.exception === 'E5' && s.reason === 'delivered by worker_wait').length, 1, 'first held back for the wait');
    assert.strictEqual(out.wakes.filter((x) => x.exception === 'E5').length, 1, `then written once the claim was given back: ${JSON.stringify(out.wakes)}`);
  } finally { cleanup(root); }
});

// The done wake is delivered once, headless as well: the stdin wake claims it like an exception, so a run wait that took it first suppresses it.
test('headless: the done wake is written once, and not at all when the run wait claimed it first', async () => {
  const PLAN = { review: { worker: 'rv' }, integrate: 'on_hold' };
  const done = [
    { id: 'A', seq: 10, run_id: RUN, state: 'done', policy: PLAN, policy_rev: 1, depends_on: [], repairs: null, lease: null, acceptance: { commands: [] }, review: { review_id: 'R', state: 'holds' }, integration: { state: 'merged' }, results: { trigger: 'release', executable: true, passed: true, checks: [] } },
    { id: 'R', seq: 11, run_id: RUN, state: 'done', policy: null, depends_on: ['A'], repairs: null, lease: null, acceptance: { verdict: true }, results: { trigger: 'release', evaluated_at: 9, executable: true, passed: true, checks: [{ kind: 'verdict', executable: true, passed: true }] } },
  ];
  const ints = [{ id: 'i1', seq: 20, run_id: RUN, state: 'evaluated', passed: true, into_branch: `belay/integrate/${RUN}`, head_sha: '0123456789abcdef' }];
  for (const waitFirst of [false, true]) {
    const { root, sb, core } = setup(done, []);
    try {
      core.integration = { list: async () => ({ integrations: ints }) };
      const { doneOf, wakeOf } = require('../../src/run/done-wake.cjs');
      const uid = D.wakeUid(wakeOf(RUN, doneOf({ runId: RUN, tasks: done, integrations: ints, steps: [] })));
      if (waitFirst) assert.ok(D.claimException({ dataDir: sb.dataDir, runId: RUN, uid }), 'the run wait returned it');
      const out = await withFake(() => runWith(core, sb));
      const written = out.wakes.filter((w) => w.event === 'policy_done');
      if (waitFirst) {
        assert.deepStrictEqual(written, [], 'not written to stdin: the wait has it');
        assert.strictEqual(out.wakes_suppressed.filter((w) => w.event === 'policy_done' && w.reason === 'delivered by worker_wait').length, 1);
      } else {
        assert.strictEqual(written.length, 1, `written once: ${JSON.stringify(out.wakes)}`);
        assert.ok(D.isClaimed({ dataDir: sb.dataDir, runId: RUN, uid }), 'and claimed, so a later wait does not return it');
      }
    } finally { cleanup(root); }
  }
});
