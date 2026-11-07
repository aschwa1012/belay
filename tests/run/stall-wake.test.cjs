'use strict';
require('../helpers/tmp.cjs');
// stall-wake.test.cjs — ADR 0074 amendment 3. Two headless runs under a plan ended with work open and nobody assigned. Their last
// hand-back was taken by the plan (a routine hand-back wakes nobody), so the orchestrator, which had ended its turn to wait for a wake, was
// never told, and the idle close ended the run. The two sequences, through the run's own orchestrator loop (fake executable, fake core):
//   A: a coder hands back a planned task with no review step; the planned task that depends on it is open, never assigned.
//   B: a reviewer's holds on planned work is taken by the plan, which merges it; three reviews and two planned tasks are open.
// Before the fix both runs closed with no wake after the hand-back. After it: one wake after the hand-back names the open, ready
// tasks, one at the idle close names every open task, and the receipt records the close with them still open.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
const SW = () => require('../../src/run/stall-wake.cjs'); // loaded by the unit cases only, so the run cases load (and fail) on code without it
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const RUN = 'r1';
const fwd = (p) => String(p).split(path.sep).join('/');
const task = (o) => ({ seq: 1, run_id: RUN, state: 'open', policy: null, depends_on: [], repairs: null, lease: null, review: null, integration: null, handoff: null, results: null, written_at: 1, ...o });
const PLAN = { fix: 'builder', re_review: 'refuter', integrate: 'on_hold' };
const released = (by) => ({ handoff: { by, at: 10 }, results: { trigger: 'release', evaluated_at: 20, executable: true, passed: true, checks: [{ kind: 'command', argv: ['npm', 'test'], passed: true, exit_code: 0 }] } });
// A worker of the run whose one turn ended before the first poll (baselined at 0 turns: its turn end is news), alive and not mid-turn.
const worker = (id) => ({ id, run_id: RUN, state: 'running', turns: 1, mid_turn: 0, seq: 3, pid: process.pid, pid_alive: true });

// Run A: coder-users released t-users (done on its evaluation); t-perf depends on it.
const tasksA = () => [
  task({ id: 't-users', state: 'done', policy: PLAN, ...released('coder-users') }),
  task({ id: 't-perf', policy: PLAN, depends_on: ['t-users'] }),
];
// Run B: reviewer-2's holds on r-rounding, the review of planned t-rounding, which the plan has merged.
const tasksB = () => [
  task({ id: 't-rounding', state: 'done', policy: { review: { worker: 'reviewer-2' }, ...PLAN }, ...released('coder-r'), handoff: { by: 'coder-r', at: 1 }, review: { state: 'holds', review_id: 'r-rounding' }, integration: { state: 'merged' } }),
  task({ id: 'r-rounding', state: 'done', depends_on: ['t-rounding'], acceptance: { verdict: true }, handoff: { by: 'reviewer-2', at: 10 }, results: { trigger: 'release', evaluated_at: 20, executable: true, passed: true, checks: [{ kind: 'verdict', executable: true, passed: true }] } }),
  task({ id: 'b', state: 'done' }), task({ id: 'g', state: 'done' }), task({ id: 'i', state: 'done' }),
  task({ id: 'r-billwise', depends_on: ['b'], acceptance: { verdict: true } }),
  task({ id: 'r-budget', depends_on: ['g'], acceptance: { verdict: true } }),
  task({ id: 'r-import-3', depends_on: ['i'], acceptance: { verdict: true } }),
  task({ id: 't-users', policy: PLAN }),
  task({ id: 't-perf', policy: PLAN, depends_on: ['t-users'] }),
];
const stepB = { seq: 1, run_id: RUN, step: 'integrate', task_id: 't-rounding', outcome: 'done', row_ref: 'integration:i1', error: null, worker_id: null, trigger_table: 'task', trigger_id: 'r-rounding', trigger_seq: 1, finished_at: 1001 };

