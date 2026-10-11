'use strict';
// lock-listening.test.cjs — an owner can never end up holding the lock while no reader sees it as
// listening. Rewriting owner.json by rename lost to readers polling it (Windows refuses a rename onto a
// file any process has open), and the owner then served on, undialable, with the lock held.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup, FIXTURES } = require('./helpers.cjs');

const lock = core('lock.cjs');
const { Owner } = core('owner.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Three readers polling owner.json in a tight loop, each stopped by its own exact pid afterwards.
async function startReaders(dir, n = 3) {
  const kids = Array.from({ length: n }, () => spawn(process.execPath, [path.join(FIXTURES, 'lock-reader.cjs'), dir, '20000'], { windowsHide: true, stdio: 'ignore' }));
  const deadline = Date.now() + 15000;
  while (fs.readdirSync(dir).filter(f => f.startsWith('reader-')).length < n) {
    if (Date.now() > deadline) throw new Error('the readers never started');
    await sleep(20);
  }
  await sleep(100);
  return () => { for (const k of kids) { try { process.kill(k.pid); } catch { /* exited */ } } };
}

test('markListening succeeds against three readers polling owner.json, and readers then see listening', async () => {
  const dir = sandbox();
  let stopReaders = () => {};
  try {
    const r = lock.acquireLock(dir, { pipe: 'p', listening: false });
    assert.strictEqual(r.won, true);
    stopReaders = await startReaders(dir);
    for (let i = 0; i < 3; i++) {
      const before = lock.readOwnerLock(dir);
      assert.strictEqual(before.listening, i === 0 ? false : true);
      assert.strictEqual(lock.markListening(r.lockDir), true, 'marked while readers hold owner.json open');
      const after = lock.readOwnerLock(dir);
      assert.strictEqual(after.listening, true);
      assert.strictEqual(after.pid, process.pid);
    }
  } finally { stopReaders(); await sleep(200); cleanup(dir); }
});

test('a takeover does not inherit the dead owner\'s listening marker', async () => {
  const dir = sandbox();
  try {
    const lockDir = path.join(dir, 'owner.lock');
    fs.mkdirSync(lockDir);
    const { deadPid } = require('./helpers.cjs');
    const pid = deadPid();
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid, pipe: 'old', listening: false, token: 'old1', acquired_at: Date.now() - 60000 }));
    fs.writeFileSync(path.join(lockDir, 'listening-old1.json'), JSON.stringify({ pid, token: 'old1', listening_at: 1 }));
    assert.strictEqual(lock.readOwnerLock(dir).listening, true, 'the marker for that very lock reads as listening');
    const r = lock.acquireLock(dir, { pipe: 'new', listening: false });
    assert.strictEqual(r.won, true);
    const now = lock.readOwnerLock(dir);
    assert.strictEqual(now.pid, process.pid);
    assert.strictEqual(now.listening, false, 'the new lock is not listening until it says so itself');
  } finally { cleanup(dir); }
});

test('an owner whose listening mark cannot be written fails its start with a code and holds nothing', async () => {
  const dir = sandbox();
  const real = lock.markListening;
  lock.markListening = () => false;
  try {
    const o = new Owner(dir, { embed: false });
    const started = await o.start().then(() => null, e => e);
    if (!started) { await o.stop(); assert.fail('the start succeeded with no listening mark'); }
    assert.strictEqual(started.code, 'E_INTERNAL');
    assert.match(started.message, /could not publish that its pipe is listening/);
    assert.strictEqual(fs.existsSync(path.join(dir, 'owner.lock')), false, 'the lock is released');
    assert.strictEqual(lock.readOwnerLock(dir), null);
    const dialled = await new Promise(res => {
      const c = net.connect(o.pipe);
      c.once('connect', () => { c.destroy(); res(true); });
      c.once('error', () => res(false));
    });
    assert.strictEqual(dialled, false, 'no pipe is left listening');
  } finally { lock.markListening = real; cleanup(dir); }
});

test('an owner started against three readers polling owner.json comes up listening', async () => {
  const dir = sandbox();
  let stopReaders = () => {}, o = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    stopReaders = await startReaders(dir);
    o = new Owner(dir, { embed: false });
    await o.start();
    const seen = lock.readOwnerLock(dir);
    assert.strictEqual(seen.pid, process.pid);
    assert.strictEqual(seen.listening, true, 'a reader would dial this owner');
  } finally { stopReaders(); await sleep(200); if (o) await o.stop(); cleanup(dir); }
});
