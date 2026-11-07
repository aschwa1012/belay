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

test('done does not wait on a null review or integrate', () => {
  const plan = PP.resolve({ review: null, integrate: null }, SHIPPED_PLAN);
  const d = doneOf({ runId: RUN, tasks: [doneWork('A', plan)], integrations: [], steps: [] });
  assert.ok(d, 'done: nothing belay owes on the task');
  assert.match(d.text, /the plan merges nothing/);
  const withReview = doneOf({ runId: RUN, tasks: [doneWork('A', PP.resolve({ integrate: null }, SHIPPED_PLAN))], integrations: [], steps: [] });
  assert.strictEqual(withReview, null, 'a shipped review is still owed');
});

test('a hand-back\'s stall wake does not name an open task whose build is null', () => {
  const dep = doneWork('D', PP.resolve({ integrate: null }, SHIPPED_PLAN), { review: { review_id: 'x', state: 'holds' } });
  const mine = work('M', PP.resolve({ build: null }, SHIPPED_PLAN), { depends_on: ['D'] });
  const other = work('O', { review: SHIPPED_PLAN.review }, { depends_on: ['D'] }); // a plan with no build: still named
  const ids = untaken({ runId: RUN, tasks: [dep, mine, other], integrations: [], steps: [] });
  assert.ok(!ids.includes('M'), 'null build: the orchestrator\'s own');
  assert.ok(ids.includes('O'), 'a build left out of the plan is still named');
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
