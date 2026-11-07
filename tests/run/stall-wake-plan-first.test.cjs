'use strict';
require('../helpers/tmp.cjs');
// stall-wake-plan-first.test.cjs — the stalled wake under plan-first (ADR 0074 amendments 3 and 4), against the real policy-exec.cjs due().
// - due() lists a build for an open, ready planned task until a build claim for it is in the steps it is given. A task a build step took whose
//   builder then died is open again, and belay neither halts nor respawns it: it is the orchestrator's, so the stalled wake names it.
// - A task whose dependency is done but still to be merged by its plan (an integrate due) is not free: due() lists no build for it until the
//   merge, so the wake does not call it "no policy step due".

const test = require('node:test');
const assert = require('node:assert');

const { due } = require('../../src/run/policy-exec.cjs');
const { createStallWatcher, untaken } = require('../../src/run/stall-wake.cjs');

const RUN = 'r1';
const PLAN = { build: { spawn: { worker_id: 'coder' } }, review: { worker: 'rv' }, fix: 'builder', integrate: 'on_hold' };
const task = (o) => ({ seq: 1, run_id: RUN, state: 'open', policy: PLAN, depends_on: [], repairs: null, lease: null, review: null, integration: null, handoff: null, results: null, written_at: 1, ...o });
const evaluated = (by, at = 10) => ({ handoff: { by, at }, results: { trigger: 'release', evaluated_at: at + 10, executable: true, passed: true, checks: [{ kind: 'command', argv: ['npm', 'test'], passed: true, exit_code: 0 }] } });
const verdict = (by) => ({ policy: null, acceptance: { verdict: true }, handoff: { by, at: 30 }, results: { trigger: 'release', evaluated_at: 40, executable: true, passed: true, checks: [{ kind: 'verdict', executable: true, passed: true }] } });
const handBack = (wid, ids) => ({ absorbed: [{ worker_id: wid, task_ids: ids }], pending: new Map() });

// t-done: built, reviewed (holds) and merged. t-orphan: a build step took it, its builder died and the lease went back. t-queued: not yet built.
const orphanTasks = () => [
  task({ id: 't-done', state: 'done', seq: 5, ...evaluated('coder-a'), review: { state: 'holds', review_id: 'r-done' }, integration: { state: 'merged' } }),
  task({ id: 'r-done', state: 'done', seq: 6, depends_on: ['t-done'], ...verdict('rv') }),
  task({ id: 't-orphan', seq: 7 }),
  task({ id: 't-queued', seq: 8 }),
];
const buildTook = { seq: 3, run_id: RUN, step: 'build', task_id: 't-orphan', outcome: 'done', trigger_table: 'task', trigger_id: 't-orphan', trigger_seq: 2, finished_at: 900 };

test('plan-first: a task a build step took, whose builder died, is named by the stalled wake; one the plan still carries is not', () => {
  const snap = { runId: RUN, tasks: orphanTasks(), integrations: [], steps: [buildTook] };
  assert.deepStrictEqual(due(snap).filter((c) => c.step === 'build').map((c) => c.task_id), ['t-queued'], 'the real due(): the taken build is not listed again');
  assert.deepStrictEqual(untaken(snap), ['t-orphan']);
  const [ev] = createStallWatcher({ core: null, runId: RUN }).poll(handBack('rv', ['r-done']), snap);
  assert.ok(ev, 'a wake after the hand-back');
  assert.deepStrictEqual(ev.task_ids, ['t-orphan']);
  assert.match(ev.text, /no policy step due: t-orphan\.$/);
});

test('plan-first: with no build taken, every open ready planned task is carried by the plan, and no wake is sent', () => {
  const snap = { runId: RUN, tasks: orphanTasks(), integrations: [], steps: [] };
  assert.deepStrictEqual(untaken(snap), []);
  assert.deepStrictEqual(createStallWatcher({ core: null, runId: RUN }).poll(handBack('rv', ['r-done']), snap), []);
});

