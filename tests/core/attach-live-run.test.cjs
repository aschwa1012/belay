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

test('run.attach: an operator attach over a run whose adapter pid is alive is refused with E_RUN_LIVE and writes no row', async () => {
  await operator.run.attach({ adapter_pid: process.ppid });
  const before = (await operator.run.get()).epochs.length;
  await assert.rejects(() => operator.run.attach({ adapter_pid: process.pid }), (e) => e.code === 'E_RUN_LIVE' && /still live/.test(e.message) && e.detail.adapter_pid === process.ppid);
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
