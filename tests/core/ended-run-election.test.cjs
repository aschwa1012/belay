'use strict';
// ended-run-election.test.cjs — a late orchestrator-role process over an ended run is refused before anything is started
// (audit L19). The refusal used to follow the election: the process took the lock, wrote a heartbeat and opened a pipe, and
// only then stopped itself.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const { Owner } = core('owner.cjs');

async function endedStore() {
  const dir = sandbox();
  const op = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
  await op.run.attach({ adapter_pid: process.pid });
  await op.run.end({ exit_reason: 'test' });
  await op.shutdownOwner();
  await op.close();
  assert.ok(!fs.existsSync(`${dir}/owner.lock`), 'the owner is gone');
  return dir;
}

function spyStarts() {
  const orig = Owner.prototype.start;
  const spy = { starts: 0, restore() { Owner.prototype.start = orig; } };
  Owner.prototype.start = function (...a) { spy.starts += 1; return orig.apply(this, a); };
  return spy;
}

test('an orchestrator over an ended run is refused E_SHUTDOWN without an owner ever starting', async () => {
  const dir = await endedStore();
  const spy = spyStarts();
  const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  try {
    await assert.rejects(orch.run.attach({ adapter_pid: process.pid }), (e) => e.code === 'E_SHUTDOWN' && /already ended/.test(e.message));
    assert.strictEqual(spy.starts, 0, 'no owner was started to be stopped again');
    assert.ok(!fs.existsSync(`${dir}/owner.lock`), 'and no lock was taken');
  } finally { spy.restore(); if (orch.isOwner()) await orch.shutdownOwner(); await orch.close(); cleanup(dir); }
});

test('the operator (the run process) and an orchestrator over a live run still elect', async (tcx) => {
  const dir = sandbox();
  const spy = spyStarts();
  const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  tcx.after(() => Promise.resolve().then(() => orch.shutdownOwner()).catch(() => {}));
  tcx.after(() => Promise.resolve().then(() => orch.close()).catch(() => {}));
  let orchOpen = true;
  try {
    await orch.run.attach({ adapter_pid: process.pid });
    assert.strictEqual(spy.starts, 1, 'a live run elects as before');
    await orch.shutdownOwner();
    await orch.close(); orchOpen = false;
    const late = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false }); // an existing store, a run still open
    try {
      await late.run.attach({ adapter_pid: process.pid });
      assert.strictEqual(spy.starts, 2, 'an orchestrator over an existing store and a live run elects');
    } finally { if (late.isOwner()) await late.shutdownOwner(); await late.close(); }
    const op = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    try {
      await op.run.end({ exit_reason: 'test' });
      await op.shutdownOwner();
    } finally { await op.close(); }
    const again = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    try {
      assert.strictEqual((await again.run.attach({ adapter_pid: process.pid })).epoch, 3, 'a re-run by the operator over the ended run elects');
    } finally { if (again.isOwner()) await again.shutdownOwner(); await again.close(); }
  } finally {
    spy.restore();
    if (orchOpen) { try { if (orch.isOwner()) await orch.shutdownOwner(); await orch.close(); } catch { /* best effort */ } }
    cleanup(dir);
  }
});
