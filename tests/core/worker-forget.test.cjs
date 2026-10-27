'use strict';
// worker-forget.test.cjs — build step 6b, done item 1,
// design item 2. Through the engine (openCore's in-process path): worker.forget is operator only,
// refuses before writing, and supersedes a dead worker's rows as forgotten, never a DELETE.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor, deadPid } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const { WORKER_STATES } = core('schema.cjs');

let dir, orch, worker, operator;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  worker = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'w-caller' }), embed: false });
  operator = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
});

after(async () => {
  await worker.close();
  await operator.close();
  await orch.shutdownOwner(); // the only way to stop an owner; never a signal
  await orch.close();
  cleanup(dir);
});

test("WORKER_STATES ends with 'forgotten'", () => {
  assert.strictEqual(WORKER_STATES[WORKER_STATES.length - 1], 'forgotten');
});

test('worker.forget: operator only — an orchestrator or a worker caller is refused E_ROLE', async () => {
  await orch.worker.write({ id: 'w-role', substrate: 'claude-code', pid: deadPid(), state: 'dead' });
  await assert.rejects(orch.worker.forget({ worker_id: 'w-role' }), (e) => {
    assert.strictEqual(e.code, 'E_ROLE');
    assert.deepStrictEqual(e.detail.allowed, ['operator']);
    return true;
  });
  await assert.rejects(worker.worker.forget({ worker_id: 'w-role' }), (e) => {
    assert.strictEqual(e.code, 'E_ROLE');
    return true;
  });
  const row = await orch.worker.get({ worker_id: 'w-role' });
  assert.strictEqual(row.state, 'dead', 'a refused forget must not have written anything');
});

test('worker.forget: refuses an unknown id, an already-forgotten row, and a live state with a live pid, naming each fact and writing nothing new', async () => {
  await assert.rejects(operator.worker.forget({ worker_id: 'no-such-worker' }), (e) => {
    assert.strictEqual(e.code, 'E_NOT_FOUND');
    return true;
  });

  await orch.worker.write({ id: 'w-live', substrate: 'claude-code', pid: process.pid, state: 'starting' });
  await assert.rejects(operator.worker.forget({ worker_id: 'w-live' }), (e) => {
    assert.strictEqual(e.code, 'E_WORKER_LIVE');
    assert.deepStrictEqual(e.detail, { worker_id: 'w-live', state: 'starting', pid: process.pid, pid_alive: true });
    return true;
  });
  const stillLive = await orch.worker.get({ worker_id: 'w-live' });
  assert.strictEqual(stillLive.state, 'starting', 'a refused forget must not have written the forgotten row');

  await orch.worker.write({ id: 'w-forgotten-twice', substrate: 'claude-code', pid: deadPid(), state: 'dead' });
  const first = await operator.worker.forget({ worker_id: 'w-forgotten-twice' });
  assert.strictEqual(first.row_after.state, 'forgotten');
  await assert.rejects(operator.worker.forget({ worker_id: 'w-forgotten-twice' }), (e) => {
    assert.strictEqual(e.code, 'E_ARGS');
    assert.strictEqual(e.detail.seq, first.row_after.seq);
    return true;
  });
});

test('worker.forget: supersedes the row as forgotten, never a DELETE, and reports what it left behind', async () => {
  const t = await orch.task.create({ spec: 'a task whose lease is left unreleased when its worker is forgotten' });
  await orch.worker.write({ id: 'w-lease', substrate: 'claude-code', pid: process.pid, state: 'starting' });
  const assign = await operator.task.assign({ task_id: t.id, worker_id: 'w-lease' });
  await orch.worker.write({ id: 'w-lease', state: 'dead', pid: deadPid(), keep_leases: true }); // a death that released it would leave nothing to report

  const before2 = await orch.worker.get({ worker_id: 'w-lease' });
  const result = await operator.worker.forget({ worker_id: 'w-lease' });
  assert.strictEqual(result.worker_id, 'w-lease');
  assert.strictEqual(result.row_before.state, 'dead');
  assert.strictEqual(result.row_before.seq, before2.seq);
  assert.strictEqual(result.row_after.state, 'forgotten');
  assert.strictEqual(result.row_after.seq, before2.seq + 1, 'forget must append, never overwrite');
  assert.ok(result.superseded.worker_rows >= 2, 'w-lease had at least two rows (starting, dead) before this append');
  assert.ok(result.left.leases_unreleased.includes(assign.new_lease.id));
  assert.strictEqual(result.left.on_disk, null, 'the core never stats workers/<id>; that is the CLI\'s own job');

  const listed = await orch.worker.list({});
  assert.ok(!listed.workers.some((w) => w.id === 'w-lease'), 'worker.list must hide a forgotten row by default');
  const listedForgotten = await orch.worker.list({ states: ['forgotten'] });
  assert.ok(listedForgotten.workers.some((w) => w.id === 'w-lease'), 'worker.list must show it once forgotten is named');
  const got = await orch.worker.get({ worker_id: 'w-lease' });
  assert.strictEqual(got.state, 'forgotten', 'worker.get must still return the row, whatever its state');
});

test('worker.write: refuses to write state forgotten directly; only worker.forget writes it', async () => {
  await orch.worker.write({ id: 'w-direct', substrate: 'claude-code', pid: deadPid(), state: 'dead' });
  await assert.rejects(orch.worker.write({ id: 'w-direct', state: 'forgotten' }), (e) => {
    assert.strictEqual(e.code, 'E_ARGS');
    assert.match(e.message, /worker\.forget writes it/);
    return true;
  });
  const row = await orch.worker.get({ worker_id: 'w-direct' });
  assert.strictEqual(row.state, 'dead', 'the refused write must not have landed');
});
