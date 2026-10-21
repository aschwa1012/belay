'use strict';
// operator-check-orphans.test.cjs — ADR 0045 decision 4, the orphan of a process belay spawned. A worker (here: a record in the
// machine-wide spawn register, then retired as it is when the worker exits) starts a detached helper, and the helper's parent goes
// away, so the helper's chain ends at itself. The helper is older than an owner that starts afterwards, so "a chain intact to a root
// older than the owner" alone takes it for the operator. The register keeps what the exited worker leaves behind
// (spawn-provenance.cjs). Part one drives the check with injected host tables; part two puts a real bound owner behind it and asks
// for a write, a bind and the CLI's worker-kill proof.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { core, sandbox, cleanup } = require('./helpers.cjs');

const OC = core('operator-check.cjs');
const SR = core('spawn-register.cjs');
const Prov = core('spawn-provenance.cjs');
const { Owner } = core('owner.cjs');
const { Client } = core('client.cjs');
const { operatorProof } = core('operator-proof.cjs');

const NOW = Date.now();
const W = { pid: 7001, created: NOW - 60000 }; // the worker: started a minute ago, gone now
const HELPER = 4242;
const snap = (o) => new Map(Object.entries(o).map(([pid, v]) => [Number(pid), v]));
const OLD_SHELL = { 4000: { ppid: 1, created: NOW - 9e6, image: 'explorer.exe' } };
const tcp = (extra = {}) => ({ belayTransport: 'tcp', remotePort: 61000, localPort: 52100, ...extra });
const tableOf = (pid) => async () => `  TCP    127.0.0.1:52100        127.0.0.1:61000        ESTABLISHED     1234\r\n  TCP    127.0.0.1:61000        127.0.0.1:52100        ESTABLISHED     ${pid}\r\n`;
const check = (shot, extra = {}, peer = HELPER) => OC.create({ startedAt: NOW, spawned: () => [], provenance: (s) => Prov.refresh(s), deps: { table: tableOf(peer), snapshot: async () => snap(shot) }, ...extra });

async function withRegistry(fn) {
  const keep = process.env.BELAY_SPAWN_REGISTRY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-orphans-'));
  process.env.BELAY_SPAWN_REGISTRY = dir;
  try { return await fn(dir); } finally { process.env.BELAY_SPAWN_REGISTRY = keep; fs.rmSync(dir, { recursive: true, force: true }); }
}
const exitedWorker = () => { SR.register({ pid: W.pid, kind: 'worker', dataDir: 'C:/other/store/.belay', created: W.created }); SR.unregister(W.pid); };

test('a helper left behind by an exited worker is refused by an owner that started after the worker, whatever its parent link looks like', async () => {
  await withRegistry(async () => {
    exitedWorker();
    // the helper's parent is the worker itself (gone)
    const direct = await check({ ...OLD_SHELL, [HELPER]: { ppid: W.pid, created: W.created + 5000, image: 'node.exe' } })({ conn: tcp() });
    assert.strictEqual(direct.ok, false, JSON.stringify(direct));
    assert.match(direct.reason, /descends from a process belay spawned \(descendant of worker pid 7001 pid 4242/);
  });
  await withRegistry(async () => {
    exitedWorker();
    // or a middle process that also exited (a `start /b` does this)
    const middle = await check({ ...OLD_SHELL, [HELPER]: { ppid: 9999, created: W.created + 5000, image: 'node.exe' } })({ conn: tcp() });
    assert.strictEqual(middle.ok, false, JSON.stringify(middle));
    assert.match(middle.reason, /descendant of worker pid 7001/);
  });
});

test('without the orphan record the same helper is taken for the operator (the defect), and a root from before the worker is still accepted', async () => {
  await withRegistry(async () => {
    exitedWorker();
    const helper = { [HELPER]: { ppid: 9999, created: W.created + 5000, image: 'node.exe' } };
    assert.strictEqual((await check(helper, { provenance: null })({ conn: tcp() })).ok, true, 'the check as it was');
    const older = await check({ [HELPER]: { ppid: 9999, created: W.created - 5000, image: 'node.exe' } })({ conn: tcp() });
    assert.strictEqual(older.ok, true, `a root that was running before the worker started is not its orphan: ${JSON.stringify(older)}`);
  });
});

test('the record outlives the worker: a child of the helper is refused once the worker\'s own tombstone is gone, and so is a child whose parent died', async () => {
  await withRegistry(async () => {
    exitedWorker();
    const helperEntry = { ppid: 9999, created: W.created + 5000, image: 'node.exe' };
    assert.strictEqual((await check({ ...OLD_SHELL, [HELPER]: helperEntry })({ conn: tcp() })).ok, false);
    assert.deepStrictEqual(SR.tombstones().map((t) => [t.pid, t.via, t.until]), [[HELPER, 'worker pid 7001', null]], 'the worker\'s tombstone is replaced by its live descendant');
    // a child (pid 4300) of the helper, created long after the worker's window but while the helper ran: reached through the helper's record
    const kid = { ppid: HELPER, created: NOW - 1000, image: 'cmd.exe' };
    const viaChain = await check({ [HELPER]: helperEntry, 4300: kid }, {}, 4300)({ conn: tcp() });
    assert.strictEqual(viaChain.ok, false, JSON.stringify(viaChain));
    // the helper exits and its child is left a root whose parent pid is the helper
    const orphanKid = await check({ 4300: kid }, {}, 4300)({ conn: tcp() });
    assert.strictEqual(orphanKid.ok, false, JSON.stringify(orphanKid));
    assert.match(orphanKid.reason, /descendant of descendant pid 4242/);
  });
});

test('a parent pid reused after the worker exited does not make a later process its descendant', async () => {
  await withRegistry(async () => {
    // The worker lived from NOW-120000 to NOW-100000. Windows hands its pid to an unrelated short-lived launcher that starts a detached
    // terminal: the terminal is a root whose parent pid is the worker's, and it is older than this owner's start.
    SR.saveTombstone({ pid: W.pid, created: NOW - 120000, from: NOW - 120000, until: NOW - 100000, kind: 'worker', via: null });
    const terminal = (created) => ({ ...OLD_SHELL, [HELPER]: { ppid: W.pid, created, image: 'WindowsTerminal.exe' } });
    const reused = await check(terminal(NOW - 100000 + Prov.SLACK_MS + 5000))({ conn: tcp() });
    assert.strictEqual(reused.ok, true, `a root created after the worker's lifetime and grace is not its descendant: ${JSON.stringify(reused)}`);
    assert.deepStrictEqual(SR.tombstones().map((t) => [t.pid, t.via]), [], 'no descendant was recorded for the reused pid (the exited worker tombstone is dropped once nothing alive is left to reach)');
    SR.saveTombstone({ pid: W.pid, created: NOW - 120000, from: NOW - 120000, until: NOW - 100000, kind: 'worker', via: null });
    const inside = await check(terminal(NOW - 100000 + 500))({ conn: tcp() });
    assert.strictEqual(inside.ok, false, `a child created while the worker ran is still its descendant: ${JSON.stringify(inside)}`);
  });
  await withRegistry(async () => {
    // the same for a recorded descendant that has exited: its tombstone bounds its children
    SR.saveTombstone({ pid: 4300, created: NOW - 90000, from: NOW - 90000, until: NOW - 80000, kind: 'descendant', via: 'worker pid 7001' });
    const late = await check({ ...OLD_SHELL, [HELPER]: { ppid: 4300, created: NOW - 60000, image: 'WindowsTerminal.exe' } })({ conn: tcp() });
    assert.strictEqual(late.ok, true, JSON.stringify(late));
  });
});

test('an unreadable spawn history is a refusal, not a pass', async () => {
  await withRegistry(async (dir) => {
    fs.mkdirSync(path.join(dir, 'exited'));
    fs.writeFileSync(path.join(dir, 'exited', '7001-1.json'), '{ not json');
    const v = await check({ ...OLD_SHELL, [HELPER]: { ppid: 9999, created: W.created - 5000, image: 'node.exe' } })({ conn: tcp() });
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /could not be listed.*cannot be read/);
  });
});

