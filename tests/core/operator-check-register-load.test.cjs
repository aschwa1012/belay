'use strict';
// operator-check-register-load.test.cjs — a bound owner's operator check against a spawn register with a long history. Every
// exited process leaves a tombstone, and only a check for a write dropped one; the client asks for its check with a ping (a read)
// first, so on a busy machine none was dropped, and every check read every tombstone with blocking calls on the owner's loop. With
// thousands of them a panel's reads kept the owner from answering its 300 ms ping. The check keeps its order and its one snapshot; it
// now reads a closed tombstone once per process (kept by the file's identity), and the owner prunes closed tombstones itself in two
// passes, never touching a register record (register-prune.cjs).
// A real bound owner, the host tables injected; the register is this file's own. The seams are SR.io (reads counted, a write forced
// between two of them) and the snapshot function; never a clock.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, OLD_ROOT_CREATED, ownSpawnRegistry } = require('./helpers.cjs');

const { Owner } = core('owner.cjs');
const { Client } = core('client.cjs');
const OC = core('operator-check.cjs');
const SR = core('spawn-register.cjs');
const SP = core('spawn-provenance.cjs');

const { dir: REG } = ownSpawnRegistry();
const T0 = Date.now();
const N = 120; // closed tombstones, over the owner's prune threshold
const exited = () => path.join(REG, 'exited');
const skip = !OC.SUPPORTED && 'bound mode needs the Windows peer check';
const tomb = (t) => fs.writeFileSync(path.join(exited(), `${t.pid}-${t.created}.json`), JSON.stringify(t));

// N closed lifetimes (ended half a minute ago, five seconds each), one open descendant, and one closed window that covers a live root.
function plant() {
  fs.rmSync(REG, { recursive: true, force: true });
  fs.mkdirSync(exited(), { recursive: true });
  for (let i = 0; i < N; i++) { const created = T0 - 40e3 + i * 10; tomb({ pid: 100000 + i, created, from: created, until: created + 5e3, kind: 'worker', via: null, via_from: null }); }
  tomb({ pid: 5555, created: T0 - 1000, from: T0 - 1000, until: null, kind: 'descendant', via: 'worker pid 1', via_from: T0 - 2000 });
  tomb({ pid: 6000, created: T0 - 60e3, from: T0 - 60e3, until: T0 - 50e3, kind: 'worker', via: null, via_from: null });
}
// The operator's chain (4242 under an old shell), the open descendant 5555, and 7777, a root created inside window 6000's lifetime.
const SNAP = new Map([
  [4242, { ppid: 4000, created: T0 - 5000, image: 'node.exe' }], [4000, { ppid: 1, created: OLD_ROOT_CREATED, image: 'pwsh.exe' }],
  [5555, { ppid: 1, created: T0 - 1000, image: 'node.exe' }], [7777, { ppid: 1, created: T0 - 55e3, image: 'helper.exe' }],
]);
const LEFT = [`5555-${T0 - 1000}.json`, `7777-${T0 - 55e3}.json`];

async function fixture({ gapMs = null, snapshot = async () => SNAP, peer = 4242 } = {}) {
  const dir = sandbox();
  const ports = new Set();
  const o = new Owner(dir, { embed: false, mode: 'bound', ...(gapMs != null ? { registerPruneGapMs: gapMs } : {}), operatorCheckDeps: {
    table: async () => [...ports].map((p) => `  TCP    127.0.0.1:${p}        127.0.0.1:${o.tcpPort}        ESTABLISHED     ${peer}\r\n`).join(''),
    snapshot,
  } });
  await o.start();
  const clients = [];
  const open = async () => {
    const c = new Client(dir, { caller: { role: 'operator', run_id: 'r', pid: process.pid }, elect: false, connectRetries: 1 });
    await c.connect(); clients.push(c); ports.add(c.sock.localPort); return c;
  };
  // One check on a new connection, as each CLI process makes, then the prune pass it started (null when none).
  const check = async () => { const c = await open(); const before = o.pruner.last; const ok = await c._verifyOperator(); const pass = o.pruner.last; return { ok, reason: c._opReason, pass: pass !== before ? await pass : null }; };
  const done = async () => { for (const c of clients) await c.close().catch(() => {}); await o.stop().catch(() => {}); cleanup(dir); };
  return { o, check, done };
}

// Counts the reads of tombstone files while `fn` runs.
async function countTombstoneReads(fn) {
  const keep = SR.io.read;
  let n = 0;
  SR.io.read = (p) => { if (path.dirname(p) === exited()) n++; return keep(p); };
  try { await fn(); } finally { SR.io.read = keep; }
  return n;
}

