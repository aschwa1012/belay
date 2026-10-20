'use strict';
// operator-check.test.cjs — ADR 0045 decision 4: an operator is checked by its process, not believed. Part one drives the rules with
// injected tables and snapshots (no operating system involved); part two drives them over a real loopback connection to a real
// `bound` owner, with real processes as the callers: an ordinary child is accepted, one that descends from a process belay spawned is
// refused, an orphan is refused, and the same claim on the pipe is refused. The forgery is the audit's (D06): an unkeyed request that
// names the operator.

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup } = require('./helpers.cjs');

const OC = core('operator-check.cjs');
const { Owner } = core('owner.cjs');

const NETSTAT = [
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    127.0.0.1:52100        127.0.0.1:61000        ESTABLISHED     1234',
  '  TCP    127.0.0.1:61000        127.0.0.1:52100        ESTABLISHED     5678',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       900',
].join('\r\n');

test('parseNetstat reads the established loopback rows and skips the headings', () => {
  const rows = OC.parseNetstat(NETSTAT);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[1], { laddr: '127.0.0.1', lport: 61000, faddr: '127.0.0.1', fport: 52100, state: 'ESTABLISHED', pid: 5678 });
});

test('peerPid finds the process that owns the client end, and fails closed on a missing, shared or unreadable answer', async () => {
  const conn = { remotePort: 61000, localPort: 52100 }; // the owner's view: the client is at 61000
  assert.deepStrictEqual(await OC.peerPid(conn, async () => NETSTAT), { pid: 5678 });
  assert.match((await OC.peerPid({ remotePort: 61999, localPort: 52100 }, async () => NETSTAT)).reason, /not in the connection table/);
  assert.match((await OC.peerPid(conn, async () => null)).reason, /could not be read/);
  assert.match((await OC.peerPid({}, async () => NETSTAT)).reason, /no ports/);
  const two = NETSTAT + '\r\n  TCP    127.0.0.1:61000        127.0.0.1:52100        ESTABLISHED     4242';
  assert.match((await OC.peerPid(conn, async () => two)).reason, /2 owners/);
});

const snap = (o) => new Map(Object.entries(o).map(([pid, v]) => [Number(pid), v]));

test('chainOf follows parents that are in the snapshot and no younger than their child, and stops at a missing or younger one', () => {
  const s = snap({ 10: { ppid: 5, created: 300, image: 'node.exe' }, 5: { ppid: 2, created: 200, image: 'pwsh.exe' }, 2: { ppid: 1, created: 100, image: 'explorer.exe' } });
  const c = OC.chainOf(10, s);
  assert.deepStrictEqual(c.chain.map((p) => p.pid), [10, 5, 2]);
  assert.strictEqual(c.root.pid, 2);
  assert.strictEqual(c.intact, true);
  // a recycled parent pid names a process born after the child: the link is not valid, the child is its own root
  const recycled = snap({ 10: { ppid: 5, created: 300, image: 'node.exe' }, 5: { ppid: 2, created: 900, image: 'other.exe' } });
  assert.strictEqual(OC.chainOf(10, recycled).root.pid, 10);
  // a loop, and a process not in the snapshot, are not an intact chain
  assert.strictEqual(OC.chainOf(10, snap({ 10: { ppid: 5, created: 300 }, 5: { ppid: 10, created: 300 } })).intact, false);
  assert.strictEqual(OC.chainOf(77, s).intact, false);
});

const T0 = 1000; // the owner started at 1000
const base = { 10: { ppid: 5, created: 1500, image: 'node.exe' }, 5: { ppid: 2, created: 500, image: 'pwsh.exe' }, 2: { ppid: 1, created: 100, image: 'explorer.exe' } };
const tcp = (extra = {}) => ({ belayTransport: 'tcp', remotePort: 61000, localPort: 52100, ...extra });
const table = async () => NETSTAT.replace(/5678/g, '10');
function check(shot, spawned = []) {
  return OC.create({ startedAt: T0, spawned: () => spawned, deps: { table, snapshot: async () => snap(shot) } });
}

test('the check accepts a chain that is intact to a root older than the owner, and keeps the verdict for the connection', async () => {
  const conn = tcp();
  const v = await check(base)({ conn });
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual([v.via, v.peer.pid, v.peer.root.pid], ['peer', 10, 2]);
  const again = await OC.create({ startedAt: T0, spawned: () => [], deps: { table: async () => { throw new Error('asked twice'); }, snapshot: async () => { throw new Error('asked twice'); } } })({ conn });
  assert.strictEqual(again.ok, true, 'a verified connection is not examined again');
});