function setup(tasks, workers, steps = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-stall-'));
  const sb = { worktree: fwd(path.join(root, 'wt')), dataDir: fwd(path.join(root, '.belay')), orchestratorDir: fwd(path.join(root, 'orch')) };
  fs.mkdirSync(sb.worktree, { recursive: true });
  fs.mkdirSync(sb.dataDir, { recursive: true });
  const core = createFakeCore();
  core.task = { ...(core.task || {}), list: async () => ({ tasks }) };
  core.worker = { ...(core.worker || {}), list: async () => ({ workers }) };
  core.policy = { list: async (a = {}) => { const rows = steps.filter((s) => s.seq > (a.since_seq || 0)); return { rows, last_seq: rows.length ? rows[rows.length - 1].seq : 0 }; } };
  return { root, sb, core };
}
const runWith = (core, sb) => runOrchestrator({ core, runId: RUN, dataDir: sb.dataDir, onAttached: async () => ({ ok: true }), spec: {
  worktree: sb.worktree, promptText: 'hello', orchestratorDir: sb.orchestratorDir, model: 'claude-sonnet-5', allowedTools: null, policy: true,
  startupTimeoutMs: 8000, timeoutMs: 60000, mcpToolTimeoutMs: 60000, pollMs: 50, closeGraceMs: 3000,
} });
async function withFake(fn, recv = null) {
  const saved = process.env.BELAY_CLAUDE_EXE, savedRecv = process.env.FAKE_RECV_FILE;
  process.env.BELAY_CLAUDE_EXE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
  if (recv) process.env.FAKE_RECV_FILE = recv;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = saved;
    if (savedRecv === undefined) delete process.env.FAKE_RECV_FILE; else process.env.FAKE_RECV_FILE = savedRecv;
  }
}
const stalled = (out) => out.wakes.filter((w) => w.event === 'stalled');

test('run A: a planned hand-back with a dependent task left open wakes the orchestrator, and the close names the task first', async () => {
  const { root, sb, core } = setup(tasksA(), [worker('coder-users')]);
  try {
    const out = await withFake(() => runWith(core, sb)); // returns: the run closed
    const s = stalled(out);
    assert.strictEqual(s.length, 2, `a hand-back wake and a close wake: ${JSON.stringify(out.wakes)}`);
    assert.deepStrictEqual(s.map((w) => [w.established_by, w.task_ids]), [['task.list and policy.list after a hand-back the plan took', ['t-perf']], ['task.list at the idle close', ['t-perf']]]);
    assert.strictEqual(out.ended_by, 'orchestrator ended a turn with no worker mid-turn; stdin closed');
    assert.deepStrictEqual(out.stall.closed_open, ['t-perf'], 'the receipt records the close with the task still open');
  } finally { cleanup(root); }
});

test('run B: a review\'s holds the plan took, with three reviews and two planned tasks open, wakes the orchestrator before the close', async () => {
  const { root, sb, core } = setup(tasksB(), [worker('reviewer-2')], [stepB]);
  try {
    const out = await withFake(() => runWith(core, sb));
    const s = stalled(out);
    assert.ok(s.length >= 1 && s[0].established_by.startsWith('task.list and policy.list'), JSON.stringify(out.wakes));
    assert.deepStrictEqual(s[0].task_ids, ['r-billwise', 'r-budget', 'r-import-3', 't-users'], 'ready and open: t-perf waits on t-users');
    const close = s.find((w) => w.established_by === 'task.list at the idle close');
    assert.ok(close, `the close names them: ${JSON.stringify(out.wakes)}`);
    assert.deepStrictEqual(close.task_ids, ['r-billwise', 'r-budget', 'r-import-3', 't-perf', 't-users']);
    assert.strictEqual(out.wakes.filter((w) => w.event === 'policy_digest').length, 0, 'no digest line of its own');
    assert.strictEqual(close.digest_n, 1, 'the digest still reaches it: in the close notice line');
    assert.deepStrictEqual(out.stall.closed_open, ['r-billwise', 'r-budget', 'r-import-3', 't-perf', 't-users']);
  } finally { cleanup(root); }
});

