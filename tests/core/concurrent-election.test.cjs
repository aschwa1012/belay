'use strict';
// concurrent-election.test.cjs — concurrent first writes in one process elect one owner (audit 0.3.1 C1). Before the fix each
// write built its own client and elected; the second owner read a lock naming its own pid, took it over in place, failed its
// listen EADDRINUSE and on stop removed the lock the first owner was serving under. The interleaving is forced by a seam (the
// first owner's listen held until the test releases it), never by timing or load.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { openCore } = core('index.cjs');
const { Client } = core('client.cjs');
const { Owner } = core('owner.cjs');
const { readOwnerLock, acquireLock, releaseLock, serving, pipeName } = core('lock.cjs');

test('two concurrent first writes from one Core make one election, and both succeed', async () => {
  const dir = sandbox();
  const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  const origConnect = Client.prototype.connect;
  let connects = 0;
  Client.prototype.connect = function (...a) { connects += 1; return origConnect.apply(this, a); };
  try {
    const results = await Promise.allSettled([orch.task.create({ spec: 'a' }), orch.task.create({ spec: 'b' })]);
    assert.deepStrictEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled'], JSON.stringify(results.map((r) => r.reason && r.reason.message)));
    assert.strictEqual(connects, 1, 'the second write waited for the first one\'s election instead of making its own');
    assert.ok(orch.isOwner());
    assert.ok(fs.existsSync(path.join(dir, 'owner.lock')), 'the serving owner still has its lock on disk');
    assert.strictEqual(readOwnerLock(dir).token, orch.owner.lockToken);
  } finally {
    Client.prototype.connect = origConnect;
    try { await orch.shutdownOwner(); } catch { /* best effort */ }
    await orch.close();
    cleanup(dir);
  }
});

test('a second owner in the same process is refused the lock an owner here is starting under, and leaves it in place', async () => {
  const dir = sandbox();
  const origListen = Owner.prototype._listen;
  let release, held = false;
  const gate = new Promise((r) => { release = r; });
  Owner.prototype._listen = function () { if (!held) { held = true; return gate.then(() => origListen.call(this)); } return origListen.call(this); };
  const a = new Owner(dir, { embed: false });
  let b = null;
  try {
    const startA = a.start(); // holds the lock, its listen stalled: the window in which a second election ran
    b = new Owner(dir, { embed: false });
    await assert.rejects(b.start(), (e) => e.code === 'E_LOCKED' && e.detail.holder.pid === process.pid);
    assert.strictEqual(readOwnerLock(dir).token, a.lockToken, 'the first owner\'s lock is untouched');
    release();
    await startA;
    assert.ok(a.listening);
    // Two Cores in this process, both writing first: one owns, the other dials it.
    const c1 = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    const r = await c1.task.create({ spec: 'via the pipe' });
    assert.ok(r.id);
    assert.ok(!c1.isOwner());
    await c1.close();
  } finally {
    Owner.prototype._listen = origListen;
    release();
    await a.stop();
    if (b) await b.stop();
    cleanup(dir);
  }
});

test('a lock left under this pid by an owner that no longer serves is still taken over; release names its own token', () => {
  const dir = sandbox();
  try {
    const first = acquireLock(dir, { pipe: pipeName(dir) });
    assert.ok(first.won && first.token);
    serving.add(first.token);
    assert.strictEqual(acquireLock(dir, { pipe: pipeName(dir) }, { attempts: 2 }).won, false, 'served here: held');
    serving.delete(first.token);
    const second = acquireLock(dir, { pipe: pipeName(dir) });
    assert.ok(second.won, 'not served: a lock left behind, taken over in place');
    assert.notStrictEqual(second.token, first.token);
    assert.strictEqual(releaseLock(path.join(dir, 'owner.lock'), first.token), false, 'the old token releases nothing');
    assert.ok(fs.existsSync(path.join(dir, 'owner.lock')));
    assert.strictEqual(releaseLock(path.join(dir, 'owner.lock'), second.token), true);
  } finally { cleanup(dir); }
});
