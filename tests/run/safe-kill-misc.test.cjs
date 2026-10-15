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

// ADR 0048 decision 8 (c). "Never waits" and "has the answer" are separate claims. The first is proved with a snapshot
// that never resolves, so no real snapshot's speed can decide it; the second waits on the probe's own read settling.
test('ownCreatedProbe: never waits for the snapshot (one that never resolves)', async () => {
  let asked = 0;
  const probe = ID.ownCreatedProbe(process.pid, { snapshot: () => { asked++; return new Promise(() => {}); } });
  assert.strictEqual(await probe(), null, 'the probe must not block on the snapshot');
  assert.strictEqual(await probe(), null);
  assert.strictEqual(asked, 1, 'at most one read is in flight, however often the probe is asked');
});

test('ownCreatedProbe: a failed read is requested again on the next ask, never awaited, and the answer lands', async () => {
  let asked = 0;
  const probe = ID.ownCreatedProbe(process.pid, { snapshot: async () => { asked++; return asked === 1 ? null : new Map([[process.pid, { ppid: 0, created: 1234, image: 'node.exe' }]]); } });
  await probe.whenSettled();                         // the first read settled, and failed
  assert.strictEqual(await probe(), null, 'the failed read gives no answer, and this ask starts the re-read');
  await probe.whenSettled();                         // the lazy re-read settled
  assert.strictEqual(await probe(), 1234);
  assert.strictEqual(asked, 2);
});

test('ownCreatedProbe: with the real snapshot the answer arrives once the read settles', async (t) => {
  if (process.platform !== 'win32') return t.skip('the CIM snapshot is Windows only');
  const probe = ID.ownCreatedProbe(process.pid);
  let later = null;
  for (let i = 0; i < 3 && later === null; i++) { await probe.whenSettled(); later = await probe(); }
  assert.ok(Number.isFinite(later) && later < Date.now(), `precondition: the real snapshot could not read this process's creation time in 3 reads (got ${String(later)})`);
});