// t-dep is done and its review holds, so the plan's integrate of it is due; t-next depends on it and is built only once it is merged.
const mergeTasks = () => [
  task({ id: 't-dep', state: 'done', seq: 5, ...evaluated('coder-a'), review: { state: 'holds', review_id: 'r-dep' } }),
  task({ id: 'r-dep', state: 'done', seq: 6, depends_on: ['t-dep'], ...verdict('rv') }),
  task({ id: 't-next', seq: 7, depends_on: ['t-dep'] }),
];

test('plan-first: a task whose dependency the plan has still to merge is not named as free while the integrate is due or in flight', () => {
  const snap = { runId: RUN, tasks: mergeTasks(), integrations: [], steps: [] };
  assert.deepStrictEqual(due(snap).map((c) => [c.step, c.task_id]), [['integrate', 't-dep']], 'the real due(): the integrate is due, no build of t-next yet');
  assert.deepStrictEqual(untaken(snap), []);
  assert.deepStrictEqual(createStallWatcher({ core: null, runId: RUN }).poll(handBack('rv', ['r-dep']), snap), [], 'no wake: the plan carries the chain');
  const inFlight = { ...snap, steps: [{ seq: 9, run_id: RUN, step: 'integrate', task_id: 't-dep', outcome: 'started', claimant_pid: 1 }] };
  assert.deepStrictEqual(untaken(inFlight), [], 'the integrate claim started: still not free');
});

test('plan-first: once merged, the dependent is the build\'s; a done dependency no step will merge leaves its dependent free', () => {
  const merged = mergeTasks(); merged[0].integration = { state: 'merged' };
  const snap = { runId: RUN, tasks: merged, integrations: [], steps: [] };
  assert.deepStrictEqual(due(snap).map((c) => [c.step, c.task_id]), [['build', 't-next']]);
  assert.deepStrictEqual(untaken(snap), [], 'the build carries it');
  // A plan with no build or review: nothing of the plan is pending on t-dep, so the orchestrator's t-next is free once t-dep is done.
  const bare = { fix: 'builder', integrate: 'on_hold' };
  const tasks = [task({ id: 't-dep', state: 'done', policy: bare, ...evaluated('coder-a') }), task({ id: 't-next', policy: bare, depends_on: ['t-dep'] })];
  assert.deepStrictEqual(untaken({ runId: RUN, tasks, integrations: [], steps: [] }), ['t-next']);
});

// t-a is done and the plan is still carrying it to its merge, with no step due or in flight on it: its review was handed over (the review step
// has ended) and is being done, or its last allowed fix round is in progress. t-b depends on it and must not be called free.
test('plan-first: a dependency under review is carried by the plan: its dependent is not named', () => {
  const reviewing = [
    task({ id: 't-a', state: 'done', seq: 5, ...evaluated('coder-a'), review: { state: 'pending', review_id: 'r-a' } }),
    task({ id: 'r-a', state: 'assigned', seq: 6, policy: null, depends_on: ['t-a'], acceptance: { verdict: true }, lease: { id: 'l1', holder: 'rv' } }),
    task({ id: 't-b', seq: 7, depends_on: ['t-a'] }),
  ];
  const snap = { runId: RUN, tasks: reviewing, integrations: [], steps: [] };
  assert.deepStrictEqual(due(snap), [], 'the real due(): no step is due or in flight while the review is done');
  assert.deepStrictEqual(untaken(snap), [], 'under review: t-b waits on the plan');
  assert.deepStrictEqual(createStallWatcher({ core: null, runId: RUN }).poll(handBack('coder-c', ['t-c']), snap), []);
});

