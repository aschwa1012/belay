'use strict';
require('../helpers/tmp.cjs');
// policy-matrix-e1.test.cjs — package F, E1: the plan has no step for a fact that calls for one. One seeded end-to-end case per plan field
// (review, fix, re_review, integrate), against the real core and the real executor and watcher: the rows are made by hand-backs through the
// workers' own cores, exactly one wake comes, with the key, root task and trigger row the canonical table (api.md) names, and the task is halted.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const { guarded } = require('../core/worktree-helpers.cjs');
const M = require('./policy-matrix-env.cjs');

const test = guarded(nodeTest);

test('E1 review: work done by a release evaluation, nothing depends on it, and the plan has no review', async () => {
  const e = await M.env({ label: 'E1-review' });
  try {
    const { task } = await M.workDone(e, 'r', { plan: { fix: 'builder' } });
    const trig = await M.tref(e, task.id);
    M.expectOne(await e.poll(), { exception: 'E1', field: 'review', task_id: task.id, trigger: trig, key: `${task.id}@${await M.evaluatedAt(e, task.id)}` });
    assert.ok((await M.halted(e)).has(task.id));
    await M.assertOnce(e);
    assert.deepStrictEqual(M.stepsOf(e), [], 'belay took no step');
  } finally { await e.close(); }
});

test('E1 fix: a review refuted the work and the plan has no fix; no fix is made, and amending the plan lifts the halt and the step runs', async () => {
  const e = await M.env({ label: 'E1-fix' });
  try {
    const { task } = await M.workDone(e, 'f', { plan: M.without(M.PLAN, 'fix') });
    const { review } = await M.reviewed(e, task, 'f', 'refuted');
    const trig = await M.tref(e, review.id);
    M.expectOne(await e.poll(), { exception: 'E1', field: 'fix', task_id: task.id, trigger: trig, key: `${review.id}@${await M.evaluatedAt(e, review.id)}` });
    assert.ok((await M.halted(e)).has(task.id));
    await M.assertOnce(e);
    assert.deepStrictEqual(M.fixesOf(e, task.id), [], 'no fix task was made');
    assert.deepStrictEqual(M.stepsOf(e), []);
    // The orchestrator amends the plan to name a fix: the condition clears, nothing halts, the step is taken once.
    await e.orch.task.create({ id: task.id, amend: true, policy: M.PLAN });
    assert.deepStrictEqual(await e.poll(), [], 'the exception is not sent again');
    assert.deepStrictEqual(e.watcher.active(), []);
    const out = await e.tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['fix', 'done']]);
    assert.strictEqual(M.fixesOf(e, task.id).length, 1);
  } finally { await e.close(); }
});

test('E1 re_review: a fix is done by a release evaluation, nothing reviews it, and the plan has no re_review', async () => {
  const e = await M.env({ label: 'E1-re_review' });
  try {
    const { task, builder } = await M.workDone(e, 'rr', { plan: M.without(M.PLAN, 're_review') });
    await M.reviewed(e, task, 'rr', 'refuted');
    const made = await e.tick();
    assert.deepStrictEqual(made.steps.map((s) => [s.step, s.outcome]), [['fix', 'done']], 'the plan has a fix: the step takes it, and that is routine');
    const fix = M.fixesOf(e, task.id)[0].id;
    assert.strictEqual(M.leaseOf(e, fix).holder, builder);
    assert.strictEqual((await M.handBackLeased(e, fix)).state, 'done');
    const trig = await M.tref(e, fix);
    M.expectOne(await e.poll(), { exception: 'E1', field: 're_review', task_id: task.id, trigger: trig, key: `${fix}@${await M.evaluatedAt(e, fix)}` });
    assert.ok((await M.halted(e)).has(task.id));
    await M.assertOnce(e);
    assert.deepStrictEqual(M.stepsOf(e).map((s) => s.step), ['fix'], 'no re_review step');
  } finally { await e.close(); }
});

test('E1 integrate: a review holds, the work is not merged, and the plan has no integrate', async () => {
  const e = await M.env({ label: 'E1-integrate' });
  try {
    const { task } = await M.workDone(e, 'i', { plan: M.without(M.PLAN, 'integrate') });
    const { review } = await M.reviewed(e, task, 'i', 'holds');
    const trig = await M.tref(e, review.id);
    M.expectOne(await e.poll(), { exception: 'E1', field: 'integrate', task_id: task.id, trigger: trig, key: `${review.id}@${await M.evaluatedAt(e, review.id)}` });
    assert.ok((await M.halted(e)).has(task.id));
    await M.assertOnce(e);
    assert.deepStrictEqual(M.stepsOf(e), []);
    assert.strictEqual(e.raw('SELECT COUNT(*) AS n FROM integration')[0].n, 0, 'nothing was merged');
  } finally { await e.close(); }
});
