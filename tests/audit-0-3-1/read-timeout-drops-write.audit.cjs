'use strict';
// read-timeout-drops-write.audit.cjs — audit 0.3.1, core finding C5. Not globbed by `npm test` (*.audit.cjs).
// Run: node --test tests/audit-0-3-1/read-timeout-drops-write.audit.cjs
//
// A Core that holds a pipe client (the orchestrator adapter after its first write) sends its reads over that same client with
// the 300 ms read bound (index.cjs:270-277). When a read misses that bound, _dropClient() closes the shared client
// (index.cjs:274), which rejects EVERY call still outstanding on it (client.cjs:264), so an unrelated write in flight (a
// task.evaluate running its commands, a worker_spawn) fails E_OWNER_LOST "may have committed" while the owner goes on and
// commits it. The owner is slowed by fault injection on one method (a stalled call), never by load or a fixed sleep.

const { test } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { openCore } = core('index.cjs');
const { METHODS } = core('engine.cjs');

test('C5: a read that misses its bound does not fail an unrelated write in flight on the same connection', { timeout: 60000 }, async () => {
  const dir = sandbox();
  const owner = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await owner.run.attach({ adapter_pid: process.pid }); // this Core elects and owns in-process
  const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.task.create({ spec: 'warm the client' }); // orch now holds a pipe client to the owner
  const origCreate = METHODS['task.create'].fn, origList = METHODS['task.list'].fn;
  let releaseWrite, releaseRead;
  const writeGate = new Promise((r) => { releaseWrite = r; });
  const readGate = new Promise((r) => { releaseRead = r; });
  let writeCommitted = null;
  METHODS['task.create'].fn = async (E, c, a) => { await writeGate; writeCommitted = await origCreate(E, c, a); return writeCommitted; };
  let stalled = false; // only the owner's first answer stalls; the copy fallback's own engine runs the same table
  METHODS['task.list'].fn = async (E, c, a) => { if (!stalled && E.owner) { stalled = true; await readGate; } return origList(E, c, a); };
  try {
    const write = orch.task.create({ spec: 'slow write' }).then((v) => ({ ok: true, id: v.id }), (e) => ({ ok: false, code: e.code, message: e.message }));
    const read = orch.task.list({}).then((v) => ({ ok: true, n: v.tasks.length, established_by: v.established_by }), (e) => ({ ok: false, code: e.code }));
    const readOutcome = await read; // misses the 300 ms bound, falls back to a copy
    releaseRead();
    releaseWrite();
    const writeOutcome = await write;
    // the owner finishes the write it was given; wait on that fact, not on a clock
    for (let i = 0; i < 200 && !writeCommitted; i++) await new Promise((r) => setImmediate(r));
    console.log(JSON.stringify({ read: readOutcome, write: writeOutcome, owner_committed: writeCommitted && writeCommitted.id }));
    assert.ok(writeOutcome.ok, 'the write is answered by the owner that committed it');
  } finally {
    METHODS['task.create'].fn = origCreate; METHODS['task.list'].fn = origList;
    await orch.close();
    try { await owner.shutdownOwner(); } finally { await owner.close(); cleanup(dir); }
  }
});
