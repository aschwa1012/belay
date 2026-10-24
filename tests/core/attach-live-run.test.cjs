'use strict';
// A second `belay run` on a run id whose first life still answers is refused with nothing written; a lapsed run
// (its adapter pid gone) still reattaches, and the run's own orchestrator adapter attaches over the live run as before.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, operator, orch;

before(async () => {
  dir = sandbox();
  operator = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
});

after(async () => {
  try { await orch.close(); if (operator.isOwner()) await operator.shutdownOwner(); } finally { await operator.close(); cleanup(dir); }
});

function deadPid() {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
    c.once('error', reject);
    c.once('exit', () => resolve(c.pid));
  });
}

test('run.attach: an operator attach over a run whose adapter pid is alive, with no recorded creation time, is refused with E_RUN_LIVE naming the pid, and writes no row', async () => {
  await operator.run.attach({ adapter_pid: process.ppid });
  const before = (await operator.run.get()).epochs.length;
  await assert.rejects(() => operator.run.attach({ adapter_pid: process.pid }), (e) => e.code === 'E_RUN_LIVE' && /may be held by a running adapter/.test(e.message) && /another run id/.test(e.message) && e.detail.adapter_pid === process.ppid && e.detail.adapter_state === 'unverifiable');
  const now = await operator.run.get();
  assert.strictEqual(now.epochs.length, before, 'no row was appended');
  assert.strictEqual(Number(now.run.adapter_pid), process.ppid, 'the first life still holds the run');
  assert.strictEqual((await orch.run.attach({ adapter_pid: process.pid })).reattached, true, 'the orchestrator adapter of the same life still attaches');
  await operator.run.end({ exit_reason: 'test' });
});

test('run.attach: an operator attach over an unended run whose adapter pid is gone reattaches', async () => {
  await operator.run.attach({ adapter_pid: await deadPid() });
  const r = await operator.run.attach({ adapter_pid: process.pid });
  assert.strictEqual(r.reattached, true);
  assert.strictEqual(Number(r.run.adapter_pid), process.pid);
  await operator.run.end({ exit_reason: 'test' });
});

test('run.attach: a recorded creation time that matches the pid is a live adapter, and one that does not is a reused pid and reattaches', { skip: process.platform !== 'win32' }, async () => {
  const ID = core('proc-identity.cjs');
  const mine = await ID.createdOf(process.ppid, { kind: 'test' });
  assert.ok(mine && mine.created != null, 'the parent process has a readable creation time');
  await operator.run.attach({ adapter_pid: process.ppid, adapter_pid_created: mine.created });
  await assert.rejects(() => operator.run.attach({ adapter_pid: process.pid }), (e) => e.code === 'E_RUN_LIVE' && /still running/.test(e.message) && e.detail.adapter_state === 'live');
  await operator.run.end({ exit_reason: 'test' });

  await operator.run.attach({ adapter_pid: process.ppid, adapter_pid_created: 1 });
  const r = await operator.run.attach({ adapter_pid: process.pid });
  assert.strictEqual(r.reattached, true, 'the pid now belongs to a process created at another time, so the run lapsed');
  await operator.run.end({ exit_reason: 'test' });
});

test('run.attach: a null creation time on the row, with the pid now a process born after the run began, is a reused pid and reattaches', { skip: process.platform !== 'win32' }, async () => {
  await operator.run.attach({ adapter_pid: process.pid }); // as belay run writes it: no creation time yet (the first life)
  await operator.run.end({ exit_reason: 'test' });
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    await operator.run.attach({ adapter_pid: other.pid }); // a new life whose row names a pid, recorded without a creation time
    const row = (await operator.run.get()).run;
    assert.strictEqual(row.adapter_pid_created, null);
    const r = await operator.run.attach({ adapter_pid: process.pid });
    assert.strictEqual(r.reattached, true);
  } finally { other.kill(); await operator.run.end({ exit_reason: 'test' }); }
});