test('a later check reads only the tombstones that are new or changed, not the whole history', { skip, timeout: 60000 }, async () => {
  plant();
  const f = await fixture();
  try {
    const one = await countTombstoneReads(async () => assert.strictEqual((await f.check()).ok, true));
    assert.ok(one >= N + 2, `the first check read ${one}`);
    const two = await countTombstoneReads(async () => assert.strictEqual((await f.check()).ok, true));
    // the open descendant 5555 and the root the first prune pass recorded (7777) are open: read each time; the closed ones are not
    assert.strictEqual(two, 2, `the second check read ${two} tombstone files; only the two open ones are read again`);
    const created = T0 - 39e3; // a closed tombstone replaced under its name is read again
    tomb({ pid: 100000, created: T0 - 40e3, from: T0 - 40e3, until: created, kind: 'worker', via: null, via_from: null });
    const three = await countTombstoneReads(async () => assert.strictEqual((await f.check()).ok, true));
    assert.strictEqual(three, 3, `after one file was rewritten the check read ${three}`);
  } finally { await f.done(); }
});

test('closed tombstones are dropped in two passes: the first records what they cover and marks them, the second drops them', { skip, timeout: 60000 }, async () => {
  plant();
  const f = await fixture({ gapMs: 0 });
  try {
    const one = await f.check();
    assert.ok(one.pass, 'the owner started no prune after a check that found more than a hundred closed tombstones');
    assert.deepStrictEqual([one.pass.dropped, one.pass.saved, one.pass.marked], [0, 1, N + 1], JSON.stringify(one.pass));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(exited(), `7777-${T0 - 55e3}.json`), 'utf8')).via, 'worker pid 6000');
    assert.strictEqual(fs.readdirSync(exited()).length, N + 3);
    const two = await f.check();
    assert.strictEqual(two.pass.dropped, N + 1, JSON.stringify(two.pass));
    assert.deepStrictEqual(fs.readdirSync(exited()).sort(), LEFT, 'only the open descendant and the recorded root stay');
    assert.strictEqual((await f.check()).pass, null, 'nothing closed is left: no further pass');
  } finally { await f.done(); }
});

test('the prune never touches a register record: one written mid-prune, and one whose process is gone, all stay', async () => {
  plant();
  const { createPruner } = core('register-prune.cjs');
  SR.register({ pid: 9010, kind: 'worker', created: T0 - 30e3, spawnedAt: T0 - 30e3 }); // its process is in no snapshot below
  // workers of another store spawn while a pass runs, and are in no snapshot it takes: 9001 during its tombstone reads, 9003 while
  // it waits for its snapshot
  const keep = { read: SR.io.read, readAsync: SR.io.readAsync };
  let duringRead = false;
  const spawnOne = (p) => { if (!duringRead && path.dirname(p) === exited()) { duringRead = true; SR.register({ pid: 9001, kind: 'worker', created: Date.now(), spawnedAt: Date.now() }); } };
  SR.io.read = (p) => { spawnOne(p); return keep.read(p); };
  if (keep.readAsync) SR.io.readAsync = (p) => { spawnOne(p); return keep.readAsync(p); };
  let duringSnap = false;
  const snapshot = async () => { if (!duringSnap) { duringSnap = true; SR.register({ pid: 9003, kind: 'worker', created: Date.now(), spawnedAt: Date.now() }); } return SNAP; };
  try {
    const p = createPruner({ snapshot, gapMs: 0 });
    await p.note(N); await p.note(N);
  } finally { Object.assign(SR.io, keep); }
  assert.ok(duringRead && duringSnap, 'a seam never ran');
  for (const pid of [9001, 9003, 9010]) assert.ok(fs.existsSync(path.join(REG, `${pid}.json`)), `the register record of ${pid} was removed by the prune`);
  assert.ok(!fs.readdirSync(exited()).some((n) => /^90(01|03|10)-/.test(n)), 'the prune wrote a tombstone for a register record');
});

test('a worker that retires while a check reads the tombstones is still seen: its orphan is refused', async () => {
  plant();
  const C = T0 - 20e3;
  const snapB = new Map([[9002, { ppid: 1, created: C, image: 'w' }], [9100, { ppid: 777, created: C + 1000, image: 'orphan' }]]);
  const retireDuring = (seam) => {
    SR.register({ pid: 9002, kind: 'worker', created: C, spawnedAt: C });
    const keep = SR.io.read;
    let once = true;
    if (seam === 'read') SR.io.read = (p) => { if (once && path.dirname(p) === exited()) { once = false; SR.unregister(9002); } return keep(p); };
    try { return SP.refresh(snapB, { persist: false, ...(seam === 'afterScan' ? { afterScan: () => SR.unregister(9002) } : {}) }); } finally { SR.io.read = keep; }
  };
  for (const seam of ['afterScan', 'read']) {
    const r = retireDuring(seam);
    assert.ok(r.alive.some((a) => a.pid === 9100 && /descendant of worker pid 9002/.test(a.kind)), `${seam}: ${JSON.stringify(r.alive)}`);
    for (const n of fs.readdirSync(exited()).filter((x) => x.startsWith('9002-'))) fs.unlinkSync(path.join(exited(), n));
  }
});

