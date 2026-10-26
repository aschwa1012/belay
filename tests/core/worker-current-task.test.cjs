'use strict';
// worker-current-task.test.cjs — a reused worker's current task is derived from its leases on the read side: the worker row's
// task_id is written at spawn only, so status.get and worker.list must follow task.assign, not the row.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, worker;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  worker = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'w-reuse' }), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
});

after(async () => {
  await worker.close();
  await orch.shutdownOwner();
  await orch.close();
  cleanup(dir);
});

test('status.get, worker.list and worker.get show the newest assigned task of a reused worker, not the spawn-time one', async () => {
  const made = [];
  for (const n of ['one', 'two', 'three']) made.push(await orch.task.create({ spec: n }));
  const ids = made.map((t) => t.id);
  await orch.worker.write({ id: 'w-reuse', substrate: 'claude-code', pid: process.pid, state: 'running', task_id: ids[0], turns: 0, started_at: Date.now() });
  const shown = async () => {
    const st = (await orch.status.get({})).workers.find((w) => w.id === 'w-reuse').task_id;
    const li = (await orch.worker.list({})).workers.find((w) => w.id === 'w-reuse').task_id;
    const ge = (await orch.worker.get({ worker_id: 'w-reuse' })).task_id;
    return [st, li, ge];
  };
  assert.deepStrictEqual(await shown(), [ids[0], ids[0], ids[0]], 'no lease yet: the row\'s own task_id');
  const a1 = await orch.task.assign({ task_id: ids[0], worker_id: 'w-reuse' });
  assert.deepStrictEqual(await shown(), [ids[0], ids[0], ids[0]]);
  await worker.lease.release({ lease_id: a1.new_lease.id });
  assert.deepStrictEqual(await shown(), [ids[0], ids[0], ids[0]], 'a released lease is the fallback');
  await orch.task.assign({ task_id: ids[1], worker_id: 'w-reuse' });
  assert.deepStrictEqual(await shown(), [ids[1], ids[1], ids[1]]);
  await orch.task.assign({ task_id: ids[2], worker_id: 'w-reuse' });
  assert.deepStrictEqual(await shown(), [ids[2], ids[2], ids[2]], 'the newest open lease wins over the older open one');
});

test('an unreleased lease past its expiry does not beat a newer lease: w1 shows t2', () => {
  const path = require('node:path');
  const { Store } = core('store.cjs');
  const rows = core('rows.cjs');
  const d = sandbox();
  const s = new Store(path.join(d, 'memory.db'));
  try {
    const lease = (task_id, granted_at, expires_at, released_at) => rows.append(s, 'lease', { id: rows.newId(), task_id, run_id: 'r', holder: 'w1', holder_role: 'worker', granted_at, expires_at, ttl_ms: 1, released_at }, 'test', granted_at);
    lease('t1', 1000, 2000, null); // expired, never released
    assert.strictEqual(rows.workerTasks(s, 'w1', 5000).get('w1'), 't1', 'the only lease is the answer, expired or not');
    lease('t2', 3000, 4000, 3500); // released
    assert.strictEqual(rows.workerTasks(s, 'w1', 5000).get('w1'), 't2');
    assert.strictEqual(rows.workerTasks(s, null, 5000).get('w1'), 't2');
    lease('t3', 4500, 9000, null); // live again
    assert.strictEqual(rows.workerTasks(s, 'w1', 5000).get('w1'), 't3');
  } finally { s.close(); cleanup(d); }
});
