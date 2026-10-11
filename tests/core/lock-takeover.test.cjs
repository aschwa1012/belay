'use strict';
// lock-takeover.test.cjs — the stale-lock takeover, driven deterministically through the interleavings
// a slow machine produces by chance. The racing-processes test in ownership.test.cjs samples them; these
// pin them down.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup, deadPid } = require('./helpers.cjs');

const { acquireLock, readOwnerLock, releaseLock } = core('lock.cjs');

function staleLock(dir, extra = {}) {
  const lockDir = path.join(dir, 'owner.lock');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: deadPid(), pipe: 'stale', acquired_at: Date.now() - 60000, ...extra }));
  return lockDir;
}

// A process that stays alive for the test, stopped by its own handle (its exact pid) afterwards.
const liveProcess = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });

test('a racer that judged a lock stale, then lost the CPU while another racer took it over, leaves the new live lock alone', () => {
  const dir = sandbox();
  const other = liveProcess();
  try {
    const lockDir = staleLock(dir);
    let calls = 0;
    // The CI interleaving: this racer has read the dead pid; before it acts, another racer completes
    // its takeover and the lock now names a live process. The earlier code renamed that live lock away
    // and reported won, so two processes each believed they owned the store.
    const r = acquireLock(dir, { pipe: 'late' }, {
      onStale: () => {
        if (calls++) return;
        fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: other.pid, pipe: 'winner', token: 'winner', acquired_at: Date.now() }));
      },
    });
    assert.strictEqual(r.won, false, 'the late racer must not win a lock a live process holds');
    assert.strictEqual(r.holder && r.holder.pid, other.pid, 'it names the live holder');
    assert.strictEqual(readOwnerLock(dir).pid, other.pid, 'the live lock is still in place');
  } finally { other.kill(); cleanup(dir); }
});

test('a stale lock is taken over in place, and the taker can release it', () => {
  const dir = sandbox();
  try {
    staleLock(dir);
    const r = acquireLock(dir, { pipe: 'mine' });
    assert.strictEqual(r.won, true);
    const meta = readOwnerLock(dir);
    assert.strictEqual(meta.pid, process.pid);
    assert.strictEqual(meta.pipe, 'mine');
    assert.ok(meta.token, 'a published lock carries a token, its identity for the next takeover');
    assert.strictEqual(releaseLock(r.lockDir), true);
    assert.strictEqual(fs.existsSync(path.join(dir, 'owner.lock')), false, 'released means gone');
    assert.deepStrictEqual(fs.readdirSync(dir), [], 'nothing is left beside it');
  } finally { cleanup(dir); }
});

test('a claim left by a claimant that died is passed over, so a crash mid-takeover cannot wedge the lock', () => {
  const dir = sandbox();
  try {
    const lockDir = staleLock(dir, { token: 'corpse' });
    fs.mkdirSync(path.join(lockDir, 'claim-corpse-0'));
    fs.writeFileSync(path.join(lockDir, 'claim-corpse-0', 'claimant.json'), JSON.stringify({ pid: deadPid(), at: Date.now() }));
    const r = acquireLock(dir, { pipe: 'mine' });
    assert.strictEqual(r.won, true);
    assert.strictEqual(readOwnerLock(dir).pid, process.pid);
    assert.ok(fs.existsSync(path.join(lockDir, 'claim-corpse-1')), 'the takeover was made under the next claim');
  } finally { cleanup(dir); }
});

test('a live claimant holds the takeover: nobody else replaces the lock it is taking over', () => {
  const dir = sandbox();
  const claimant = liveProcess();
  try {
    const lockDir = staleLock(dir, { token: 'corpse' });
    fs.mkdirSync(path.join(lockDir, 'claim-corpse-0'));
    fs.writeFileSync(path.join(lockDir, 'claim-corpse-0', 'claimant.json'), JSON.stringify({ pid: claimant.pid, at: Date.now() }));
    const r = acquireLock(dir, { pipe: 'mine' }, { attempts: 3 });
    assert.strictEqual(r.won, false);
    assert.strictEqual(readOwnerLock(dir).token, 'corpse', 'the stale metadata is untouched; the claimant owns the next move');
  } finally { claimant.kill(); cleanup(dir); }
});
