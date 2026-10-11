'use strict';
// handoff-memory-ids.test.cjs — ADR 0040 decision 6. A worker cites memory as `memory_ids` in its
// lease.release result; the release records which cited ids have no row as `handoff.memory_ids_missing`
// and never refuses for it. Real core against a sandbox store, as handoff-verdict.test.cjs does.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, w, memId, seq = 0;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  await orch.worker.write({ id: 'w-cite', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-cite', last_event_at: Date.now() });
  w = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'w-cite' }), embed: false });
  const m = await orch.memory.store({ namespace: 'cite', text: 'a row a worker will cite', embedding: [1, 0], embedding_model: 'm', dim: 2 });
  memId = m.id;
});

after(async () => {
  await w.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

// A fresh task assigned to the worker, then released with the given result (omitted when undefined).
async function release(result) {
  const t = await orch.task.create({ spec: `cite ${++seq}` });
  const a = await orch.task.assign({ task_id: t.id, worker_id: 'w-cite' });
  const args = { lease_id: a.new_lease.id, reason: 'done' };
  if (result !== undefined) args.result = result;
  return w.lease.release(args);
}

test('a cited id with no row is recorded as missing and the release still succeeds', async () => {
  const row = await release({ summary: 's', memory_ids: [memId, 'no-such-row'] });
  assert.strictEqual(row.state, 'released');
  assert.deepStrictEqual(row.handoff.memory_ids_missing, ['no-such-row']);
  assert.deepStrictEqual(row.handoff.result.memory_ids, [memId, 'no-such-row'], 'the worker\'s own result is untouched');
});

test('all cited ids present records an empty missing list', async () => {
  const row = await release({ memory_ids: [memId] });
  assert.deepStrictEqual(row.handoff.memory_ids_missing, []);
});

test('no memory_ids means no field', async () => {
  const row = await release({ summary: 'nothing cited' });
  assert.strictEqual(row.state, 'released');
  assert.ok(!('memory_ids_missing' in row.handoff));
  const bare = await release(undefined);
  assert.strictEqual(bare.handoff, null, 'a release without a result writes no handoff');
});

test('malformed citations are recorded, never refused', async () => {
  const mixed = await release({ memory_ids: [7, '', memId, 7] });
  assert.deepStrictEqual(mixed.handoff.memory_ids_missing, [7, '']);
  const notArray = await release({ memory_ids: 'abc' });
  assert.deepStrictEqual(notArray.handoff.memory_ids_missing, ['abc']);
});

test('the recorded field is what a later read of the task sees', async () => {
  const row = await release({ memory_ids: ['ghost'] });
  const got = await orch.task.get({ task_id: row.id });
  assert.deepStrictEqual(got.handoff.memory_ids_missing, ['ghost']);
});