test('plan-first: a dependency in a fix round is carried by the plan: its dependent is not named until nothing is left on it', () => {
  const fixing = [
    task({ id: 't-a', state: 'done', seq: 5, ...evaluated('coder-a'), review: { state: 'refuted', review_id: 'r-a', fix_rounds_used: 1, max_fix_rounds: 1 } }),
    task({ id: 'r-a', state: 'released', seq: 6, depends_on: ['t-a'], ...verdict('rv'), results: { trigger: 'release', evaluated_at: 40, executable: true, passed: false, checks: [{ kind: 'verdict', executable: true, passed: false }] } }), // a refuted review ends released
    task({ id: 'f-a', state: 'assigned', seq: 8, repairs: 't-a', policy: null, lease: { id: 'l2', holder: 'coder-a' } }),
    task({ id: 't-b', seq: 7, depends_on: ['t-a'] }),
  ];
  const fsnap = { runId: RUN, tasks: fixing, integrations: [], steps: [] };
  assert.deepStrictEqual(due(fsnap), [], 'the real due(): the last fix round is being built, nothing due');
  assert.deepStrictEqual(untaken(fsnap), [], 'in a fix round: t-b waits on the plan');
  // The fix lands and nothing of the plan is left on t-a (its integrate is on_hold for a review that is not coming): t-b is the orchestrator's.
  fixing[2].state = 'done'; fixing[0].review = { state: 'refuted', review_id: 'r-a', fix_rounds_used: 1, max_fix_rounds: 1 };
  const after = { runId: RUN, tasks: fixing.map((t) => ({ ...t, policy: t.id === 't-a' || t.id === 't-b' ? { fix: 'builder', integrate: 'on_hold' } : t.policy })), integrations: [], steps: [] };
  assert.deepStrictEqual(untaken(after), ['t-b'], 'the fix done and the refuted review released, no step due: only the orchestrator can move t-b');
});

// An escalation halts a planned task and its fixes (HALTING); its wake has gone, so the stalled wake leaves them out. An unplanned escalation
// halts nothing and wakes on its own (release-eval.cjs); its task is handed back, not open, so it is never named either.
test('plan-first: an escalated planned task and its open fix are left out; an unplanned escalated task is not named', () => {
  const esc = (by) => ({ handoff: { by, at: 10, result: { escalate: { kind: 'blocked', reason: 'the spec contradicts itself' } } } });
  const tasks = [
    task({ id: 't-esc', state: 'released', seq: 5, ...esc('coder-a') }),
    task({ id: 'f-esc', seq: 6, repairs: 't-esc', policy: null }),
    task({ id: 'u-esc', state: 'released', seq: 7, policy: null, ...esc('coder-u') }),
    task({ id: 't-free', seq: 8, policy: { fix: 'builder' } }),
  ];
  const snap = { runId: RUN, tasks, integrations: [], steps: [] };
  const PW = require('../../src/run/policy-wakes.cjs');
  assert.ok(PW.derive(snap).some((e) => e.exception === 'escalation' && e.task_id === 't-esc'), 'the planned escalation is derived, and halts');
  assert.ok(PW.unplannedEscalation(tasks[2]), 'the unplanned one wakes on its own');
  assert.deepStrictEqual(untaken(snap), ['t-free']);
});

test('plan-first: a done dependency whose integrate waits behind another integration merging is carried, so its dependent is not named', () => {
  const tasks = mergeTasks();
  const snap = { runId: RUN, tasks, integrations: [{ run_id: RUN, state: 'merging', task_id: 't-other' }], steps: [] };
  assert.deepStrictEqual(due(snap).filter((c) => c.step === 'integrate'), [], 'due() withholds the integrate while another merges');
  assert.deepStrictEqual(untaken(snap), [], 'the plan still carries t-dep to its merge: t-next is not free');
  assert.deepStrictEqual(createStallWatcher({ core: null, runId: RUN }).poll(handBack('rv', ['r-dep']), snap), []);
});

// A released review the reviewer handed back, whose evaluation has not landed: the plan is still about to act on t-dep (fix or merge).
test('plan-first: a released review whose evaluation has not landed carries its work, so its dependent is not named', () => {
  const tasks = [
    task({ id: 't-dep', state: 'done', seq: 5, ...evaluated('coder-a') }),
    task({ id: 'r-dep', state: 'released', seq: 6, depends_on: ['t-dep'], policy: null, acceptance: { verdict: true }, handoff: { by: 'rv', at: 50 }, results: null }),
    task({ id: 't-next', seq: 7, depends_on: ['t-dep'] }),
  ];
  assert.deepStrictEqual(untaken({ runId: RUN, tasks, integrations: [], steps: [] }), [], 'evaluation pending: carried');
  tasks[1].results = { trigger: 'release', evaluated_at: 60, executable: true, passed: true, checks: [] };
  assert.deepStrictEqual(untaken({ runId: RUN, tasks, integrations: [], steps: [] }), ['t-next'], 'evaluated: settled again (the old rule)');
});

