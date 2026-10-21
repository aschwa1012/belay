'use strict';
// release-twice.test.cjs — with notes off, a released lease is released once (audit D44). A second call used to append a
// second released row and replace the hand-back the first one wrote.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, worker;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  await orch.worker.write({ id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
  worker = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'w1' }), embed: false });
});

after(async () => {
  await worker.close();
  await orch.shutdownOwner();
  await orch.close();
  cleanup(dir);
});

const refused = (p) => assert.rejects(p, (e) => { assert.strictEqual(e.code, 'E_ARGS', e.message); assert.match(e.message, /already released/); return true; });

test('a second release is refused and the first hand-back stands', async () => {
  const t = await orch.task.create({ spec: 'release me twice' });
  const { new_lease: lease } = await orch.task.assign({ task_id: t.id, worker_id: 'w1' });
  const first = await worker.lease.release({ lease_id: lease.id, result: { answer: 'first' } });
  assert.strictEqual(first.state, 'released');
  const before = await orch.task.get({ task_id: t.id });
  await refused(worker.lease.release({ lease_id: lease.id, result: { answer: 'second' } }));
  await refused(worker.lease.release({ lease_id: lease.id }));
  const after = await orch.task.get({ task_id: t.id });
  assert.strictEqual(after.seq, before.seq, 'a refused release wrote no task row');
  assert.deepStrictEqual(after.handoff.result, { answer: 'first' }, 'the hand-back was not replaced');
});

test('the operator\'s release of a released lease is refused the same way', async () => {
  const op = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
  try {
    const t = await orch.task.create({ spec: 'operator twice' });
    const { new_lease: lease } = await orch.task.assign({ task_id: t.id, worker_id: 'w1' });
    await op.lease.release({ lease_id: lease.id });
    await refused(op.lease.release({ lease_id: lease.id }));
  } finally { await op.close(); }
});
