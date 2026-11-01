'use strict';
// run.attach builds the next epoch from the run row as it stands after the adapter-identity snapshot, so a pause
// committed while the snapshot was pending is carried. The snapshot is held on a promise the test resolves.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { deadPid } = require('../helpers/dead-pid.cjs');
const { openCore } = core('index.cjs');
const ID = core('proc-identity.cjs');

let dir, operator, orch;
before(async () => {
  dir = sandbox();
  operator = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
});
after(async () => {
  try { await orch.close(); if (operator.isOwner()) await operator.shutdownOwner(); } finally { await operator.close(); cleanup(dir); }
});

test('a pause committed during the attach snapshot is carried onto the new epoch', { skip: process.platform !== 'win32' }, async () => {
  const other = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  const real = ID.snapshotRetry;
  let release, entered;
  const gate = new Promise((r) => { release = r; });
  const inSnap = new Promise((r) => { entered = r; });
  try {
    await operator.run.attach({ adapter_pid: await deadPid() });
    await orch.run.attach({ adapter_pid: other.pid, orchestrator_pid: 111111 }); // the leftover adapter, no creation time
    ID.snapshotRetry = async (o) => { entered(); await gate; return real(o); };
    const att = operator.run.attach({ adapter_pid: process.pid, orchestrator_pid: 222222 });
    await inSnap; // the attach has read the row and is waiting on the snapshot
    ID.snapshotRetry = real;
    const paused = await orch.run.setPaused({ paused: true, by: 'orchestrator:test' });
    assert.ok(paused.paused_at != null);
    release();
    await att;
    const now = (await operator.run.get()).run;
    assert.strictEqual(now.paused_at, paused.paused_at, 'the new epoch carries the pause');
    assert.strictEqual(now.paused_by, paused.paused_by);
  } finally {
    ID.snapshotRetry = real;
    other.kill();
    try { await operator.run.end({ exit_reason: 'test' }); } catch { /* ended */ }
  }
});

test('an attach whose row was re-attached during the snapshot is refused and writes nothing', { skip: process.platform !== 'win32' }, async () => {
  const other = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  const real = ID.snapshotRetry;
  let release, entered;
  const gate = new Promise((r) => { release = r; });
  const inSnap = new Promise((r) => { entered = r; });
  try {
    await operator.run.attach({ adapter_pid: await deadPid() });
    await orch.run.attach({ adapter_pid: other.pid, orchestrator_pid: 111111 });
    ID.snapshotRetry = async (o) => { entered(); await gate; return real(o); };
    const att = operator.run.attach({ adapter_pid: process.pid, orchestrator_pid: 222222 });
    await inSnap;
    ID.snapshotRetry = real;
    const second = await orch.run.attach({ adapter_pid: other.pid, orchestrator_pid: 333333 }); // another attach commits meanwhile
    release();
    let refusal = null;
    try { await att; } catch (e) { refusal = e; }
    assert.ok(refusal, 'the held attach is refused');
    assert.strictEqual(refusal.code, 'E_BUSY');
    assert.strictEqual(refusal.detail.op, 'attach');
    const now = (await operator.run.get()).run;
    assert.strictEqual(now.epoch, second.epoch,'nothing was written over the other attach');
    assert.strictEqual(Number(now.adapter_pid), other.pid);
  } finally {
    ID.snapshotRetry = real;
    other.kill();
    try { await operator.run.end({ exit_reason: 'test' }); } catch { /* ended */ }
  }
});