// Four ready planned tasks and one worker, reused: the orchestrator assigns the next open task each time it is told one is waiting
// (the fake core does it for the fake orchestrator, on the stall wake it received), and the worker hands each back. Every hand-back
// that leaves work nobody has taken must say so, or the run closes with the queue half drained.
test('a queue of four ready tasks drained by one worker: a stalled wake after each hand-back, and the run ends with all four done', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-stall-drain-'));
  const recv = fwd(path.join(root, 'recv.jsonl'));
  let seq = 10;
  const tasks = ['a', 'b', 'c', 'd'].map((id) => task({ id, seq: ++seq, policy: PLAN, state: id === 'a' ? 'assigned' : 'open' }));
  const w1 = { ...worker('w1'), turns: 0, mid_turn: 1 };
  const S = { working: 'a', polls: 0, handled: 0 };
  const told = () => { try { return fs.readFileSync(recv, 'utf8').split('\n').filter((l) => /nobody (is )?assigned/.test(l)).length; } catch { return 0; } };
  const core = setup([], []).core; // its sandbox is unused: the run below uses this test's own
  const sbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-stall-drain-sb-'));
  const sb = { worktree: fwd(path.join(sbRoot, 'wt')), dataDir: fwd(path.join(sbRoot, '.belay')), orchestratorDir: fwd(path.join(sbRoot, 'orch')) };
  fs.mkdirSync(sb.worktree, { recursive: true }); fs.mkdirSync(sb.dataDir, { recursive: true });
  core.task = { ...(core.task || {}), list: async () => ({ tasks: tasks.map((t) => ({ ...t })) }) };
  core.worker = { ...(core.worker || {}), list: async () => {
    if (S.working) {
      if (++S.polls >= 2) { // the worker's turn ends with its hand-back evaluated done
        const t = tasks.find((x) => x.id === S.working);
        Object.assign(t, { state: 'done', seq: ++seq, handoff: { by: 'w1', at: seq }, results: { trigger: 'release', evaluated_at: seq, executable: true, passed: true, checks: [{ kind: 'command', argv: ['npm', 'test'], passed: true, exit_code: 0 }] } });
        w1.turns += 1; w1.mid_turn = 0; w1.seq += 1; S.working = null;
      }
    } else if (told() > S.handled) { // the orchestrator, told, assigns the next open task to the free worker
      const t = tasks.find((x) => x.state === 'open');
      if (t) { S.handled = told(); Object.assign(t, { state: 'assigned', seq: ++seq }); w1.mid_turn = 1; w1.seq += 1; S.working = t.id; S.polls = 0; }
    }
    return { workers: [{ ...w1 }] };
  } };
  try {
    const out = await withFake(() => runWith(core, sb), recv);
    assert.deepStrictEqual(tasks.map((t) => [t.id, t.state]), [['a', 'done'], ['b', 'done'], ['c', 'done'], ['d', 'done']], `every task done: ${JSON.stringify(out.wakes.map((w) => [w.event, w.task_ids]))}`);
    assert.deepStrictEqual(stalled(out).map((w) => w.task_ids), [['b', 'c', 'd'], ['c', 'd'], ['d']], 'one wake per hand-back that left work, each naming what was left');
    assert.strictEqual(out.stall.closed_open, null, 'nothing open at the close');
  } finally { cleanup(root); cleanup(sbRoot); }
});

