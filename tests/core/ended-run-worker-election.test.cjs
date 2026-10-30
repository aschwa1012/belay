'use strict';
// ended-run-worker-election.test.cjs — audit D42, the election half: a worker-role process never wins the store owner election, so
// it cannot become a stray owner over a run that has ended. With the run ended and no owner serving, a worker's write is refused
// E_NO_OWNER, and the data directory is exactly as it was (no lock taken, no file created, no row written).

const { test } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor, listDataDir } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

test('a worker over an ended run with no owner elects nothing and writes nothing', async () => {
  const dir = sandbox();
  try {
    const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    await orch.run.attach({ adapter_pid: process.pid });
    await orch.worker.write({ id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
    await orch.run.end({ exit_reason: 'test' });
    await orch.shutdownOwner();
    await orch.close();

    const before = listDataDir(dir);
    const worker = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'w1' }), embed: false });
    try {
      await assert.rejects(worker.memory.store({ text: 'late note', embed: false }), (e) => { assert.strictEqual(e.code, 'E_NO_OWNER', e.message); return true; });
      await assert.rejects(worker.becomeOwner(), (e) => { assert.strictEqual(e.code, 'E_ROLE', e.message); return true; });
    } finally { await worker.close(); }
    assert.deepStrictEqual(listDataDir(dir), before, 'the worker left the data directory as it found it');
  } finally { cleanup(dir); }
});

test('a worker-role Client that is allowed to elect is refused the ownership of an ended run', async () => {
  const dir = sandbox();
  try {
    const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    await orch.run.attach({ adapter_pid: process.pid });
    await orch.run.end({ exit_reason: 'test' });
    await orch.shutdownOwner();
    await orch.close();

    const { Client } = core('client.cjs');
    const c = new Client(dir, { caller: callerFor('worker', { worker_id: 'w1' }), elect: true, ownerOpts: { embed: false }, connectRetries: 1 });
    try {
      await assert.rejects(c.connect(), (e) => { assert.strictEqual(e.code, 'E_SHUTDOWN', e.message); assert.match(e.message, /has already ended/); return true; });
      assert.strictEqual(c.becameOwner, false);
    } finally { try { if (c.owner) await c.owner.stop(); } catch { /* none */ } }
  } finally { cleanup(dir); }
});
