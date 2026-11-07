'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env);
// policy-null-step.test.cjs — ADR 0074 amendment 4 (rc.6): a field of a task's plan set to null means the step is the orchestrator's. The plan keeps
// the null (the shipped default does not fill it), the executor never does that step for the task, the done wake does not wait on it and a
// hand-back's stall wake does not name an open task whose build is null. A field left out still takes the run's plan. A reviewer's escalation is
// filed under the work it judged, so an amend of the work's plan lifts it and the done wake can follow. Pure rows: no store, no process.

const { test } = require('node:test');
const assert = require('node:assert');
const PP = require('../../src/core/policy-plan.cjs');
const PW = require('../../src/run/policy-wakes.cjs');
const { due } = require('../../src/run/policy-exec.cjs');
const { doneOf } = require('../../src/run/done-wake.cjs');
const { untaken } = require('../../src/run/stall-wake.cjs');
const { SHIPPED_PLAN, applyPolicy } = require('../../src/cli/run-policy-levers.cjs');

const RUN = 'r1';
const verdictResults = { trigger: 'release', evaluated_at: 20, executable: true, passed: true, checks: [{ kind: 'verdict', executable: true, passed: true }] };
const work = (id, policy, over = {}) => ({ id, seq: 10, run_id: RUN, state: 'open', policy, policy_rev: 1, depends_on: [], repairs: null, lease: null, acceptance: { commands: [] }, results: null, handoff: null, review: null, integration: null, ...over });
const doneWork = (id, policy, over = {}) => work(id, policy, { state: 'done', handoff: { by: 'orch', at: 10 }, results: { trigger: 'release', evaluated_at: 12, executable: true, passed: true, checks: [] }, ...over });
const stepsOf = (tasks) => due({ runId: RUN, tasks, integrations: [], steps: [] }).map((c) => `${c.step}:${c.task_id}`);

test('a null field is valid for every step, kept as null, and the shipped default does not fill it', () => {
  for (const k of ['build', 'review', 'fix', 're_review', 'integrate', 'follow_up']) {
    assert.deepStrictEqual(PP.check({ [k]: null }), { [k]: null }, k);
    const plan = PP.forCreate({ policy_default: JSON.stringify(SHIPPED_PLAN) }, { policy: { [k]: null } }, work('t', null)).policy;
    assert.strictEqual(plan[k], null, `${k}: stored as null`);
    for (const other of Object.keys(SHIPPED_PLAN)) if (other !== k) assert.deepStrictEqual(plan[other], SHIPPED_PLAN[other], `${other}: a field left out takes the run's plan`);
  }
  const cfg = {};
  assert.deepStrictEqual(applyPolicy(cfg, { policy: { build: null } }), {});
  assert.strictEqual(cfg.policy_default.build, null, 'a spec null beats the shipped plan');
  assert.ok(cfg.policy_default.review, 'and the rest of the shipped plan stays');
});

test('bad values are still refused', () => {
  for (const bad of [{ fix: 'x' }, { review: 'w1' }, { build: [] }, { review: {} }, { bogus: null }, { build: true }]) assert.throws(() => PP.check(bad), (e) => e.code === 'E_ARGS', JSON.stringify(bad));
  assert.throws(() => PP.check({ fix: undefined }), (e) => e.code === 'E_ARGS' && /undefined/.test(e.message));
});

test('null build plus the shipped review: no coder is spawned for the task, and the orchestrator\'s hand-back is reviewed', () => {
  const plan = PP.resolve({ build: null }, SHIPPED_PLAN);
  assert.deepStrictEqual(stepsOf([work('A', plan)]), [], 'an open task with a null build: no build step');
  assert.deepStrictEqual(stepsOf([work('B', SHIPPED_PLAN)]), ['build:B'], 'the same task with the shipped build is built');
  assert.deepStrictEqual(stepsOf([doneWork('A', plan)]), ['review:A'], 'the orchestrator\'s hand-back is reviewed by the shipped review');
});

