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
    const { work } = await workDone(e, { review: { worker: 'rv' } }, { label: 'a' });
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

test('a task whose tree cannot be made (the run records no project directory) writes nothing and is an exception that halts it (E8), loudly', async () => {
  const e = await env('build-no-tree');
  try {
    const t = await e.orch.task.create({ spec: 'no tree', acceptance: PASS, policy: { build: { spawn: { agent_type: 'coder' } } } });
    const m = e.manager();
    await wired(e, m).tick();
    const [step] = stepRows(e);
    assert.deepStrictEqual([step.step, step.outcome], ['build', 'exception']);
    assert.match(step.error, /no belay worktree/);
    assert.strictEqual(e.raw('SELECT COUNT(*) AS n FROM lease WHERE task_id = ?', t.id)[0].n, 0, 'nothing assigned');
    const tasks = (await e.h.task.list({})).tasks;
    const ex = PW.derive({ runId: RUN, tasks, integrations: [], steps: (await e.h.policy.list({})).rows, failures: [] });
    assert.ok(ex.some((x) => x.exception === 'E8' && x.task_id === t.id), 'an E8 wake names it');
    assert.ok(PW.haltedIds(ex, tasks).has(t.id), 'and the task is halted until the orchestrator acts');
  } finally { await e.close(); }
});

test('a dependent task waits until its dependencies are merged, and its tree is then cut from the run branch', async () => {
  const { due } = require('../../src/run/policy-exec.cjs');
  const STEPS = require('../../src/run/policy-steps-run.cjs');
  const plan = { build: { spawn: { agent_type: 'coder' } }, review: { worker: 'rv' }, integrate: 'on_hold' };
  const dep = { id: 'A', run_id: RUN, state: 'done', policy: plan, policy_rev: 1, depends_on: [], lease: null, acceptance: { commands: [] }, integration: null };
  const t = { id: 'B', seq: 3, run_id: RUN, state: 'open', policy: plan, policy_rev: 1, depends_on: ['A'], lease: null, acceptance: { commands: [] } };
  assert.deepStrictEqual(due({ runId: RUN, tasks: [dep, t] }).filter((c) => c.step === 'build'), [], 'A is done but not merged: B waits');
  const [c] = due({ runId: RUN, tasks: [{ ...dep, integration: { state: 'merged' } }, t] }).filter((x) => x.step === 'build');
  assert.strictEqual(c.from_run, true);
  const calls = [];
  const env = {
    runId: RUN,
    core: {
      task: { get: async () => ({ ...t, ...(calls.length ? { worktree: { path: 'C:/wt/B' }, lease: { id: 'L1', holder: 'bld-1' } } : {}) }), worktreeCreate: async (a) => { calls.push(a); return { worktree: { path: 'C:/wt/B' } }; } },
      run: { get: async () => ({ run: { paused_at: null } }) },
    },
    spawn: async (a) => { calls.push({ spawn: a }); return { id: 'bld-1' }; },
  };
  const res = await STEPS.run({ ...c, worker: 'bld-1' }, env);
  assert.deepStrictEqual(calls[0], { task_id: 'B', base: `belay/integrate/${RUN}` }, 'the tree is cut from the run branch, with A in it');
  assert.strictEqual(calls[1].spawn.worktree, 'C:/wt/B');
  assert.deepStrictEqual([res.outcome, res.row_ref], ['done', 'lease:L1']);
});

test('six ready tasks and a cap of four: four builds now, two carried as capped (not untaken), built as slots free', async () => {
  const { due, MAX_PARALLEL_BUILDS } = require('../../src/run/policy-exec.cjs');
  assert.strictEqual(MAX_PARALLEL_BUILDS, 4);
  const plan = { build: { worker: 'b' } };
  const open = (i, over = {}) => ({ id: `T${i}`, seq: i, run_id: RUN, state: 'open', policy: plan, policy_rev: 1, depends_on: [], lease: null, acceptance: { commands: [] }, ...over });
  const six = [1, 2, 3, 4, 5, 6].map((i) => open(i));
  const first = due({ runId: RUN, tasks: six, maxBuilds: 4 }).filter((c) => c.step === 'build');
  assert.deepStrictEqual(first.map((c) => [c.task_id, !!c.capped]), [['T1', false], ['T2', false], ['T3', false], ['T4', false], ['T5', true], ['T6', true]]);
  // Four are building (leased): the two still wait, listed as capped, so a stall check sees them carried by the plan.
  const building = six.map((x, i) => (i < 4 ? { ...x, state: 'assigned', lease: { id: `L${i}`, holder: `b${i}` } } : x));
  assert.deepStrictEqual(due({ runId: RUN, tasks: building, maxBuilds: 4 }).filter((c) => c.step === 'build').map((c) => [c.task_id, !!c.capped]), [['T5', true], ['T6', true]]);
  // One finishes: a slot frees and T5 goes.
  const oneDone = building.map((x, i) => (i === 0 ? { ...x, state: 'done', lease: null } : x));
  assert.deepStrictEqual(due({ runId: RUN, tasks: oneDone, maxBuilds: 4 }).filter((c) => c.step === 'build').map((c) => [c.task_id, !!c.capped]), [['T5', false], ['T6', true]]);
});

