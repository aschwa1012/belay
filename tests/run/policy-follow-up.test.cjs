'use strict';
require('../helpers/tmp.cjs');
// policy-follow-up.test.cjs — ADR 0074 amendment 4, phase B (B1): under a plan with follow_up: 'plan', a review that holds with should-fix
// findings makes a follow-up (ADR 0064: its own tree, counted against max_follow_ups, never a fix round) that the plan builds, and wakes nobody
// (no E7). Past max_follow_ups nothing is due and nothing wakes: the work integrates on its hold, and the done wake names the findings left.
// The REAL core; the review is handed back and evaluated as the run manager does.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { guarded, git } = require('../core/worktree-helpers.cjs');
const PW = require('../../src/run/policy-wakes.cjs');
const { due } = require('../../src/run/policy-exec.cjs');
const { doneOf } = require('../../src/run/done-wake.cjs');
const { env, workDone, stepRows, RUN, REST } = require('./policy-review-env.cjs');

const test = guarded(nodeTest);
const PLAN = { review: { worker: 'rv' }, ...REST, follow_up: 'plan' };
const SHOULD = [{ severity: 'should-fix', clause: 'a', note: 'tests run only in UTC' }];

// A review of `work` by `judge`, handed back with `verdict` and `findings`, evaluated at release in the work's tree.
async function reviewed(e, work, tree, verdict, findings, judge = 'rv') {
  const r = await e.orch.task.create({ spec: `review ${work.id}`, depends_on: [work.id], acceptance: { verdict: true } });
  const w = await e.worker(judge, tree);
  const a = await e.orch.task.assign({ task_id: r.id, worker_id: judge });
  await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { verdict, summary: `${verdict} ${work.id}`, findings } });
  await e.h.task.evaluate({ task_id: r.id, worktree: tree, trigger: 'release' });
  return r;
}
// The follow-up's tree is cut in the run's project repository (ADR 0064): the repo the work's tree belongs to.
async function withProject(e, tree) { const common = git(tree, 'rev-parse', '--path-format=absolute', '--git-common-dir'); await e.orch.run.attach({ adapter_pid: process.pid, project_dir: path.dirname(common).split('\\').join('/') }); }
const exceptions = async (e) => PW.derive({ runId: RUN, tasks: (await e.h.task.list({})).tasks, integrations: [], steps: (await e.h.policy.list({})).rows, failures: [] });

test('a hold with should-fix findings is a follow-up, not a wake, and the build step dispatches it in its own tree', async () => {
  const e = await env('follow-up', { max_follow_ups: 1 });
  try {
    const { work, tree } = await workDone(e, { ...PLAN, build: { spawn: { agent_type: 'coder' } } });
    await withProject(e, tree);
    const r = await reviewed(e, work, tree, 'holds', SHOULD);
    assert.deepStrictEqual((await exceptions(e)).filter((x) => x.exception === 'E7'), [], 'no E7 under follow_up: plan');
    const steps = (await e.exec().tick()).steps;
    const fu = steps.find((s) => s.step === 'follow_up');
    assert.ok(fu && fu.outcome === 'done', JSON.stringify(steps));
    const made = fu.row_ref.replace('task:', '');
    const row = (await e.h.task.get({ task_id: made }));
    assert.strictEqual(row.follows_up.review_id, r.id, 'a follow-up of that review (ADR 0064)');
    assert.ok(!row.repairs, 'not a fix round');
    assert.strictEqual(row.state, 'open', 'made, not assigned: a worker cannot take a task in another tree');
    assert.ok(row.worktree && row.worktree.path && row.worktree.path !== tree, 'in a tree of its own');
    assert.ok(due({ runId: RUN, tasks: (await e.h.task.list({})).tasks, integrations: [] }).some((c) => c.step === 'build' && c.task_id === made), 'the build step is due on it: it takes the work\'s plan');
    assert.deepStrictEqual((await e.exec().tick()).steps.filter((s) => s.step === 'follow_up'), [], 'one follow-up per review');
  } finally { await e.close(); }
});

test('past max_follow_ups nothing is due and nothing wakes; the done wake names the findings left', async () => {
  const e = await env('follow-up-cap', { max_follow_ups: 0 });
  try {
    const { work, tree } = await workDone(e, PLAN);
    await reviewed(e, work, tree, 'holds', SHOULD);
    const tasks = (await e.h.task.list({})).tasks;
    assert.deepStrictEqual(due({ runId: RUN, tasks, integrations: [] }).filter((c) => c.step === 'follow_up'), [], 'the cap leaves none');
    assert.deepStrictEqual((await exceptions(e)).filter((x) => x.exception === 'E7'), [], 'and no E7');
    // The done wake, once the work is merged: the rows as they stand, with the merge the integrate step would make.
    const merged = tasks.map((t) => (t.id === work.id ? { ...t, integration: { state: 'merged' } } : t));
    const d = doneOf({ runId: RUN, tasks: merged, integrations: [{ id: 'i1', seq: 99, run_id: RUN, state: 'merged', passed: true, into_branch: `belay/integrate/${RUN}`, head_sha: 'abcdef0123456789' }], steps: [] });
    assert.ok(d, 'done');
    assert.deepStrictEqual(d.should_fix_left, [work.id]);
    assert.match(d.text, /Should-fix findings left on 1 task \(see its review\)\./);
  } finally { await e.close(); }
});

test('a plan without follow_up keeps E7 as a wake (the decision is the orchestrator\'s)', async () => {
  const e = await env('follow-up-none', { max_follow_ups: 1 });
  try {
    const { work, tree } = await workDone(e, { review: { worker: 'rv' }, ...REST });
    await reviewed(e, work, tree, 'holds', SHOULD);
    assert.strictEqual((await exceptions(e)).filter((x) => x.exception === 'E7').length, 1);
    assert.deepStrictEqual(stepRows(e), []);
  } finally { await e.close(); }
});