test('null review: no review step', () => {
  const plan = PP.resolve({ review: null }, SHIPPED_PLAN);
  assert.deepStrictEqual(stepsOf([doneWork('A', plan)]), []);
  assert.deepStrictEqual(stepsOf([doneWork('A', SHIPPED_PLAN)]), ['review:A']);
});

test('a field left out gets the default', () => {
  const plan = PP.resolve({ fix: 'builder' }, SHIPPED_PLAN);
  assert.deepStrictEqual(plan, SHIPPED_PLAN);
  assert.deepStrictEqual(stepsOf([work('A', plan)]), ['build:A']);
});

const plainReview = { id: 'R-A', seq: 11, run_id: RUN, state: 'done', policy: null, depends_on: ['A'], repairs: null, lease: null, acceptance: { verdict: true }, results: verdictResults, handoff: { by: 'rv', at: 10 }, review: null, integration: null };
const snapOf = (tasks) => ({ runId: RUN, tasks, integrations: [], steps: [], failures: [], revisions: [] });

test('a null integrate: done does not wait on a merge. A null review: E1 review halts, so done waits until the orchestrator reviews or amends', () => {
  const noMerge = PP.resolve({ integrate: null }, SHIPPED_PLAN);
  const s1 = snapOf([doneWork('A', noMerge, { review: { review_id: 'R-A', state: 'holds' } }), plainReview]);
  const d = doneOf(s1, PW.derive(s1));
  assert.ok(d, 'done: the plan merges nothing');
  assert.match(d.text, /the plan merges nothing/);
  const noReview = PP.resolve({ review: null, integrate: null }, SHIPPED_PLAN);
  const s2 = snapOf([doneWork('A', noReview)]);
  const ex = PW.derive(s2);
  assert.deepStrictEqual(ex.map((e) => [e.exception, e.field, e.task_id]), [['E1', 'review', 'A']], 'the orchestrator is told its step is due');
  assert.strictEqual(doneOf(s2, ex), null, 'and done waits for it');
  assert.deepStrictEqual(PW.derive(snapOf([doneWork('A', noReview), { ...plainReview, id: 'R-A2' }])).filter((e) => e.exception === 'E1'), [], 'its own review lifts the E1');
});

test('E1 build: a null-build task whose planned dependency merged is told to the orchestrator once; no dependencies, no merge yet, a lease or a shipped build raise nothing', () => {
  const dep = doneWork('D', SHIPPED_PLAN, { review: { review_id: 'x', state: 'holds' }, integration: { state: 'merged' } });
  const mine = work('M', PP.resolve({ build: null }, SHIPPED_PLAN), { depends_on: ['D'] });
  const ex = (tasks) => PW.derive(snapOf(tasks)).filter((e) => e.field === 'build');
  const got = ex([dep, mine]);
  assert.deepStrictEqual(got.map((e) => [e.exception, e.task_id, e.uid]), [['E1', 'M', 'E1:build:M!build']]);
  assert.match(PW.textOf(got[0]), /field build\. The plan has no build step for this\. Halted\.$/);
  assert.deepStrictEqual(ex([dep, { ...mine, depends_on: [] }]), [], 'no dependencies: the orchestrator made it knowing it is its own');
  assert.deepStrictEqual(ex([{ ...dep, integration: null }, mine]), [], 'the dependency is not merged yet');
  assert.deepStrictEqual(ex([dep, { ...mine, lease: { id: 'L', expired: false } }]), [], 'already leased');
  assert.deepStrictEqual(ex([dep, work('P', SHIPPED_PLAN, { depends_on: ['D'] })]), [], 'a shipped build is belay\'s');
});