test('the check refuses a peer that descends from a process belay spawned, by pid and creation time', async () => {
  const v = await check(base, [{ pid: 5, created: 500, kind: 'worker' }])({ conn: tcp() });
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /descends from a process belay spawned \(worker pid 5/);
  // the same pid with another creation time is a recycled pid, not the worker
  assert.strictEqual((await check(base, [{ pid: 5, created: 123, kind: 'worker' }])({ conn: tcp() })).ok, true);
  // a record with no creation time matches by pid alone: fail closed
  assert.strictEqual((await check(base, [{ pid: 5, created: null, kind: 'orchestrator' }])({ conn: tcp() })).ok, false);
});

test('the check refuses an orphan: a chain whose root was created after the owner started', async () => {
  const orphan = { 10: { ppid: 5, created: 1500, image: 'node.exe' } }; // the parent has exited: not in the snapshot
  const v = await check(orphan)({ conn: tcp() });
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /not running when this owner started/);
});

test('the check fails closed on a pipe, an unreadable table or snapshot, and a peer the snapshot does not hold', async () => {
  assert.match((await check(base)({ conn: { ...tcp(), belayTransport: undefined } })).reason, /loopback port/);
  const noTable = OC.create({ startedAt: T0, spawned: () => [], deps: { table: async () => null, snapshot: async () => snap(base) } });
  assert.match((await noTable({ conn: tcp() })).reason, /could not be read/);
  const noSnap = OC.create({ startedAt: T0, spawned: () => [], deps: { table, snapshot: async () => null } });
  assert.match((await noSnap({ conn: tcp() })).reason, /snapshot could not be read/);
  assert.match((await check({ 99: { ppid: 1, created: 1 } })({ conn: tcp() })).reason, /not in the process snapshot/);
});

// ---- the operating system: a real owner, a real loopback client, real processes ----------------------------------------

const CLIENT = path.join(__dirname, '..', 'helpers', 'raw-claim.cjs');

// Runs tests/helpers/raw-claim.cjs <port|pipe> <mode> and returns the owner's parsed answer.
function viaChild(target, mode, extra) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [CLIENT, String(target), mode, ...(extra ? [extra] : [])], { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let errOut = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { errOut += d; });
    c.on('close', () => { if (mode === 'orphan') return resolve(null); try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { reject(new Error(`no answer: ${out} ${errOut}`)); } });
  });
}

async function withBound(opts, fn) {
  const dir = sandbox();
  const o = new Owner(dir, { embed: false, mode: 'bound', ...opts });
  await o.start();
  try { return await fn(o, dir); } finally { await o.stop().catch(() => {}); cleanup(dir); }
}

test('the owner publishes its loopback port beside the pipe, and says it serves bound callers', { skip: process.platform !== 'win32' && 'the peer check reads Windows tools' }, async () => {
  await withBound({}, async (o, dir) => {
    assert.ok(Number.isInteger(o.tcpPort) && o.tcpPort > 0);
    const lock = core('lock.cjs').readOwnerLock(dir);
    assert.strictEqual(lock.mode, 'bound');
    assert.strictEqual(lock.tcp_port, o.tcpPort);
    await new Promise((resolve, reject) => { const s = net.connect({ host: '127.0.0.1', port: o.tcpPort }, () => { s.destroy(); resolve(); }); s.on('error', reject); });
  });
});

test('an ordinary child that claims the operator on the loopback port is vouched for by its process; the same claim on the pipe is refused', { skip: process.platform !== 'win32' && 'the peer check reads Windows tools', timeout: 60000 }, async () => {
  await withBound({}, async (o) => {
    const ok = await viaChild(o.tcpPort, 'tcp');
    assert.ok(ok.result && ok.result.id, JSON.stringify(ok));
    assert.strictEqual(ok.result.written_by, 'operator');
    const onPipe = await viaChild(o.pipe, 'pipe');
    assert.strictEqual(onPipe.error && onPipe.error.code, 'E_UNBOUND', JSON.stringify(onPipe));
    assert.strictEqual(onPipe.error.detail.reason, 'operator_check');
  });
});