test('the executor takes only the uncapped builds: six ready, cap four, four claims, no exception and no wake', async () => {
  const e = await env('build-cap', { max_parallel_builds: 4 });
  try {
    for (let i = 0; i < 6; i++) await e.orch.task.create({ spec: `t${i}`, acceptance: PASS, policy: { build: { worker: `b${i}` } } });
    for (let i = 0; i < 6; i++) await e.worker(`b${i}`);
    await e.exec().tick();
    assert.deepStrictEqual(stepRows(e).map((s) => [s.step, s.outcome]), [['build', 'done'], ['build', 'done'], ['build', 'done'], ['build', 'done']]);
    assert.strictEqual(e.raw("SELECT COUNT(*) AS n FROM policy_step WHERE outcome = 'exception'")[0].n, 0, 'a capped task is not an exception');
    const tasks = (await e.h.task.list({})).tasks;
    assert.deepStrictEqual(PW.derive({ runId: RUN, tasks, integrations: [], steps: (await e.h.policy.list({})).rows, failures: [] }), [], 'and no wake');
  } finally { await e.close(); }
});

test('a builder that dies leaves its task to the orchestrator: belay does not build it again', async () => {
  const { due } = require('../../src/run/policy-exec.cjs');
  const t = { id: 'T', seq: 9, run_id: RUN, state: 'open', policy: { build: { worker: 'b' } }, policy_rev: 1, depends_on: [], lease: null, acceptance: { commands: [] } };
  assert.strictEqual(due({ runId: RUN, tasks: [t] }).filter((c) => c.step === 'build').length, 1);
  const steps = [{ run_id: RUN, seq: 1, step: 'build', task_id: 'T', outcome: 'done' }];
  assert.deepStrictEqual(due({ runId: RUN, tasks: [t], steps }).filter((c) => c.step === 'build'), [], 'built once: the death wake asks the orchestrator, belay does not respawn');
});

test('a coder belay spawned is stopped (the manager\'s graceful stop) once its work needs it no more; a named worker is never stopped', async () => {
  const e = await env('build-retire');
  try {
    const repo = makeRepo(e.dir);
    const t = await e.orch.task.create({ spec: 'write r.txt', acceptance: PASS, policy: { build: { spawn: { agent_type: 'coder' } }, review: { worker: 'rv' } } });
    const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo })).worktree.path;
    await e.worker('rv', wt);
    const stopped = [];
    // The spawn path stands in for the run manager's: a worker row, then the assignment under the step's claim.
    const spawnFor = (stepCore) => async (a) => { await e.worker(a.worker_id, a.worktree); await stepCore.task.assign({ task_id: a.task_id, worker_id: a.worker_id }); return { id: a.worker_id }; };
    const x = e.exec({ spawnFor, stopWorker: async (id) => { stopped.push(id); } });
    await x.tick();
    const [build] = stepRows(e);
    assert.deepStrictEqual([build.step, build.outcome], ['build', 'done']);
    const coder = build.worker_id;
    const lease = e.raw('SELECT id FROM lease WHERE task_id = ? ORDER BY seq DESC LIMIT 1', t.id)[0];
    await (await e.worker(coder)).lease.release({ lease_id: lease.id, reason: 'done', result: { branch: 'b', head: 'h' } });
    assert.strictEqual((await e.h.task.evaluate({ task_id: t.id, trigger: 'release' })).state, 'done');
    await x.tick(); // the review goes to rv
    assert.deepStrictEqual(stopped, [], 'the builder stays while a review (and so a fix) may still need it');
    const rl = e.raw("SELECT l.id, l.task_id FROM lease l JOIN task t ON t.id = l.task_id WHERE l.holder = 'rv' ORDER BY l.seq DESC LIMIT 1")[0];
    await (await e.worker('rv')).lease.release({ lease_id: rl.id, reason: 'done', result: { verdict: 'holds', summary: 'ok', findings: [] } });
    await e.h.task.evaluate({ task_id: rl.task_id, worktree: wt, trigger: 'release' });
    await x.tick();
    assert.deepStrictEqual(stopped, [coder], 'the plan merges nothing and the review holds: the coder is stopped, once; rv was named, so it stays');
    await x.tick();
    assert.deepStrictEqual(stopped, [coder]);
  } finally { await e.close(); }
});

test('a task with no tree gets one at its build, made by the real core in the run\'s repository, and the coder is spawned in it', async () => {
  const e = await env('build-auto-tree');
  try {
    const repo = makeRepo(e.dir);
    await e.orch.run.attach({ adapter_pid: process.pid, project_dir: repo }); // the run's repository, as belay run records it
    const t = await e.orch.task.create({ spec: 'write t.txt', acceptance: PASS, policy: { build: { spawn: { agent_type: 'coder' } } } });
    assert.ok(!(await e.h.task.get({ task_id: t.id })).worktree, 'created with no tree');
    const spawned = [];
    const spawnFor = (stepCore) => async (args) => { spawned.push(args); await e.worker(args.worker_id, args.worktree); await stepCore.task.assign({ task_id: args.task_id, worker_id: args.worker_id }); return { id: args.worker_id }; };
    await e.exec({ spawnFor }).tick();
    const [step] = stepRows(e);
    assert.deepStrictEqual([step.step, step.outcome], ['build', 'done'], step.error || '');
    const row = await e.h.task.get({ task_id: t.id });
    assert.ok(row.worktree && row.worktree.path, 'the build made the task its tree');
    assert.strictEqual(row.worktree.branch, `belay/${t.id}`);
    assert.strictEqual(spawned[0].worktree, row.worktree.path, 'and spawned the coder in it');
    assert.ok(require('node:fs').existsSync(row.worktree.path), 'a real tree on disk');
  } finally { await e.close(); }
});