test('E1 build: a follow-up under a null-build plan is told too, and is not a stall-wake name once halted', () => {
  const plan = PP.resolve({ build: null }, SHIPPED_PLAN);
  const dep = doneWork('D', plan, { review: { review_id: 'x', state: 'holds' }, integration: { state: 'merged' } });
  const fu = work('F', null, { depends_on: ['D'], follows_up: { review_id: 'x' }, acted_by: 'policy', policy_made: true });
  const ex = PW.derive(snapOf([dep, fu])).filter((e) => e.field === 'build');
  assert.deepStrictEqual(ex.map((e) => e.task_id), ['F']);
  assert.ok(!untaken(snapOf([dep, fu])).includes('F'), 'its exception wake has gone: the stall wake does not repeat it');
});

test('partial null: a null build with the shipped fix sends the fix to the orchestrator\'s own coder', () => {
  const plan = PP.resolve({ build: null }, SHIPPED_PLAN);
  const A = doneWork('A', plan, { handoff: { by: 'orch-coder', at: 10 }, review: { state: 'refuted', review_id: 'R-A', rounds_left: 1 } });
  const R = { ...plainReview, state: 'released' };
  const c = due({ runId: RUN, tasks: [A, R], integrations: [], steps: [] }).filter((x) => x.step === 'fix');
  assert.deepStrictEqual(c.map((x) => [x.task_id, x.worker]), [['A', 'orch-coder']]);
});

// A reviewer's escalation (result.escalate on its hand-back) is filed under the work it judged.
const verdictRow = (over = {}) => ({ id: 'R-A', seq: 11, run_id: RUN, state: 'released', policy: null, depends_on: ['A'], repairs: null, lease: null, acceptance: { verdict: true }, results: verdictResults, handoff: { by: 'rv', at: 10, result: { escalate: { kind: 'question', reason: 'which branch?' } } }, review: null, integration: null, ...over });

test('a reviewer\'s escalation is filed under the judged work, and an amend of the work\'s plan lifts it so done can fire', () => {
  const holds = { review_id: 'R-A', state: 'holds' };
  const A = (rev) => doneWork('A', SHIPPED_PLAN, { policy_rev: rev, review: holds, integration: { state: 'merged' } });
  const R = verdictRow({ state: 'done' });
  const integrations = [{ id: 'i1', seq: 20, run_id: RUN, state: 'merged', passed: true, into_branch: `belay/integrate/${RUN}`, head_sha: 'abcdef0123456789' }];
  const revisions = [{ id: 'A', seq: 1, written_at: 5, policy_rev: 1, evaluated_at: null }, { id: 'A', seq: 30, written_at: 50, policy_rev: 2, evaluated_at: null }];
  const snapOf = (rev) => ({ runId: RUN, tasks: [A(rev), R], integrations, steps: [], failures: [], revisions });

  const before = PW.derive(snapOf(1)).filter((e) => e.exception === 'escalation');
  assert.strictEqual(before.length, 1);
  assert.strictEqual(before[0].task_id, 'A', 'filed under the work, not the review');
  assert.strictEqual(before[0].lifted, undefined, 'not lifted yet');
  assert.strictEqual(doneOf(snapOf(1), before), null, 'halted: no done wake');

  const after = PW.derive(snapOf(2)).filter((e) => e.exception === 'escalation');
  assert.strictEqual(after[0].lifted, true, 'the amend lifts it');
  assert.ok(doneOf(snapOf(2), after), 'done can fire once the escalation is lifted');
});

test('a reviewer\'s escalation is lifted by a re-assign of the review, as a work task\'s is', () => {
  const A = doneWork('A', SHIPPED_PLAN, { review: { review_id: 'R-A', state: 'holds' } });
  const re = verdictRow({ state: 'assigned', written_by: 'orchestrator', written_at: 99, acted_by: null });
  const es = PW.derive({ runId: RUN, tasks: [A, re], integrations: [], steps: [], failures: [], revisions: [] }).filter((e) => e.exception === 'escalation');
  assert.strictEqual(es[0].task_id, 'A');
  assert.strictEqual(es[0].lifted, true);
  assert.strictEqual(PW.haltedIds(es, [A, re]).size, 0);
});

