'use strict';
require('../helpers/tmp.cjs');
// policy-build.test.cjs — the build step (ADR 0074 amendment 4, plan-first): an open work task nobody holds, whose dependencies are all done,
// is given to the plan's builder: a named worker, or a coder belay spawns through the run manager's own spawn (the review step's path).
// A task without a belay worktree to spawn in is an exception (E8) that halts it; a task the orchestrator assigned itself is skipped.
// The REAL core and, for the spawn, the REAL run manager over the fake claude executable.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const { guarded, makeRepo } = require('../core/worktree-helpers.cjs');
const PP = require('../../src/core/policy-plan.cjs');
const PW = require('../../src/run/policy-wakes.cjs');
const { taken, env, workDone, stepRows, latest, wired, RUN, REST, PASS } = require('./policy-review-env.cjs');

const test = guarded(nodeTest);

test('the plan takes build as a worker or a spawn, and the tag shows it', () => {
  assert.deepStrictEqual(PP.check({ build: { worker: 'b1' } }), { build: { worker: 'b1' } });
  assert.deepStrictEqual(PP.check({ build: { spawn: { agent_type: 'coder' } } }), { build: { spawn: { agent_type: 'coder' } } });
  assert.throws(() => PP.check({ build: 'coder' }), /policy\.build must be an object/);
  assert.strictEqual(PP.tag({ build: { spawn: { agent_type: 'coder' } }, review: { worker: 'rv' }, fix: 'builder' }), 'b:spawn(coder) r:rv f:builder');
});

test('build to a named worker: an open task with its dependencies done is assigned to that worker under the claim', async () => {
  const e = await env('build-named');
  try {
    const t = await e.orch.task.create({ spec: 'write b.txt', acceptance: PASS, policy: { build: { worker: 'b1' }, ...REST } });
    await e.worker('b1');
    const out = await e.exec().tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.task_id, s.outcome]), [['build', t.id, 'done']]);
    const lease = e.raw('SELECT id, holder, acted_by FROM lease WHERE task_id = ? ORDER BY seq', t.id)[0];
    assert.deepStrictEqual([lease.holder, lease.acted_by], ['b1', 'policy']);
    assert.strictEqual(stepRows(e)[0].row_ref, `lease:${lease.id}`, 'the claim names the lease it wrote');
    assert.deepStrictEqual((await e.exec().tick()).steps, [], 'the next pass finds the task held');
  } finally { await e.close(); }
});

test('a task waits for its dependencies: not built while one is open, built once they are done', async () => {
  const e = await env('build-deps');
  try {
    const { work } = await workDone(e, { review: { worker: 'rv' }, ...REST }, { label: 'a' });
    const open = await e.orch.task.create({ spec: 'still open', acceptance: PASS, policy: null });
    const blocked = await e.orch.task.create({ spec: 'needs both', acceptance: PASS, depends_on: [work.id, open.id], policy: { build: { worker: 'b1' } } });
    const ready = await e.orch.task.create({ spec: 'needs a', acceptance: PASS, depends_on: [work.id], policy: { build: { worker: 'b1' } } });
    await e.worker('b1');
    const steps = (await e.exec().tick()).steps.filter((s) => s.step === 'build');
    assert.deepStrictEqual(steps.map((s) => s.task_id), [ready.id], 'only the task whose dependencies are all done');
    assert.ok(!steps.some((s) => s.task_id === blocked.id));
  } finally { await e.close(); }
});

test('a task the orchestrator assigned itself is skipped by build', async () => {
  const e = await env('build-skip-assigned');
  try {
    const t = await e.orch.task.create({ spec: 'mine', acceptance: PASS, policy: { build: { worker: 'b1' } } });
    await e.worker('w-own');
    await e.orch.task.assign({ task_id: t.id, worker_id: 'w-own' });
    assert.deepStrictEqual((await e.exec().tick()).steps, []);
  } finally { await e.close(); }
});

test('build by spawn: the manager launches a coder in the task\'s belay worktree, and it holds the lease under the claim', async () => {
  const e = await env('build-spawned');
  try {
    const repo = makeRepo(e.dir);
    const t = await e.orch.task.create({ spec: 'write c.txt', acceptance: PASS, policy: { build: { spawn: { agent_type: 'coder' } } } });
    await e.op.task.worktreeCreate({ task_id: t.id, repo });
    const m = e.manager();
    await wired(e, m).tick();
    const out = taken(e);
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['build', 'done']]);
    const [step] = stepRows(e);
    assert.match(step.worker_id, /^bld-[0-9a-f]{8}$/, 'a builder id belay made, recorded on the claim');
    assert.ok(m._worker(step.worker_id), 'the harness launched it');
    assert.strictEqual((await e.orch.worker.get({ worker_id: step.worker_id })).agent_type, 'coder');
    assert.strictEqual(latest(e, 'task', t.id) && e.raw('SELECT holder FROM lease WHERE task_id = ? ORDER BY seq DESC LIMIT 1', t.id)[0].holder, step.worker_id);
  } finally { await e.close(); }
});

test('a spawn with no belay worktree to start in writes nothing and is an exception that halts the task (E8), loudly', async () => {
  const e = await env('build-no-tree');
  try {
    const t = await e.orch.task.create({ spec: 'no tree', acceptance: PASS, policy: { build: { spawn: { agent_type: 'coder' } } } });
    const m = e.manager();
    await wired(e, m).tick();
    const [step] = stepRows(e);
    assert.deepStrictEqual([step.step, step.outcome], ['build', 'exception']);
    assert.match(step.error, /no belay worktree to start a builder in/);
    assert.strictEqual(e.raw('SELECT COUNT(*) AS n FROM lease WHERE task_id = ?', t.id)[0].n, 0, 'nothing assigned');
    const tasks = (await e.h.task.list({})).tasks;
    const ex = PW.derive({ runId: RUN, tasks, integrations: [], steps: (await e.h.policy.list({})).rows, failures: [] });
    assert.ok(ex.some((x) => x.exception === 'E8' && x.task_id === t.id), 'an E8 wake names it');
    assert.ok(PW.haltedIds(ex, tasks).has(t.id), 'and the task is halted until the orchestrator acts');
  } finally { await e.close(); }
});
