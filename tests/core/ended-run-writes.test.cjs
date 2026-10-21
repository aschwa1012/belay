'use strict';
// ended-run-writes.test.cjs — an ended run takes no write from a process launched for it (audit D42). The orchestrator's
// adapter and a worker are refused in engine dispatch, for every write method; the run process (role operator) is not,
// since it closes, scrubs and sweeps the run after run.end. run.attach and run.end keep their own rules.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, worker, operator, task, lease;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  await orch.worker.write({ id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
  worker = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'w1' }), embed: false });
  operator = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
  task = await orch.task.create({ spec: 'work' });
  lease = (await orch.task.assign({ task_id: task.id, worker_id: 'w1' })).new_lease;
});

after(async () => {
  await worker.close();
  await operator.close();
  await orch.shutdownOwner();
  await orch.close();
  cleanup(dir);
});

const ended = (p) => assert.rejects(p, (e) => {
  assert.strictEqual(e.code, 'E_ARGS', e.message);
  assert.match(e.message, /has already ended/);
  return true;
});

test('while the run is live both roles write', async () => {
  assert.strictEqual((await worker.memory.store({ text: 'live note', embed: false })).worker_id, 'w1');
  assert.strictEqual((await orch.task.create({ spec: 'live task' })).state, 'open');
});

test('after run.end the orchestrator and the worker are refused every write, and nothing is written', async () => {
  const tasksBefore = (await operator.task.list({})).tasks.length;
  const memBefore = (await operator.memory.stats({})).n;
  await orch.run.end({ exit_reason: 'test' });
  await ended(orch.task.create({ spec: 'after the end' }));
  await ended(orch.task.assign({ task_id: task.id, worker_id: 'w1' }));
  await ended(orch.continuity.checkpoint({ task_id: task.id, summary: 'late' }));
  await ended(worker.memory.store({ text: 'late note', embed: false }));
  await ended(worker.continuity.checkpoint({ task_id: task.id, summary: 'late' }));
  await ended(worker.lease.release({ lease_id: lease.id, result: { late: true } }));
  assert.strictEqual((await operator.task.list({})).tasks.length, tasksBefore, 'no task row was added');
  assert.strictEqual((await operator.task.get({ task_id: task.id })).state, 'assigned', 'the release did not land');
  assert.strictEqual((await operator.memory.stats({})).n, memBefore, 'no memory row was added');
});

test('the run process (role operator) still writes into the ended run, and a repeated run.end from the orchestrator role is a no-op', async () => {
  const row = await operator.memory.store({ text: 'written by the run process', embed: false });
  assert.strictEqual(row.written_by, 'operator');
  const was = (await operator.run.get({})).run;
  const again = await orch.run.end({ exit_reason: 'again', usage: { orch_cost_usd: 99 } });
  assert.strictEqual(again.already_ended, true);
  assert.strictEqual(again.exit_reason, 'test', 'a second end from the orchestrator role answers with the row as it stands');
  const now = await operator.run.get({});
  assert.strictEqual(now.run.ended_at, was.ended_at, 'ended_at is unchanged');
  assert.strictEqual(now.run.exit_reason, 'test', 'exit_reason is unchanged');
  assert.strictEqual(now.run.seq, was.seq, 'nothing was written');
  const r = await operator.run.attach({ adapter_pid: process.pid }); // a re-run opens the next epoch
  assert.strictEqual(r.reattached, true);
  assert.strictEqual((await orch.task.create({ spec: 'the new epoch is live' })).state, 'open');
});

test('reads are not refused on an ended run', async () => {
  await orch.run.end({ exit_reason: 'over' });
  assert.ok((await worker.task.get({ task_id: task.id })).id === task.id);
  assert.ok(Array.isArray((await orch.task.list({})).tasks));
});
