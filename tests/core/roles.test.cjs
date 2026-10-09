'use strict';
// roles.test.cjs — build step 6a, done item 3. The sibling
// of diff.test.cjs: through the engine (via openCore, both the in-process and the pipe path), an
// operator caller may task.assign and a worker caller may not, and lease.takeControl is still
// operator-only (api.md §3, src/core/engine.cjs METHODS).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor, deadPid } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, worker, operator;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  await orch.worker.write({ id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running' });
  worker = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'w1' }), embed: false });
  operator = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
});

after(async () => {
  await worker.close();
  await operator.close();
  await orch.shutdownOwner(); // the only way to stop an owner; never a signal
  await orch.close();
  cleanup(dir);
});

const rejectsRole = async (p, allowed) => {
  await assert.rejects(p, (e) => {
    assert.strictEqual(e.code, 'E_ROLE', `expected E_ROLE, got ${e.code}: ${e.message}`);
    assert.deepStrictEqual([...e.detail.allowed].sort(), [...allowed].sort());
    return true;
  });
};

test('task.assign: an operator caller may assign an open task; a worker caller may not', async () => {
  const t1 = await orch.task.create({ spec: 'assigned by the operator' });
  const r = await operator.task.assign({ task_id: t1.id, worker_id: 'w1' });
  assert.strictEqual(r.task.state, 'assigned');
  assert.strictEqual(r.new_lease.holder, 'w1');
  assert.strictEqual(r.new_lease.holder_role, 'worker');
  assert.strictEqual((await orch.task.get({ task_id: t1.id })).written_by, 'operator');

  const t2 = await orch.task.create({ spec: 'a worker caller may never assign' });
  await rejectsRole(worker.task.assign({ task_id: t2.id, worker_id: 'w1' }), ['orchestrator', 'operator']);
  // Refused before any write: the task named in the refusal is still open.
  assert.strictEqual((await orch.task.get({ task_id: t2.id })).state, 'open');
});

test('task.assign: the orchestrator caller may still assign, unchanged', async () => {
  const t = await orch.task.create({ spec: 'assigned by the orchestrator, as before this step' });
  const r = await orch.task.assign({ task_id: t.id, worker_id: 'w1' });
  assert.strictEqual(r.task.state, 'assigned');
});

test('lease.takeControl: still operator-only — an orchestrator or a worker caller is refused E_ROLE', async () => {
  const t = await orch.task.create({ spec: 'take-control is operator-only' });
  await operator.task.assign({ task_id: t.id, worker_id: 'w1' });

  await rejectsRole(orch.lease.takeControl({ task_id: t.id }), ['operator']);
  await rejectsRole(worker.lease.takeControl({ task_id: t.id }), ['operator']);

  const took = await operator.lease.takeControl({ task_id: t.id });
  assert.strictEqual(took.new_lease.holder_role, 'operator');
  assert.strictEqual((await orch.task.get({ task_id: t.id })).lease.holder_role, 'operator');
});

test('a live pid is not required for the role check itself: the refusal names the role table, not liveness', async () => {
  // task.assign's own worker-liveness refusal (E_WORKER_NOT_LIVE) is a different gate than the role
  // check (E_ROLE); this asserts the two are not confused by exercising the role gate against a task
  // whose worker argument does not even exist yet.
  const t = await orch.task.create({ spec: 'role gate fires before task.assign looks at the worker at all' });
  await rejectsRole(worker.task.assign({ task_id: t.id, worker_id: deadPid().toString() }), ['orchestrator', 'operator']);
});

test('task.assign and lease.takeControl stamp the lease with the task\'s run_id, not the caller\'s; a live-state worker row over a dead pid is refused E_WORKER_NOT_LIVE naming pid_alive false', async () => {
  const dir2 = sandbox();
  let orch2 = null, operator2 = null;
  try {
    orch2 = await openCore({ dataDir: dir2, caller: callerFor('orchestrator', { run_id: 'run-a' }), embed: false });
    await orch2.run.attach({ adapter_pid: process.pid });
    await orch2.worker.write({ id: 'w2', substrate: 'claude-code', pid: process.pid, state: 'running' });
    const t = await orch2.task.create({ spec: 'created under run-a' });

    // A caller whose own run_id differs from the task's: neither write may stamp the lease with its own.
    operator2 = await openCore({ dataDir: dir2, caller: callerFor('operator', { run_id: 'run-b' }), embed: false });
    const assigned = await operator2.task.assign({ task_id: t.id, worker_id: 'w2' });
    assert.strictEqual(assigned.new_lease.run_id, 'run-a', 'task.assign must stamp the task\'s run_id, not the caller\'s');

    const took = await operator2.lease.takeControl({ task_id: t.id });
    assert.strictEqual(took.new_lease.run_id, 'run-a', 'lease.takeControl must stamp the task\'s run_id, not the caller\'s');

    // A live-claiming state word over a dead pid: refused, naming pid_alive false, never assignable
    // just because LIVE_WORKER_STATES has the word.
    const t2 = await orch2.task.create({ spec: 'assigned to a live-state row over a dead pid' });
    await orch2.worker.write({ id: 'w-ghost', substrate: 'claude-code', pid: deadPid(), state: 'starting' });
    await assert.rejects(operator2.task.assign({ task_id: t2.id, worker_id: 'w-ghost' }), (e) => {
      assert.strictEqual(e.code, 'E_WORKER_NOT_LIVE');
      assert.strictEqual(e.detail.pid_alive, false);
      assert.strictEqual(e.detail.worker_id, 'w-ghost');
      return true;
    });
  } finally {
    if (operator2) await operator2.close();
    if (orch2) { await orch2.shutdownOwner(); await orch2.close(); }
    cleanup(dir2);
  }
});
