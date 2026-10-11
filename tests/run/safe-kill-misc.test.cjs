'use strict';
// safe-kill-misc.test.cjs — ADR 0039 review round: the creation time is discarded when the child exited before
// the read, the fast-close kill is refused (and recorded) when the budget cannot pay for a fresh snapshot, and
// the own-process probe never delays an attach.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const PI = require('../../src/run/pid-identity.cjs');
const ID = require('../../src/core/proc-identity.cjs');
const { closeRunWorkers } = require('../../src/cli/run-close.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
const running = (c) => c.exitCode === null && c.signalCode === null;

test('noteSpawn: a creation time read after the child exited is discarded, and the row says why', async () => {
  const exited = { pid: 4242, exitCode: 0, signalCode: null, spawnfile: 'C:/x/claude.exe' };
  const w = { pid: 4242 };
  await PI.noteSpawn(w, exited, { createdOf: async () => ({ created: 99 }) });
  assert.strictEqual(w.pidCreated, null);
  assert.match(w.pidCreatedError, /already exited/);
  assert.strictEqual(w.pidImage, 'claude.exe');
  assert.deepStrictEqual(PI.rowFields(w), { pid_created: null, pid_created_error: w.pidCreatedError, pid_image: 'claude.exe' });
  const live = { pid: 4243, exitCode: null, signalCode: null, spawnfile: 'C:/x/node.exe' };
  const w2 = { pid: 4243 };
  await PI.noteSpawn(w2, live, { createdOf: async () => ({ created: 99 }) });
  assert.strictEqual(w2.pidCreated, 99);
  assert.strictEqual(w2.pidImage, 'node.exe');
});

test('run close, fast: with less budget than a snapshot takes the kill is refused and recorded, and the process survives', async () => {
  const s = sleeper();
  try {
    let snapshotCalled = false;
    const row = { id: 'w1', run_id: 'r1', substrate: 'claude-code', state: 'running', pid: s.pid, pid_created: 5, pid_image: 'node.exe' };
    const core = { run: { get: async () => ({ run: { adapter_pid: process.pid } }) }, worker: { list: async () => ({ workers: [row] }) } };
    const fast = { requested: () => true, leftMs: () => 400, snapshot: async () => { snapshotCalled = true; return new Map(); } };
    const out = await closeRunWorkers({ core, runId: 'r1', graceMs: 100, fast });
    assert.strictEqual(snapshotCalled, false, 'no snapshot is started that the budget cannot wait for');
    assert.strictEqual(out.killed[0].refused, 'identity', JSON.stringify(out.killed));
    assert.strictEqual(out.killed[0].kind, 'no_budget', 'a skip for want of budget is never counted as an unreadable snapshot');
    await sleep(200);
    assert.strictEqual(running(s), true);
  } finally { s.kill(); }
});

test('ownCreatedProbe: never waits for the snapshot, and has the answer once it is done', async (t) => {
  if (process.platform !== 'win32') return t.skip('the CIM snapshot is Windows only');
  const probe = ID.ownCreatedProbe(process.pid);
  // A probe that waited for the snapshot would come back with the answer; null right away proves it did not wait.
  // No wall-clock bound: on a starved machine even a non-blocking await can take longer than any fixed figure.
  const early = await probe();
  assert.strictEqual(early, null, 'the probe must not block on the snapshot');
  // Wait for the snapshot to finish, not for a fixed time: poll the probe, which turns non-null the moment the
  // read is done. The bound is reached only on a hang (the snapshot itself times out well inside it).
  const deadline = Date.now() + 90000;
  let later = null;
  while (later === null && Date.now() < deadline) {
    later = await probe();
    if (later === null) await sleep(50);
  }
  assert.ok(Number.isFinite(later) && later < Date.now(), `the answer never arrived: ${String(later)}`);
});