test('the close wake: named again only when a task row moved, and only for a planned run', async () => {
  const { createStallWatcher } = SW();
  const tasks = tasksA();
  const w = createStallWatcher({ core: { task: { list: async () => ({ tasks }) } }, runId: RUN, planned: () => true });
  const first = await w.atClose(null);
  assert.match(first.text, /^belay: stalled: 1 open task, nobody assigned: t-perf\. The run closes when you next end a turn/);
  assert.strictEqual(first.seq, 1, 'its seq is the highest task row seq of the run');
  assert.strictEqual(await w.atClose(null), null, 'nothing moved since: the close goes ahead');
  assert.deepStrictEqual(w.record().closed_open, ['t-perf']);
  tasks.push(task({ id: 't-new', seq: 9, depends_on: ['t-perf'] }));
  const again = await w.atClose(null);
  assert.deepStrictEqual([again.task_ids, again.seq], [['t-new', 't-perf'], 9], 'a row moved: every open task is named again');
  assert.match(again.text, /nobody assigned \(1 waiting on dependencies\): t-new, t-perf\./);
  tasks.length = 0;
  assert.strictEqual(await w.atClose(null), null);
  assert.strictEqual(w.record().closed_open, null, 'nothing open: nothing to record');
  const failing = createStallWatcher({ core: { task: { list: async () => { throw new Error('E_TIMEOUT'); } } }, runId: RUN, planned: () => true });
  assert.strictEqual(await failing.atClose(null), null, 'an unread close says nothing and closes, as the pre-close notice does');
  assert.deepStrictEqual(failing.record(), { raised: [], closed_open: null, close_read_failed: true });
  // No plan anywhere: the close is not checked (the eval's arms without a plan are unchanged).
  const plain = [task({ id: 'x' })];
  const unplanned = createStallWatcher({ core: { task: { list: async () => ({ tasks: plain }) } }, runId: RUN });
  assert.strictEqual(await unplanned.atClose(null), null, 'no snapshot and no plan in the store: not read');
  assert.strictEqual(await unplanned.atClose({ runId: RUN, tasks: plain }), null, 'a snapshot with no planned task: not named');
});

test('after a planned hand-back: waits for its evaluation, wakes on every one that leaves work, leaves out halted work, fits the cap', () => {
  const { createStallWatcher, untaken } = SW();
  const w = createStallWatcher({ core: null, runId: RUN });
  const seen = new Map(); seen.pending = new Map([['t-users', {}]]); seen.absorbed = [{ worker_id: 'coder-users', task_ids: ['t-users'] }];
  const snap = { runId: RUN, tasks: tasksA(), integrations: [], steps: [] };
  assert.deepStrictEqual(w.poll(seen, snap), [], 'its evaluation is still out');
  seen.pending.clear();
  assert.deepStrictEqual(w.poll(seen, { failed: true }), [], 'an unread snapshot decides nothing');
  const [ev] = w.poll(seen, snap);
  assert.deepStrictEqual(ev.task_ids, ['t-perf']);
  assert.match(ev.text, /^belay: worker coder-users handed back t-users and the plan took the hand-back; 1 open task nobody is assigned, no policy step due: t-perf\.$/);
  seen.absorbed = [{ worker_id: 'coder-users', task_ids: ['t-users'] }];
  assert.deepStrictEqual(w.poll(seen, snap).map((e) => e.task_ids), [['t-perf']], 'a second hand-back that leaves it: told again');
  assert.deepStrictEqual(w.poll(seen, snap), [], 'no hand-back: no wake');
  // A step in flight on an open task (belay dispatching it) takes it out.
  assert.deepStrictEqual(untaken({ ...snap, steps: [{ run_id: RUN, step: 'build', task_id: 't-perf', outcome: 'started' }] }), []);
  // A halted task (its exception wake has gone) is not called "no policy step due": an E5 on t-bad halts its open fix.
  const bad = task({ id: 't-bad', state: 'released', policy: PLAN, handoff: { by: 'w9', at: 10 }, results: { trigger: 'release', evaluated_at: 20, executable: true, passed: false, checks: [{ kind: 'command', argv: ['npm', 'test'], passed: false, exit_code: 1 }] } });
  assert.deepStrictEqual(untaken({ runId: RUN, tasks: [bad, task({ id: 't-fix', repairs: 't-bad' }), task({ id: 't-free' })], integrations: [], steps: [] }), ['t-free']);
  // Many long ids: fewer are named and the rest counted, within the cap.
  const many = Array.from({ length: 20 }, (_, i) => task({ id: `task-with-a-long-name-${String(i).padStart(2, '0')}` }));
  const big = createStallWatcher({ core: null, runId: RUN }).poll({ absorbed: [{ worker_id: 'w', task_ids: ['x'] }], pending: new Map() }, { runId: RUN, tasks: many, integrations: [], steps: [] })[0];
  assert.ok(Buffer.byteLength(big.text) <= 221, big.text);
  assert.match(big.text, /and \d+ more\.$/);
  assert.strictEqual(big.task_ids.length, 20, 'the event keeps every id for the receipt');
});