test('plan-first: the review a started step has just written, and not yet assigned, is not named; only planned tasks are', () => {
  const tasks = [
    task({ id: 't-fix', state: 'done', seq: 5, ...evaluated('coder-a') }),
    task({ id: 'r-new', seq: 8, depends_on: ['t-fix'], policy: null, acceptance: { verdict: true } }),
    task({ id: 't-hand', seq: 9, policy: null }),
  ];
  const started = [{ seq: 4, run_id: RUN, step: 're_review', task_id: 't-fix', outcome: 'started', claimant_pid: 1 }];
  assert.deepStrictEqual(untaken({ runId: RUN, tasks, integrations: [], steps: started }), [], 'the step owns r-new; t-hand is the orchestrator\'s own (policy null)');
  assert.deepStrictEqual(untaken({ runId: RUN, tasks, integrations: [], steps: [] }), [], 'a policy-null review and a policy-null task are never named');
});

test('plan-first: a done dependency waiting behind a merge in flight is carried, as in the p1 pilot', () => {
  const tasks = [
    task({ id: 't-a', state: 'done', seq: 5, ...evaluated('coder-a'), review: { state: 'holds', review_id: 'r-a' } }),
    task({ id: 'r-a', state: 'done', seq: 6, depends_on: ['t-a'], ...verdict('rv') }),
    task({ id: 't-b', seq: 7, depends_on: ['t-a'] }),
  ];
  assert.deepStrictEqual(untaken({ runId: RUN, tasks, integrations: [{ run_id: RUN, state: 'merging' }], steps: [] }), []);
});

test('the carried predicate is one module: the stall wake uses it, and a genuinely stuck planned task is still named', () => {
  assert.strictEqual(untaken, require('../../src/run/policy-carried.cjs').untaken, 'stall-wake exports the shared predicate');
  // Its build was claimed and finished, the builder is gone, nothing is due, nothing is in flight, nothing blocks it: the safety net names it.
  const tasks = [task({ id: 't-stuck', seq: 3 })];
  const steps = [{ seq: 1, run_id: RUN, step: 'build', task_id: 't-stuck', outcome: 'done', trigger_table: 'task', trigger_id: 't-stuck', trigger_seq: 3, finished_at: 5 }];
  assert.deepStrictEqual(due({ runId: RUN, tasks, integrations: [], steps }), []);
  assert.deepStrictEqual(untaken({ runId: RUN, tasks, integrations: [], steps }), ['t-stuck']);
});

test('plan-first: a stale merging row is no merge in flight, so the safety net still names what waits behind it', () => {
  const snap = { runId: RUN, tasks: mergeTasks(), integrations: [{ run_id: RUN, state: 'merging', stale: true }], steps: [] };
  assert.deepStrictEqual(untaken(snap), ['t-next'], 'a dead merge carries nothing');
});

test('plan-first: a review whose reviewer stood down never gets an evaluation, so it carries nothing and the work behind it is named', () => {
  const tasks = [
    task({ id: 't-dep', state: 'done', seq: 5, ...evaluated('coder-a') }),
    task({ id: 'r-dep', state: 'released', seq: 6, depends_on: ['t-dep'], policy: null, acceptance: { verdict: true }, handoff: { result: null, by: 'rv', at: 50, stood_down: 'cannot review' }, results: null }),
    task({ id: 't-next', seq: 7, depends_on: ['t-dep'] }),
  ];
  assert.deepStrictEqual(untaken({ runId: RUN, tasks, integrations: [], steps: [] }), ['t-next'], 'stood down: the safety net names it');
  delete tasks[1].handoff.stood_down;
  assert.deepStrictEqual(untaken({ runId: RUN, tasks, integrations: [], steps: [] }), [], 'a real hand-back awaiting its evaluation carries it');
});