test('cancelling the judged work lifts a reviewer\'s escalation, so done is not blocked', () => {
  const A = doneWork('A', SHIPPED_PLAN, { state: 'cancelled', review: null });
  const live = doneWork('B', SHIPPED_PLAN, { review: { review_id: 'R-B', state: 'holds' }, integration: { state: 'merged' } });
  const RB = { ...plainReview, id: 'R-B', depends_on: ['B'] };
  const integrations = [{ id: 'i1', seq: 20, run_id: RUN, state: 'merged', passed: true, into_branch: `belay/integrate/${RUN}`, head_sha: 'abcdef0123456789' }];
  // the judged work is cancelled; its reviewer's escalation (review still released, not yet cancelled) is on the record
  const Rr = verdictRow({ state: 'released' });
  const snap = { runId: RUN, tasks: [A, Rr, live, RB], integrations, steps: [], failures: [], revisions: [] };
  const es = PW.derive(snap).filter((e) => e.exception === 'escalation');
  assert.strictEqual(es.length, 1);
  assert.strictEqual(PW.haltedIds(es, snap.tasks).has('A'), false, 'a cancelled task halts nothing');
  assert.ok(doneOf({ ...snap, tasks: [A, { ...Rr, state: 'cancelled' }, live, RB] }, es), 'done can fire for the rest of the run');
});

test('E1 build: raised only when a dependency landed after the task was made; if every one had landed at creation the orchestrator knew', () => {
  const dep = doneWork('D', SHIPPED_PLAN, { review: { review_id: 'x', state: 'holds' }, integration: { state: 'merged' } });
  const mine = work('M', PP.resolve({ build: null }, SHIPPED_PLAN), { depends_on: ['D'] });
  const merge = (at) => ({ id: 'i1', seq: 20, run_id: RUN, state: 'merged', passed: true, task_ids: ['D'], into_branch: `belay/integrate/${RUN}`, written_at: at });
  const ex = (at, madeAt) => PW.derive({ runId: RUN, tasks: [dep, mine], integrations: [merge(at)], steps: [], failures: [], revisions: [{ id: 'M', seq: 12, written_at: madeAt, policy_rev: 1, evaluated_at: null }] }).filter((e) => e.field === 'build');
  assert.deepStrictEqual(ex(150, 100).map((e) => e.task_id), ['M'], 'the merge came after the task was made: told');
  assert.deepStrictEqual(ex(50, 100), [], 'the dependency had landed when the task was made: nothing');
});

test('E1 build: a tie in time wakes, and a task belay made (a follow-up) always wakes whatever the order', () => {
  const dep = doneWork('D', SHIPPED_PLAN, { review: { review_id: 'x', state: 'holds' }, integration: { state: 'merged' } });
  const plan = PP.resolve({ build: null }, SHIPPED_PLAN);
  const merge = (at) => ({ id: 'i1', seq: 20, run_id: RUN, state: 'merged', passed: true, task_ids: ['D'], into_branch: `belay/integrate/${RUN}`, written_at: at });
  const ex = (task, at, madeAt) => PW.derive({ runId: RUN, tasks: [dep, task], integrations: [merge(at)], steps: [], failures: [], revisions: [{ id: task.id, seq: 12, written_at: madeAt, policy_rev: 1, evaluated_at: null }] }).filter((e) => e.field === 'build');
  assert.strictEqual(ex(work('M', plan, { depends_on: ['D'] }), 100, 100).length, 1, 'a tie fails toward waking');
  const fu = work('F', plan, { depends_on: ['D'], follows_up: { review_id: 'x' }, acted_by: 'policy', policy_made: true });
  assert.strictEqual(ex(fu, 50, 100).length, 1, 'a follow-up belay made wakes even when its dependency landed before its row');
});