test('a worker that retires while the owner\'s check reads the tombstones is still seen: a peer under its orphan is refused', { skip, timeout: 60000 }, async () => {
  plant();
  const C = T0 - 20e3;
  // 9100 is a root (its parent 777 is gone) created while worker 9002 ran; 9002 retires during the check's first tombstone read
  const snapB = new Map([[9002, { ppid: 1, created: C, image: 'w' }], [9100, { ppid: 777, created: C + 1000, image: 'orphan' }]]);
  SR.register({ pid: 9002, kind: 'worker', created: C, spawnedAt: C });
  const keep = { read: SR.io.read, readAsync: SR.io.readAsync };
  let once = true;
  const retire = (p) => { if (once && path.dirname(p) === exited()) { once = false; SR.unregister(9002); } };
  SR.io.read = (p) => { retire(p); return keep.read(p); };
  if (keep.readAsync) SR.io.readAsync = (p) => { retire(p); return keep.readAsync(p); };
  const f = await fixture({ snapshot: async () => snapB, peer: 9100 });
  try {
    const r = await f.check();
    assert.strictEqual(once, false, 'the seam never ran: the check read no tombstone');
    assert.strictEqual(r.ok, false, 'the orphan of a worker that retired mid-check was taken for the operator');
    assert.match(String(r.reason), /descendant of worker pid 9002/);
  } finally { Object.assign(SR.io, keep); await f.done(); }
});

test('a pass touches no file in the turn of the check that started it, and never blocks on a read', async () => {
  plant();
  const { createPruner } = core('register-prune.cjs');
  const keep = { ...SR.io };
  const seen = { sync: 0, async: 0 };
  const inExited = (p) => path.dirname(p) === exited() || p === exited();
  for (const k of ['read', 'stat']) SR.io[k] = (p, ...a) => { if (inExited(p)) seen.sync++; return keep[k](p, ...a); };
  for (const k of ['readAsync', 'statAsync', 'readdirAsync']) SR.io[k] = (p, ...a) => { if (inExited(p)) seen.async++; return keep[k](p, ...a); };
  try {
    const p = createPruner({ snapshot: async () => SNAP, gapMs: 0 });
    const pass = p.note(N);
    for (let i = 0; i < 50; i++) await null; // every microtask the check's reply could be waiting behind
    assert.deepStrictEqual(seen, { sync: 0, async: 0 }, 'the pass listed or read the register before the check that started it could answer');
    await pass;
    assert.strictEqual(seen.sync, 0, `the pass made ${seen.sync} blocking file calls on the register`);
    assert.ok(seen.async > N, 'the pass read the register');
  } finally { Object.assign(SR.io, keep); }
});

test('an open tombstone from before the last boot is dropped by the prune; one from this boot stays', async () => {
  plant();
  const { createPruner } = core('register-prune.cjs');
  const old = SR.bootMs() - 3600e3;
  tomb({ pid: 5600, created: old, from: old, until: null, kind: 'descendant', via: 'worker pid 2', via_from: old - 1000 });
  const p = createPruner({ snapshot: async () => SNAP, gapMs: 0 });
  assert.strictEqual((await p.note(N)).marked, N + 2);
  assert.strictEqual((await p.note(N)).dropped, N + 2);
  assert.deepStrictEqual(fs.readdirSync(exited()).sort(), LEFT, 'the pre-boot descendant went; the open one from this boot and the recorded root stay');
});

test('two owners pruning one register at once both finish, and the recorded root stays', async () => {
  plant();
  const { createPruner } = core('register-prune.cjs');
  const a = createPruner({ snapshot: async () => SNAP, gapMs: 0 });
  const b = createPruner({ snapshot: async () => SNAP, gapMs: 0 });
  const first = await Promise.all([a.note(N), b.note(N)]);
  assert.deepStrictEqual(first.map((r) => r.dropped), [0, 0], JSON.stringify(first));
  const second = await Promise.all([a.note(N), b.note(N)]);
  assert.ok(second.every((r) => !r.error), JSON.stringify(second));
  assert.deepStrictEqual(fs.readdirSync(exited()).sort(), LEFT);
});

test('within one gap nothing is dropped, and a register with few closed tombstones is left as it is', { skip, timeout: 60000 }, async () => {
  plant();
  const f = await fixture();
  try {
    assert.strictEqual((await f.check()).pass.dropped, 0);
    for (let i = 0; i < 3; i++) assert.strictEqual((await f.check()).pass, null, 'a second pass inside the gap');
    assert.strictEqual(fs.readdirSync(exited()).length, N + 3);
  } finally { await f.done(); }
  fs.rmSync(REG, { recursive: true, force: true });
  fs.mkdirSync(exited(), { recursive: true });
  tomb({ pid: 100000, created: T0 - 3600e3, from: T0 - 3600e3, until: T0 - 3500e3, kind: 'worker', via: null, via_from: null });
  const g = await fixture({ gapMs: 0 });
  try {
    assert.strictEqual((await g.check()).pass, null, 'one closed tombstone starts no prune');
    assert.strictEqual(fs.readdirSync(exited()).length, 1, 'a read\'s check wrote nothing');
  } finally { await g.done(); }
});
