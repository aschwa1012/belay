'use strict';
require('../helpers/tmp.cjs');
// policy-review-once.test.cjs -- a review step that finds the core already holds a review for its work (the orchestrator's, written while the step
// waited on worker.list) is finished superseded and assigns nothing. Real core for the race; a fake step view for the runner's two branches.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const { guarded } = require('../core/worktree-helpers.cjs');
const STEPS = require('../../src/run/policy-steps-run.cjs');
const { env, workDone, reviewsOf, REST } = require('./policy-review-env.cjs');

const test = guarded(nodeTest);

test('the orchestrator creates its review while the step waits inside worker.list: one review stands and the step is superseded', async () => {
  const e = await env('review-once-during');
  try {
    const { work } = await workDone(e, { review: { worker: 'rv' }, ...REST });
    await e.worker('rv');
    let mine = null;
    // The step's first snapshot has seen no review. The orchestrator then creates its own inside `unavailable`, before the step's create.
    const seam = { ...e.h, policyAs: (seq) => { const v = e.h.policyAs(seq); return { ...v, worker: { ...v.worker, list: async (a) => { if (!mine) mine = await e.orch.task.create({ spec: 'my review', acceptance: { verdict: true }, depends_on: [work.id] }); return v.worker.list(a); } } }; } };
    const out = await e.exec({}, seam).tick();
    assert.ok(mine, 'the orchestrator\'s create ran inside the step');
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome, s.row_ref]), [['review', 'superseded', `task:${mine.id}`]]);
    assert.strictEqual(reviewsOf(e, work.id).length, 1);
    assert.strictEqual(e.raw("SELECT COUNT(*) AS n FROM lease WHERE acted_by = 'policy'")[0].n, 0, 'the step assigned nothing');
  } finally { await e.close(); }
});

for (const step of ['review', 're_review']) {
  test(`${step}: a create answered existing is not assigned again`, async () => {
    const calls = [];
    const standing = { id: 'RX', existing: true, superseded: true };
    const tasks = [{ id: 'W', state: 'done', spec: 's' }, { id: 'F', state: 'done', spec: 'f' }];
    const core = {
      task: { list: async () => ({ tasks }), create: async (a) => { calls.push(['create', a.depends_on]); return standing; } },
      worker: { list: async () => ({ workers: [{ id: 'rv', state: 'idle', pid_alive: true, substrate: 'claude-code' }] }) },
      run: { get: async () => ({ run: {} }) },
    };
    const assign = async () => { calls.push(['assign']); return {}; };
    const c = step === 'review' ? { step, task_id: 'W', worker: 'rv', review: { worker: 'rv' } } : { step, task_id: 'W', worker: 'rv', fix_id: 'F', review_id: 'R' };
    const out = await STEPS.run(c, { core, assign });
    assert.deepStrictEqual(out, { outcome: 'superseded', row_ref: 'task:RX' });
    assert.deepStrictEqual(calls.map((x) => x[0]), ['create'], 'no assign');
  });
}