test('a child that descends from a process belay spawned is refused, however it claims', { skip: process.platform !== 'win32' && 'the peer check reads Windows tools', timeout: 60000 }, async () => {
  // this test process stands in for a worker: the owner is told it spawned it, and the child is its descendant
  await withBound({ spawnedProcesses: () => [{ pid: process.pid, created: null, kind: 'worker' }] }, async (o) => {
    const forged = await viaChild(o.tcpPort, 'tcp');
    assert.strictEqual(forged.error && forged.error.code, 'E_UNBOUND', JSON.stringify(forged));
    assert.match(forged.error.message, /descends from a process belay spawned \(worker pid \d+/);
    const bind = await viaChild(o.tcpPort, 'bind');
    assert.strictEqual(bind.error && bind.error.code, 'E_UNBOUND', `bind.open as a forged operator: ${JSON.stringify(bind)}`);
    assert.strictEqual(o.binds.byId.size, 0, 'and no bind was opened');
  });
});

test('a read open to every role takes the operator check when the operator claims it: a verified operator is not downgraded to a worker, a refused claim is', { skip: process.platform !== 'win32' && 'the peer check reads Windows tools', timeout: 60000 }, async () => {
  await withBound({}, async (o) => {
    // another run's namespace is the operator's to read; a worker-shaped caller is refused it by role (the owner has no embedder, so the search is keyword-only)
    const op = await viaChild(o.tcpPort, 'search');
    assert.ok(op.result && !op.error, `the operator's search must pass the role check: ${JSON.stringify(op)}`);
  });
  await withBound({ spawnedProcesses: () => [{ pid: process.pid, created: null, kind: 'worker' }] }, async (o) => {
    const forged = await viaChild(o.tcpPort, 'search');
    assert.strictEqual(forged.error && forged.error.code, 'E_ROLE', `a refused claim is served as the anonymous worker it is: ${JSON.stringify(forged)}`);
  });
});

test('an orphan (a detached grandchild whose parent has exited) is refused: its chain ends at a process younger than the owner', { skip: process.platform !== 'win32' && 'the peer check reads Windows tools', timeout: 60000 }, async () => {
  await withBound({}, async (o, dir) => {
    const out = path.join(dir, 'orphan-answer.json');
    await viaChild(o.tcpPort, 'orphan', out); // the helper exits at once; its detached copy answers into the file
    const t0 = Date.now();
    while (!fs.existsSync(out) && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 100));
    const r = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(r.error && r.error.code, 'E_UNBOUND', JSON.stringify(r));
    assert.match(r.error.message, /not running when this owner started/);
  });
});

test('a child of the headless orchestrator is refused as the operator, listed by the run process or by the spawn register (the interactive orchestrator lists neither)', { skip: process.platform !== 'win32' && 'the peer check reads Windows tools', timeout: 120000 }, async () => {
  // this test process stands in for the headless orchestrator; belay run lists it two ways (cmd-run.cjs spawnedProcesses, and its spawn-register record)
  await withBound({ spawnedProcesses: () => [{ pid: process.pid, created: null, kind: 'orchestrator' }] }, async (o) => {
    const forged = await viaChild(o.tcpPort, 'tcp');
    assert.strictEqual(forged.error && forged.error.code, 'E_UNBOUND', JSON.stringify(forged));
    assert.match(forged.error.message, /descends from a process belay spawned \(orchestrator pid \d+/);
    const bind = await viaChild(o.tcpPort, 'bind');
    assert.strictEqual(bind.error && bind.error.code, 'E_UNBOUND', `bind.open as a forged operator: ${JSON.stringify(bind)}`);
    assert.strictEqual(o.binds.byId.size, 0, 'and no bind was opened');
  });
  const SR = core('spawn-register.cjs');
  await withBound({}, async (o) => {
    SR.register({ pid: process.pid, kind: 'orchestrator', dataDir: 'C:/some/other/store/.belay' });
    try {
      const forged = await viaChild(o.tcpPort, 'tcp');
      assert.strictEqual(forged.error && forged.error.code, 'E_UNBOUND', JSON.stringify(forged));
      assert.match(forged.error.message, /orchestrator pid \d+/);
    } finally { SR.unregister(process.pid); }
  });
  await withBound({ spawnedProcesses: () => [] }, async (o) => { // control: the interactive orchestrator is listed nowhere, so its child is the operator
    const ok = await viaChild(o.tcpPort, 'tcp');
    assert.strictEqual(ok.result && ok.result.written_by, 'operator', JSON.stringify(ok));
  });
});
