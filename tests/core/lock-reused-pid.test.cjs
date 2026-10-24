'use strict';
// lock-reused-pid.test.cjs — a dead owner's lock whose pid Windows has handed to another process (audit 0.3.1 C4). Staleness
// was a bare pid check, so the lock read as held for as long as that process lived: every election ended E_LOCKED and every
// write E_NO_OWNER until a human deleted owner.lock. Whether the process at the pid took the lock is now answered by its
// creation time in a process snapshot (ADR 0039's identity). The stand-in for "the pid was reused" is a live child of this
// test whose pid the planted lock names; it is killed by its exact pid through its handle.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { openCore } = core('index.cjs');
const { Client } = core('client.cjs');
const { pipeName, acquireLock, holderReused, readOwnerLock } = core('lock.cjs');

async function liveChild() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore', windowsHide: true });
  await new Promise((r) => child.once('spawn', r));
  return child;
}
async function killChild(child) {
  try { process.kill(child.pid); } catch { /* gone */ }
  await new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r)));
}
// Exactly what a serving owner leaves: owner.json with listening true (markListening rewrote it).
function plant(dir, meta) {
  const lockDir = path.join(dir, 'owner.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pipe: pipeName(dir), listening: true, mode: 'claimed', ...meta }));
}

test('holderReused: an exact recorded creation time decides; else a process born after acquired_at did not take the lock', () => {
  const snap = new Map([[100, { created: 5000, image: 'node.exe' }]]);
  assert.strictEqual(holderReused({ pid: 100, created: 5000, acquired_at: 1 }, snap).reused, false);
  assert.strictEqual(holderReused({ pid: 100, created: 4999, acquired_at: 9999 }, snap).reused, true, 'the recorded time wins over acquired_at');
  assert.strictEqual(holderReused({ pid: 100, acquired_at: 4000 }, snap).reused, true);
  assert.strictEqual(holderReused({ pid: 100, acquired_at: 5000 }, snap).reused, false);
  assert.strictEqual(holderReused({ pid: 100, acquired_at: 4000 }, null).reused, null, 'an unreadable snapshot proves nothing');
  assert.strictEqual(holderReused({ pid: 101, acquired_at: 4000 }, snap).reused, null, 'a pid not in the snapshot proves nothing');
  assert.strictEqual(holderReused({ pid: 100, acquired_at: 4000 }, new Map([[100, { created: null }]])).reused, null);
});

test('acquireLock takes a live-pid lock over only when the caller names its token as stale', () => {
  const dir = sandbox();
  try {
    plant(dir, { pid: process.ppid, token: 'tok-a', acquired_at: Date.now() });
    const other = acquireLock(dir, { pipe: pipeName(dir) }, { staleToken: 'tok-b', attempts: 2 });
    assert.strictEqual(other.won, false, 'another token is not this lock');
    assert.strictEqual(other.holder.token, 'tok-a');
    const won = acquireLock(dir, { pipe: pipeName(dir), created: 1234 }, { staleToken: 'tok-a' });
    assert.strictEqual(won.won, true);
    const now = readOwnerLock(dir);
    assert.strictEqual(now.pid, process.pid);
    assert.strictEqual(now.created, 1234, 'the lock records the creation time it was given');
  } finally { cleanup(dir); }
});

test('a racer that judged the reused lock stale does not take the live lock that replaced it in between', () => {
  const dir = sandbox();
  try {
    plant(dir, { pid: process.ppid, token: 'reused-1', acquired_at: Date.now() });
    let calls = 0;
    // Between the late racer's judgement and its act, another process takes the reused lock over: owner.json now names a
    // new live lock (another token). The stale token no longer matches it, so the late racer must lose.
    const r = acquireLock(dir, { pipe: 'late' }, {
      staleToken: 'reused-1', attempts: 3,
      onStale: () => { if (calls++) return; fs.writeFileSync(path.join(dir, 'owner.lock', 'owner.json'), JSON.stringify({ pid: process.ppid, pipe: 'winner', token: 'winner', acquired_at: Date.now() })); },
    });
    assert.strictEqual(r.won, false);
    assert.strictEqual(readOwnerLock(dir).token, 'winner', 'the live lock is still in place');
  } finally { cleanup(dir); }
});

test('a dead owner\'s lock whose pid now names an unrelated live process is taken over, and the write lands', { timeout: 120000 }, async () => {
  const dir = sandbox();
  const other = await liveChild();
  // the lock was taken a minute before the process now at its pid was created
  plant(dir, { pid: other.pid, token: 'deadbeef0001', acquired_at: Date.now() - 60000, listening_at: Date.now() - 59000 });
  const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  try {
    const r = await orch.run.attach({ adapter_pid: process.pid });
    assert.ok(r, 'the write landed');
    assert.ok(orch.isOwner(), 'this process took the stale lock over');
    const lock = readOwnerLock(dir);
    assert.strictEqual(lock.pid, process.pid);
    assert.ok(Number.isFinite(lock.created), 'the new lock records this process\'s creation time, read from the same snapshot');
  } finally {
    try { await orch.shutdownOwner(); } catch { /* none */ }
    await orch.close();
    await killChild(other);
    cleanup(dir);
  }
});

test('a live holder that took the lock is not taken over, and E_NO_OWNER names the held lock', { timeout: 120000 }, async () => {
  const dir = sandbox();
  const other = await liveChild();
  // created before the lock was taken: the holder is genuine (if wedged), so the lock stands
  plant(dir, { pid: other.pid, token: 'genuine0001', acquired_at: Date.now() + 1000 });
  const c = new Client(dir, { caller: callerFor('orchestrator'), ownerOpts: { embed: false }, connectRetries: 2, retryMs: 10, dialTimeoutMs: 200 });
  try {
    await assert.rejects(c.connect(), (e) => {
      assert.strictEqual(e.code, 'E_NO_OWNER');
      assert.match(e.message, new RegExp(`owner lock is held by pid ${other.pid}, which is alive`));
      assert.doesNotMatch(e.message, /may not elect/);
      return true;
    });
    assert.strictEqual(readOwnerLock(dir).token, 'genuine0001', 'the lock was not touched');
  } finally { await c.close(); await killChild(other); cleanup(dir); }
});
