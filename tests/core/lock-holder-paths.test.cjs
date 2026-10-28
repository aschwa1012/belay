'use strict';
// lock-holder-paths.test.cjs — the remaining paths of the reused-pid lock takeover (audit 0.3.1 C4, the check's nits M15 and M9),
// and where its process snapshot is taken. The snapshot is stubbed (proc-identity's processSnapshot, looked up at each call), and
// every interleaving is forced by a gate the test opens, never by timing or load. The reused pid's stand-in is a live child of
// this test, killed by its exact pid through its handle.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { openCore } = core('index.cjs');
const { Client } = core('client.cjs');
const { Owner } = core('owner.cjs');
const ID = core('proc-identity.cjs');
const { pipeName, readOwnerLock } = core('lock.cjs');

async function liveChild() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore', windowsHide: true });
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
const mk = (dir, extra = {}) => new Client(dir, { caller: callerFor('orchestrator'), ownerOpts: { embed: false }, retryMs: 10, dialTimeoutMs: 500, ...extra });

test('M15: two clients that both judge the lock reused take it over once, and the loser dials the winner', async () => {
  const dir = sandbox();
  const stand = await liveChild();
  const at = Date.now() - 60000;
  plant(dir, { pid: stand.pid, token: 'bothjudge01', acquired_at: at });
  const orig = ID.processSnapshot;
  // Both clients reach the snapshot before either acts on it: the second call opens the gate for both.
  let open, asks = 0;
  const gate = new Promise((r) => { open = r; });
  ID.processSnapshot = async () => { asks += 1; if (asks === 2) open(); await gate; return new Map([[stand.pid, { created: at + 1000, image: 'node.exe' }], [process.pid, { created: at - 5000, image: 'node.exe' }]]); };
  const c1 = mk(dir), c2 = mk(dir);
  try {
    const got = await Promise.allSettled([c1.connect(), c2.connect()]);
    assert.deepStrictEqual(got.map((g) => g.status), ['fulfilled', 'fulfilled'], JSON.stringify(got.map((g) => g.reason && g.reason.message)));
    assert.strictEqual(asks, 2, 'each client asked once');
    const owners = [c1, c2].filter((c) => c.becameOwner);
    assert.strictEqual(owners.length, 1, 'one took the lock over');
    const loser = c1.becameOwner ? c2 : c1;
    assert.ok(loser.connected, 'the other dialled the winner');
    assert.strictEqual(readOwnerLock(dir).token, owners[0].owner.lockToken);
  } finally {
    ID.processSnapshot = orig;
    for (const c of [c1, c2]) if (c.owner) await c.owner.stop();
    await c1.close(); await c2.close(); await killChild(stand); cleanup(dir);
  }
});

test('M9: an owner that stopped no longer marks its lock as served here, so a lock it left behind is taken over', async () => {
  const dir = sandbox();
  const a = new Owner(dir, { embed: false });
  let b = null;
  try {
    await a.start();
    const token = a.lockToken;
    await a.stop();
    // The lock a stop could not release (its directory left with this pid and token): planted as such.
    plant(dir, { pid: process.pid, token, acquired_at: Date.now() - 1000 });
    b = new Owner(dir, { embed: false });
    await b.start();
    assert.notStrictEqual(readOwnerLock(dir).token, token, 'the left-behind lock was taken over in place');
  } finally { if (b) await b.stop(); cleanup(dir); }
});

test('a connect to an owner that answers takes no process snapshot; only a silent live holder costs one per connect', async () => {
  const dir = sandbox();
  const orig = ID.processSnapshot;
  let snaps = 0;
  ID.processSnapshot = async (...a) => { snaps += 1; return orig(...a); };
  const owner = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  try {
    await owner.run.attach({ adapter_pid: process.pid });
    const c = mk(dir);
    await c.connect();
    assert.ok(c.connected && !c.becameOwner);
    await c.close();
    const w = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    await w.task.create({ spec: 'a write over the pipe' });
    await w.close();
    assert.strictEqual(snaps, 0, 'no snapshot on the ordinary path');
  } finally { ID.processSnapshot = orig; await owner.shutdownOwner(); await owner.close(); cleanup(dir); }

  const dir2 = sandbox();
  const stand = await liveChild();
  plant(dir2, { pid: stand.pid, token: 'silentgenuine', acquired_at: Date.now() + 1000 }); // born before the lock: genuine
  snaps = 0;
  ID.processSnapshot = async () => { snaps += 1; return new Map([[stand.pid, { created: Date.now() - 60000, image: 'node.exe' }]]); };
  try {
    for (let i = 0; i < 2; i++) {
      const c = mk(dir2, { connectRetries: 3, dialTimeoutMs: 100 });
      await assert.rejects(c.connect(), (e) => e.code === 'E_NO_OWNER');
      await c.close();
    }
    assert.strictEqual(snaps, 2, 'one snapshot per connect, not one per retry');
  } finally { ID.processSnapshot = orig; await killChild(stand); cleanup(dir2); }
});
