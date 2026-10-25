'use strict';
// turn-row-task.test.cjs — a turn row is written by the run manager as the orchestrator, about a worker. The core fills its
// task_id from the lease rows: the task of the newest lease that worker held (released or not) granted at or before the row's
// created_at, the turn's end. Never from the worker; an explicit task_id wins; only a turn row is filled this way.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, h;
const opened = [];

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  h = orch.harness();
});

after(async () => {
  for (const c of opened) await c.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

async function worker(id) {
  await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, last_event_at: Date.now() });
  const c = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: id }), embed: false });
  opened.push(c);
  return c;
}

const turnRow = (worker_id, n, extra = {}) => h.memory.store({ text: `turn ${n} of ${worker_id}`, type: 'turn', worker_id, turn: n, embed: false, tags: [worker_id, `turn:${n}`], provenance: `worker:${worker_id}`, ...extra });
const tick = () => new Promise((r) => setImmediate(r));
async function clockPast(t) { while (Date.now() <= t) await tick(); } // granted_at and created_at are milliseconds

test('a turn whose worker released its lease inside the turn is still the task\'s; a later lease is the next turn\'s', async () => {
  const w = await worker('tw1');
  const t1 = await orch.task.create({ spec: 'one' });
  const t2 = await orch.task.create({ spec: 'two' });
  const a1 = await orch.task.assign({ task_id: t1.id, worker_id: 'tw1' });
  await w.lease.release({ lease_id: a1.new_lease.id, reason: 'done' });
  const end1 = Date.now();
  await clockPast(end1);
  await orch.task.assign({ task_id: t2.id, worker_id: 'tw1' });
  // Turn 1's row is written after the next lease exists (the write is queued): its end time picks the lease it ran under.
  const r1 = await turnRow('tw1', 1, { created_at: end1 });
  const r2 = await turnRow('tw1', 2);
  assert.deepStrictEqual([r1.worker_id, r1.turn, r1.task_id], ['tw1', 1, t1.id]);
  assert.deepStrictEqual([r2.worker_id, r2.turn, r2.task_id], ['tw1', 2, t2.id]);
});

test('no lease: task_id null; an explicit task_id wins; a row of another type is not filled', async () => {
  await worker('tw2');
  assert.strictEqual((await turnRow('tw2', 1)).task_id, null, 'a worker that held no lease');
  const t = await orch.task.create({ spec: 'three' });
  await orch.task.assign({ task_id: t.id, worker_id: 'tw2' });
  assert.strictEqual((await turnRow('tw2', 2, { task_id: 'named' })).task_id, 'named', 'the harness named the task');
  const other = await h.memory.store({ text: 'not a turn', type: 'summary-x', worker_id: 'tw2', embed: false });
  assert.strictEqual(other.task_id, null, 'only a turn row is filled from the lease');
  assert.strictEqual((await turnRow('tw2', 3)).task_id, t.id);
});

test('a lease of the same worker id in another run is not this run\'s turn task', async () => {
  const rows = require('../../src/core/rows.cjs');
  await worker('tw3');
  const t = await orch.task.create({ spec: 'this run' });
  await orch.task.assign({ task_id: t.id, worker_id: 'tw3' });
  await clockPast(Date.now());
  const at = Date.now();
  rows.append(orch.owner.store, 'lease', { id: rows.newId(), task_id: 'other-run-task', run_id: 'other-run', holder: 'tw3', holder_role: 'worker', granted_at: at, expires_at: at + 60000, ttl_ms: 60000, released_at: null, supersedes: null }, 'test', at);
  await clockPast(at);
  assert.strictEqual((await turnRow('tw3', 1)).task_id, t.id, 'the newer lease is another run\'s');
});
