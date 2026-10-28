'use strict';
// A second `belay run` on a run id is refused (E_RUN_LIVE) only when the previous adapter is VERIFIED still running: its pid answers and the
// recorded creation time matches the process snapshot. Anything less lets the attach through with a warning.
// The run's own orchestrator is never the other life, whichever of its MCP adapter and `belay run` attaches first.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

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

const child = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
const deadPid = async () => require('../helpers/dead-pid.cjs').deadPid(); // never an exited child's pid: Windows reuses those
const WIN = { skip: process.platform !== 'win32' };

test('run.attach: a live adapter with a verified creation time is refused with E_RUN_LIVE, and nothing is written', WIN, async () => {
  const mine = await ID.createdOf(process.ppid, { kind: 'test' });
  assert.ok(mine && mine.created != null, 'the parent process has a readable creation time');
  await operator.run.attach({ adapter_pid: process.ppid, adapter_pid_created: mine.created });
  const before = (await operator.run.get()).epochs.length;
  await assert.rejects(() => operator.run.attach({ adapter_pid: process.pid }), (e) => e.code === 'E_RUN_LIVE' && /still running/.test(e.message) && /another run id/.test(e.message) && e.detail.adapter_state === 'live');
  assert.strictEqual((await operator.run.get()).epochs.length, before, 'no row was appended');
  await operator.run.end({ exit_reason: 'test' });
});

test('run.attach: a creation time that does not match the pid is a reused pid, and the run reattaches', WIN, async () => {
  const other = child();
  try {
    await operator.run.attach({ adapter_pid: other.pid, adapter_pid_created: 1 });
    const r = await operator.run.attach({ adapter_pid: process.pid });
    assert.strictEqual(r.reattached, true);
    assert.strictEqual(r.warnings, undefined, 'a pid proved to be another process needs no warning');
  } finally { other.kill(); await operator.run.end({ exit_reason: 'test' }); }
});

test('run.attach: a live child with no recorded creation time is allowed, with a warning naming the pid and no claim of a takeover', async () => {
  const other = child();
  try {
    await operator.run.attach({ adapter_pid: await deadPid() }); // the run is open: an orchestrator adapter cannot reopen an ended one
    await orch.run.attach({ adapter_pid: other.pid, orchestrator_pid: 111111 }); // as the MCP adapter writes it when its probe had nothing yet
    assert.strictEqual((await operator.run.get()).run.adapter_pid_created, null);
    const r = await operator.run.attach({ adapter_pid: process.pid, orchestrator_pid: 222222 });
    assert.strictEqual(r.reattached, true);
    assert.ok(Array.isArray(r.warnings) && r.warnings.length === 1 && r.warnings[0].includes(`pid ${other.pid}`) && /could not be verified/.test(r.warnings[0]), JSON.stringify(r.warnings));
  } finally { other.kill(); await operator.run.end({ exit_reason: 'test' }); }
});

test('run.attach: an adapter pid that is gone reattaches without a warning', async () => {
  await operator.run.attach({ adapter_pid: await deadPid() });
  const r = await operator.run.attach({ adapter_pid: process.pid });
  assert.strictEqual(r.reattached, true);
  assert.strictEqual(r.warnings, undefined);
  await operator.run.end({ exit_reason: 'test' });
});

test('run.attach: the orchestrator adapter attaching first, then belay run for the same orchestrator, is not refused, even with a verified live creation time', WIN, async () => {
  const adapter = child();
  try {
    const created = await ID.createdOf(adapter.pid, { kind: 'test' });
    assert.ok(created && created.created != null);
    await operator.run.attach({ adapter_pid: await deadPid() });
    await orch.run.attach({ adapter_pid: adapter.pid, adapter_pid_created: created.created, orchestrator_pid: 333333 });
    const r = await operator.run.attach({ adapter_pid: process.pid, orchestrator_pid: 333333 });
    assert.strictEqual(r.reattached, true);
    assert.strictEqual(r.warnings, undefined);
  } finally { adapter.kill(); await operator.run.end({ exit_reason: 'test' }); }
});

test('run.attach: belay run first, then the orchestrator adapter, is never refused', async () => {
  await operator.run.attach({ adapter_pid: process.pid, orchestrator_pid: 444444 });
  const r = await orch.run.attach({ adapter_pid: process.ppid, orchestrator_pid: 444444 });
  assert.strictEqual(r.reattached, true);
  await operator.run.end({ exit_reason: 'test' });
});
