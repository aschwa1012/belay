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
const { createStallWatcher, untaken } = require('../../src/run/stall-wake.cjs');
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
async function withFake(fn) {
  const saved = process.env.BELAY_CLAUDE_EXE;
  process.env.BELAY_CLAUDE_EXE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
  try { return await fn(); } finally { if (saved === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = saved; }
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
    assert.strictEqual(out.wakes.filter((w) => w.event === 'policy_digest').length, 1, 'the digest still reaches it');
    assert.deepStrictEqual(out.stall.closed_open, ['r-billwise', 'r-budget', 'r-import-3', 't-perf', 't-users']);
  } finally { cleanup(root); }
});

test('the close wake names each open task once: told, and still open, the next idle pass closes', async () => {
  const tasks = tasksA();
  const w = createStallWatcher({ core: { task: { list: async () => ({ tasks }) } }, runId: RUN });
  const first = await w.atClose(null);
  assert.match(first.text, /^belay: stalled: 1 open task, nobody assigned: t-perf\. The run closes when you next end a turn/);
  assert.strictEqual(await w.atClose(null), null, 'already told: the close goes ahead');
  assert.deepStrictEqual(w.record().closed_open, ['t-perf']);
  tasks.push(task({ id: 't-new' }));
  assert.deepStrictEqual((await w.atClose(null)).task_ids, ['t-new', 't-perf'], 'a task not yet named is named, with the rest');
  tasks.length = 0;
  assert.strictEqual(await w.atClose(null), null);
  assert.strictEqual(w.record().closed_open, null, 'nothing open: nothing to record');
  const failing = createStallWatcher({ core: { task: { list: async () => { throw new Error('E_TIMEOUT'); } } }, runId: RUN });
  assert.strictEqual(await failing.atClose(null), null, 'an unread close says nothing and closes, as the pre-close notice does');
});

test('after a planned hand-back: waits for its evaluation, skips what a policy step names, and fits the wake cap', () => {
  const w = createStallWatcher({ core: null, runId: RUN });
  const seen = new Map(); seen.pending = new Map([['t-users', {}]]); seen.absorbed = [{ worker_id: 'coder-users', task_ids: ['t-users'] }];
  const snap = { runId: RUN, tasks: tasksA(), integrations: [], steps: [] };
  assert.deepStrictEqual(w.poll(seen, snap), [], 'its evaluation is still out');
  seen.pending.clear();
  assert.deepStrictEqual(w.poll(seen, { failed: true }), [], 'an unread snapshot decides nothing');
  const [ev] = w.poll(seen, snap);
  assert.deepStrictEqual(ev.task_ids, ['t-perf']);
  seen.absorbed = [{ worker_id: 'coder-users', task_ids: ['t-users'] }];
  assert.deepStrictEqual(w.poll(seen, snap), [], 'each task is named by this wake once');
  // A step in flight on an open task (belay dispatching it) takes it out.
  const inFlight = { ...snap, steps: [{ run_id: RUN, step: 'dispatch', task_id: 't-perf', outcome: 'started' }] };
  assert.deepStrictEqual(untaken(inFlight), []);
  // Many long ids: fewer are named and the rest counted, within the cap.
  const many = Array.from({ length: 20 }, (_, i) => task({ id: `task-with-a-long-name-${String(i).padStart(2, '0')}` }));
  const w2 = createStallWatcher({ core: null, runId: RUN });
  const big = w2.poll({ absorbed: [{ worker_id: 'w', task_ids: ['x'] }], pending: new Map() }, { runId: RUN, tasks: many, integrations: [], steps: [] })[0];
  assert.ok(Buffer.byteLength(big.text) <= 221, big.text);
  assert.match(big.text, /and \d+ more\.$/);
  assert.strictEqual(big.task_ids.length, 20, 'the event keeps every id for the receipt');
});
