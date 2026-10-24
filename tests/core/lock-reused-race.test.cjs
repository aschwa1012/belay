'use strict';
// lock-reused-race.test.cjs — two processes that both judge a lock's live pid reused (audit 0.3.1 C4) take it over once. Each
// interleaving is forced: a stalled rename (fault injection on the claim holder's owner.json replace) or the onStale seam,
// with the other contender a real second process. Never timing or load. The reused pid's stand-in is a live child of this test.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { Client } = core('client.cjs');
const ID = core('proc-identity.cjs');
const { pipeName, acquireLock, readOwnerLock } = core('lock.cjs');
const LOCK = path.join(__dirname, '..', '..', 'src', 'core', 'lock.cjs');

async function liveChild(code = 'setInterval(() => {}, 1e6)', args = []) {
  const child = spawn(process.execPath, ['-e', code, ...args], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  await new Promise((r) => child.once('spawn', r));
  return child;
}
async function killChild(child) {
  try { process.kill(child.pid); } catch { /* gone */ }
  await new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r)));
}
function plant(dir, meta) {
  const lockDir = path.join(dir, 'owner.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pipe: pipeName(dir), listening: true, mode: 'claimed', ...meta }));
}
// A second contender in its own process: acquireLock with the same stale token, its answer on stdout.
const CONTEND = `const r = require(process.argv[1]).acquireLock(process.argv[2], { pipe: 'second' }, { staleToken: process.argv[3] }); process.stdout.write(JSON.stringify({ won: r.won, token: r.token || null, holder_pid: r.holder ? r.holder.pid : null }));`;
const waitSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test('a second process that judged the same lock reused loses while the first holds the claim (its owner.json rename stalled)', async () => {
  const dir = sandbox();
  const stand = await liveChild();
  plant(dir, { pid: stand.pid, token: 'reusedrace01', acquired_at: Date.now() - 60000 });
  const meta = path.join(dir, 'owner.lock', 'owner.json');
  const orig = fs.renameSync;
  let second = null;
  fs.renameSync = function (from, to) {
    // The first contender holds the claim and is about to replace owner.json: the other contender runs to completion now.
    if (!second && path.resolve(String(to)) === path.resolve(meta)) second = JSON.parse(execFileSync(process.execPath, ['-e', CONTEND, LOCK, dir, 'reusedrace01'], { encoding: 'utf8', windowsHide: true }));
    return orig.apply(this, arguments);
  };
  try {
    const first = acquireLock(dir, { pipe: 'first' }, { staleToken: 'reusedrace01' });
    assert.ok(second, 'the stall ran the second contender');
    assert.strictEqual(second.won, false, `the second process must lose: ${JSON.stringify(second)}`);
    assert.strictEqual(first.won, true);
    const now = readOwnerLock(dir);
    assert.strictEqual(now.pid, process.pid);
    assert.strictEqual(now.token, first.token);
  } finally { fs.renameSync = orig; await killChild(stand); cleanup(dir); }
});

test('a contender that judged the lock reused, then lost the CPU while another process took it over, leaves the new lock alone', async () => {
  const dir = sandbox();
  const stand = await liveChild();
  plant(dir, { pid: stand.pid, token: 'reusedrace02', acquired_at: Date.now() - 60000 });
  const marker = path.join(dir, 'second-won.json');
  // The other process takes the reused lock over and stays alive, holding it, until its stdin closes.
  const holdCode = `${CONTEND.replace('process.stdout.write(', `require('fs').writeFileSync(process.argv[4], `)} process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`;
  let second = null;
  try {
    const r = acquireLock(dir, { pipe: 'late' }, {
      staleToken: 'reusedrace02', attempts: 3,
      onStale: () => {
        if (second) return;
        second = spawn(process.execPath, ['-e', holdCode, LOCK, dir, 'reusedrace02', marker], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
        for (let i = 0; i < 3000 && !fs.existsSync(marker); i++) waitSync(10); // the event: the other process has answered
      },
    });
    const won = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.strictEqual(won.won, true, 'the other process took the reused lock');
    assert.strictEqual(r.won, false, 'the late contender must not take the live lock that replaced the reused one');
    assert.strictEqual(r.holder.pid, second.pid);
    assert.strictEqual(readOwnerLock(dir).token, won.token, 'the other process\'s lock is untouched');
  } finally {
    if (second) { second.stdin.end(); await new Promise((r) => (second.exitCode !== null ? r() : second.once('exit', r))); }
    await killChild(stand); cleanup(dir);
  }
});

// Was a should-fix: a genuine verdict was remembered by token for the life of the process (now asked again on every connect). A holder seen genuine (live, not
// answering the dial) that is then ended by a terminate leaves its lock, and once Windows reuses its pid this process never
// asks again: every election here ends E_NO_OWNER while a fresh process would take the lock over. The snapshot is stubbed so
// the same lock (same pid, same acquired_at) reads genuine first and reused second, which is what a pid reuse looks like.
test('a holder once judged genuine is asked again after its pid could have been reused', async () => {
  const dir = sandbox();
  const stand = await liveChild();
  const at = Date.now() - 60000;
  plant(dir, { pid: stand.pid, token: 'genuinethenreused', acquired_at: at });
  const orig = ID.processSnapshot;
  let created = at - 1000;
  ID.processSnapshot = async () => new Map([[stand.pid, { created, image: 'node.exe' }], [process.pid, { created: at - 5000, image: 'node.exe' }]]);
  const mk = () => new Client(dir, { caller: callerFor('orchestrator'), ownerOpts: { embed: false }, connectRetries: 1, retryMs: 10, dialTimeoutMs: 200 });
  const c1 = mk(), c2 = mk();
  try {
    await assert.rejects(c1.connect(), (e) => e.code === 'E_NO_OWNER');
    created = at + 1000; // the process at the pid is now one born after the lock was taken
    await c2.connect();
    assert.ok(c2.becameOwner, 'the reused lock was taken over');
  } finally {
    ID.processSnapshot = orig;
    if (c2.owner) await c2.owner.stop();
    await c1.close(); await c2.close(); await killChild(stand); cleanup(dir);
  }
});