const skip = !OC.SUPPORTED && 'bound mode needs the Windows peer check';
const caller = { role: 'operator', run_id: 'run-orphans', pid: process.pid };

test('a bound owner started after the worker refuses its left-behind helper a write, a bind and the worker-kill proof, and serves the same chain without the record', { skip, timeout: 60000 }, async () => {
  await withRegistry(async () => {
    const helper = { ppid: 9999, created: W.created + 5000, image: 'node.exe' };
    const dir = sandbox();
    const ports = new Set();
    const o = new Owner(dir, { embed: false, mode: 'bound', operatorCheckDeps: {
      table: async () => [...ports].map((p) => `  TCP    127.0.0.1:${p}        127.0.0.1:${o.tcpPort}        ESTABLISHED     ${HELPER}\r\n`).join(''),
      snapshot: async () => snap({ ...OLD_SHELL, [HELPER]: helper }),
    } });
    await o.start();
    const clients = [];
    const open = async () => { const c = new Client(dir, { caller, elect: false, connectRetries: 1 }); await c.connect(); clients.push(c); ports.add(c.sock.localPort); return c; };
    try {
      assert.ok(helper.created < o.startedAt, 'the helper is older than this owner');
      const control = await open();
      assert.ok((await control.call('memory.store', { text: 'control write', namespace: 'run/x', embed: false, caller })).id, 'with no worker on record the chain is the operator\'s');
      exitedWorker();
      const c = await open();
      await assert.rejects(() => c.call('memory.store', { text: 'forged write', namespace: 'run/x', embed: false, caller }), (e) => e.code === 'E_UNBOUND' && /descendant of worker pid 7001/.test(e.message));
      const c2 = await open();
      await assert.rejects(() => c2.call('bind.open', { identity: { role: 'orchestrator', run_id: 'run-orphans' }, caller }), (e) => e.code === 'E_UNBOUND');
      assert.strictEqual(o.binds.byId.size, 0, 'no bind was opened');
      const proof = await operatorProof({ isOwner: () => false, dataDir: dir, caller });
      assert.strictEqual(proof.verified, false, `the CLI's worker-kill authorization: ${JSON.stringify(proof)}`);
      const rows = o.store.db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE text LIKE 'forged%'").get().n;
      assert.strictEqual(rows, 0, 'a forged write reached the store');
    } finally { for (const c of clients) await c.close().catch(() => {}); await o.stop().catch(() => {}); cleanup(dir); }
  });
});

test('a helper left behind by a worker that is still running is refused too, and a root older than that worker is not', async () => {
  await withRegistry(async () => {
    SR.register({ pid: process.pid, kind: 'worker', dataDir: 'C:/other/store/.belay', spawnedAt: NOW - 60000 });
    try {
      const refused = await check({ ...OLD_SHELL, [HELPER]: { ppid: 9999, created: NOW - 30000, image: 'node.exe' } })({ conn: tcp() });
      assert.strictEqual(refused.ok, false, JSON.stringify(refused));
      assert.match(refused.reason, new RegExp(`descendant of worker pid ${process.pid} pid ${HELPER}`));
      const older = await check({ [HELPER]: { ppid: 9999, created: NOW - 90000, image: 'node.exe' } })({ conn: tcp() });
      assert.strictEqual(older.ok, true, JSON.stringify(older));
    } finally { SR.unregister(process.pid); }
  });
});
