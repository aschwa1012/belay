'use strict';
// spawn-register-unproven.test.cjs — an unclean Windows reset left two register records of 218 and 219 bytes, every byte NUL: the
// rename had reached the disk and the data had not. The register's read threw on them, and every keyless operator write on the machine
// was refused while they existed. Now one file that cannot be read is "unproven": while the pid its name gives is alive it still counts
// (the refusal names the file); once that pid is gone a writer moves it to corrupt/, never deleting it, and `belay doctor` lists it.
// And a write flushes its temp file before the rename. Every fixture is in this file's own register, never the machine's.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { core, OLD_ROOT_CREATED, ownSpawnRegistry } = require('./helpers.cjs');
const { deadPid } = require('../helpers/dead-pid.cjs');

const SR = core('spawn-register.cjs');
const OC = core('operator-check.cjs');
const Prov = core('spawn-provenance.cjs');

const NUL = Buffer.alloc(218); // the size of one of the files the reset left
const corrupt = (dir) => { try { return fs.readdirSync(path.join(dir, 'corrupt')); } catch { return []; } };
const put = (file, bytes, mtimeMs = null) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  if (mtimeMs != null) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
};

// The operator-check fixture: the peer 4242 under a shell 4000 that began long before the owner, and the check reading this register.
const NOW = Date.now();
const SHELL = 4000;
const snap = () => new Map([[4242, { ppid: SHELL, created: NOW - 5000, image: 'node.exe' }], [SHELL, { ppid: 1, created: OLD_ROOT_CREATED, image: 'pwsh.exe' }]]);
const tableOf = async () => '  TCP    127.0.0.1:52100        127.0.0.1:61000        ESTABLISHED     1234\r\n  TCP    127.0.0.1:61000        127.0.0.1:52100        ESTABLISHED     4242\r\n';
const check = () => OC.create({ startedAt: NOW, spawned: (o) => SR.list(o), provenance: (s, o) => Prov.refresh(s, o), deps: { table: tableOf, snapshot: async () => snap() } });
const peer = () => ({ belayTransport: 'tcp', remotePort: 61000, localPort: 52100 });
const skip = !OC.SUPPORTED && 'bound mode needs the Windows peer check';

async function withRegistry(fn) {
  const reg = ownSpawnRegistry();
  const real = { ...SR.io };
  try { return await fn(reg.dir); } finally { Object.assign(SR.io, real); reg.remove(); }
}

test('an all-NUL and a zero-byte record whose pid is gone are not a throw: a read lists nothing and moves nothing, a writer\'s refresh moves them to corrupt/', () => withRegistry((dir) => {
  const a = put(path.join(dir, `${deadPid()}.json`), NUL);
  const b = put(path.join(dir, `${deadPid()}.json`), Buffer.alloc(0));
  SR.register({ pid: process.pid, kind: 'worker', workerId: 'w1' }); // a good record beside them still lists
  assert.deepStrictEqual(SR.list({ persist: false }).map((r) => r.pid), [process.pid], 'the read before the fix threw "cannot be read" here');
  assert.ok(fs.existsSync(a) && fs.existsSync(b), 'a read writes nothing');
  assert.deepStrictEqual(SR.list().map((r) => r.pid), [process.pid]);
  assert.ok(fs.existsSync(a) && fs.existsSync(b), 'written this boot, they still give a lifetime, so the register\'s own settle keeps them');
  Prov.refresh(new Map([[process.pid, { ppid: 1, created: null, image: 'node.exe' }]]));
  assert.ok(!fs.existsSync(a) && !fs.existsSync(b), 'the refresh read them, then moved both');
  const moved = corrupt(dir);
  assert.strictEqual(moved.length, 2, JSON.stringify(moved));
  assert.ok(moved.some((n) => n.startsWith(path.basename(a))) && moved.some((n) => n.startsWith(path.basename(b))), JSON.stringify(moved));
  assert.ok(fs.readFileSync(path.join(dir, 'corrupt', moved.find((n) => n.startsWith(path.basename(a))))).equals(NUL), 'moved whole, never rewritten');
}));

// The two files the reset left (copies; 218 and 219 bytes, every byte NUL), written before the boot, their pids held again by processes
// of the new session: the read threw on them, so every keyless operator write was refused.
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'spawn-register-nul');
test('the reset\'s own files: a read does not throw, the operator write is accepted, and they are moved to corrupt/ whole', { skip }, () => withRegistry(async (dir) => {
  const before = SR.bootMs() - 10 * 60000;
  const files = ['17300.json', '29332.json'].map((n) => { const f = path.join(dir, n); fs.copyFileSync(path.join(FIXTURES, n), f); fs.utimesSync(f, before / 1000, before / 1000); return f; });
  assert.deepStrictEqual(files.map((f) => fs.statSync(f).size), [218, 219]);
  const held = new Map([...snap(), [17300, { ppid: 1, created: NOW - 60000, image: 'explorer.exe' }], [29332, { ppid: 1, created: NOW - 30000, image: 'svchost.exe' }]]);
  const chk = OC.create({ startedAt: NOW, spawned: (o) => SR.list(o), provenance: (s, o) => Prov.refresh(s, o), deps: { table: tableOf, snapshot: async () => held } });
  assert.deepStrictEqual(SR.list({ snap: held, persist: false }), [], 'before the fix: "spawn register: 17300.json cannot be read"');
  const r = await chk({ conn: peer(), persist: true });
  assert.strictEqual(r.ok, true, `before the fix: refused, "could not be listed"; ${JSON.stringify(r)}`);
  assert.ok(files.every((f) => !fs.existsSync(f)));
  const moved = corrupt(dir).sort();
  assert.deepStrictEqual(moved.map((n) => n.split('.json.')[0]), ['17300', '29332']);
  assert.deepStrictEqual(moved.map((n) => fs.readFileSync(path.join(dir, 'corrupt', n)).equals(fs.readFileSync(path.join(FIXTURES, n.split('.json.')[0] + '.json')))), [true, true]);
}));

test('an all-NUL record whose pid is alive still counts, with no creation time and a kind that names the file', () => withRegistry((dir) => {
  const f = put(path.join(dir, `${process.pid}.json`), NUL);
  const [r, ...rest] = SR.list();
  assert.deepStrictEqual(rest, []);
  assert.strictEqual(r.pid, process.pid);
  assert.strictEqual(r.created, null, 'matched by pid alone');
  assert.ok(r.kind.includes(f) && /all 218 bytes NUL/.test(r.kind), r.kind);
  assert.ok(fs.existsSync(f), 'a live one is never moved');
  assert.deepStrictEqual(corrupt(dir), []);
}));

test('a record written before the boot is gone whatever holds its pid now (the reset): a writer moves it', () => withRegistry((dir) => {
  const f = put(path.join(dir, `${SHELL}.json`), NUL, SR.bootMs() - 10 * 60000);
  const s = SR.scan({ snap: snap() });
  assert.deepStrictEqual(s.live, []);
  assert.strictEqual(s.dead.length, 1);
  assert.strictEqual(s.dead[0].unproven.why, 'all 218 bytes NUL');
  SR.settle(s.dead);
  assert.ok(!fs.existsSync(f));
  assert.strictEqual(corrupt(dir).length, 1);
}));

test('a process younger than the unproven file is a reuse of its pid, not its process', () => withRegistry((dir) => {
  put(path.join(dir, `${SHELL}.json`), NUL, NOW - 60000);
  const young = new Map([[SHELL, { ppid: 1, created: NOW - 1000, image: 'pwsh.exe' }]]);
  assert.strictEqual(SR.scan({ snap: young, boot: 0 }).live.length, 0);
  const old = new Map([[SHELL, { ppid: 1, created: NOW - 120000, image: 'pwsh.exe' }]]);
  assert.strictEqual(SR.scan({ snap: old, boot: 0 }).live.length, 1, 'one older than the file may be the record\'s');
}));

test('the operator check: dead unproven records no longer refuse an operator write, and a writer\'s check moves them', { skip }, () => withRegistry(async (dir) => {
  const a = put(path.join(dir, `${deadPid()}.json`), NUL);
  const b = put(path.join(dir, `${deadPid()}.json`), Buffer.alloc(0));
  const c = put(path.join(dir, `${SHELL}.json`), Buffer.alloc(219), SR.bootMs() - 10 * 60000); // pre-boot, its pid now the shell's
  const t = put(path.join(dir, 'exited', `${deadPid()}-0.json`), NUL);
  const read = await check()({ conn: peer(), persist: false });
  assert.strictEqual(read.ok, true, `before the fix: "could not be listed"; ${JSON.stringify(read)}`);
  assert.ok([a, b, c, t].every((f) => fs.existsSync(f)), 'a read check moves nothing');
  const write = await check()({ conn: peer(), persist: true });
  assert.strictEqual(write.ok, true, JSON.stringify(write));
  assert.ok([a, b, c, t].every((f) => !fs.existsSync(f)), 'a writer\'s check moved them');
  assert.strictEqual(corrupt(dir).length, 4, JSON.stringify(corrupt(dir)));
}));

test('the operator check: an unproven record or tombstone whose pid is alive on the chain refuses, names the file, and stays', { skip }, () => withRegistry(async (dir) => {
  const f = put(path.join(dir, `${SHELL}.json`), NUL);
  const r = await check()({ conn: peer(), persist: true });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes(f) && /descends from a process belay spawned/.test(r.reason) && /all 218 bytes NUL/.test(r.reason), r.reason);
  assert.ok(fs.existsSync(f));
  fs.rmSync(f);
  const t = put(path.join(dir, 'exited', `${SHELL}-0.json`), NUL);
  const r2 = await check()({ conn: peer(), persist: true });
  assert.strictEqual(r2.ok, false, JSON.stringify(r2));
  assert.ok(r2.reason.includes(t), r2.reason);
  assert.ok(fs.existsSync(t), 'a live unproven tombstone is not dropped');
  assert.deepStrictEqual(corrupt(dir), []);
}));

test('a live unproven tombstone whose process then goes is moved aside, never deleted', () => withRegistry((dir) => {
  const t = put(path.join(dir, 'exited', `${SHELL}-0.json`), NUL);
  assert.strictEqual(Prov.refresh(snap()).alive.length, 1);
  assert.deepStrictEqual(Prov.refresh(new Map()).alive, []);
  assert.ok(!fs.existsSync(t));
  assert.strictEqual(corrupt(dir).length, 1);
}));

test('a file a writer made good again before the move stays where it is', () => withRegistry((dir) => {
  const pid = deadPid();
  const f = put(path.join(dir, `${pid}.json`), NUL);
  const s = SR.scan();
  fs.writeFileSync(f, JSON.stringify({ pid, kind: 'worker', at: Date.now() }));
  assert.strictEqual(SR.moveAside(s.dead[0].unproven), null);
  assert.ok(fs.existsSync(f));
  assert.deepStrictEqual(corrupt(dir), []);
}));

test('a good record that lands while the file is moved goes back, through transient refusals; one that cannot go back is a throw', () => withRegistry((dir) => {
  SR.io.sleep = () => {};
  const pid = deadPid();
  const f = put(path.join(dir, `${pid}.json`), NUL);
  const u = SR.scan().dead[0].unproven;
  const realRename = SR.io.rename;
  const good = JSON.stringify({ pid, kind: 'worker', at: Date.now() });
  let calls = 0;
  // the first rename is the move, and a register() for a reused pid has just written the good record under the name
  SR.io.rename = (a, b) => { calls++; if (calls === 1) { fs.writeFileSync(a, good); return realRename(a, b); } if (calls <= 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return realRename(a, b); };
  assert.strictEqual(SR.moveAside(u), null);
  assert.strictEqual(calls, 4, 'two refusals on the way back, then the rename that worked');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), good, 'the good record is back under its name');
  assert.deepStrictEqual(corrupt(dir), []);
  fs.writeFileSync(f, NUL);
  calls = 0;
  SR.io.rename = (a, b) => { calls++; if (calls === 1) { fs.writeFileSync(a, good); return realRename(a, b); } throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  assert.throws(() => SR.moveAside(u), /made good while it was being moved aside and could not be put back/);
  assert.strictEqual(corrupt(dir).length, 1, 'it is in corrupt/, and the throw refuses the check that moved it');
}));

test('a worker whose record is unreadable and gone still covers the helper it started with start /b: refused, then the file is moved', { skip }, () => withRegistry(async (dir) => {
  const W = deadPid(); // the worker: exited, its record (written this boot) now all NUL
  const f = put(path.join(dir, `${W}.json`), NUL, NOW - 30000);
  // the helper's parent is the worker, gone, so the helper's chain ends at itself, at a root older than the owner
  const shot = new Map([[4242, { ppid: W, created: NOW - 20000, image: 'node.exe' }]]);
  const chk = () => OC.create({ startedAt: NOW, spawned: (o) => SR.list(o), provenance: (s, o) => Prov.refresh(s, o), deps: { table: tableOf, snapshot: async () => shot } });
  const r = await chk()({ conn: peer(), persist: true });
  assert.strictEqual(r.ok, false, `before the change: accepted once the file was moved; ${JSON.stringify(r)}`);
  assert.ok(r.reason.includes(f) && /descendant of process named by the unreadable/.test(r.reason), r.reason);
  assert.ok(!fs.existsSync(f) && corrupt(dir).length === 1, 'moved once what it reached is recorded');
  const again = await chk()({ conn: peer(), persist: true });
  assert.strictEqual(again.ok, false, `the helper is now a recorded descendant: ${JSON.stringify(again)}`);
  // a helper created after the file's bound (its write time plus two stamp periods) is not the worker's
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
  put(path.join(dir, `${W}.json`), NUL, NOW - 10 * 60000);
  const late = await chk()({ conn: peer(), persist: false });
  assert.strictEqual(late.ok, true, JSON.stringify(late));
}));

test('a register write flushes its temp file to the disk before the rename', () => withRegistry(() => {
  const events = [];
  const fsync = fs.fsyncSync; const rename = SR.io.rename;
  fs.fsyncSync = (fd) => { events.push('fsync'); return fsync(fd); };
  SR.io.rename = (a, b) => { events.push('rename'); return rename(a, b); };
  try {
    SR.register({ pid: process.pid, kind: 'worker' });
    SR.saveTombstone({ pid: process.pid, created: 1, from: 1, until: 2, kind: 'worker', via: null });
    SR.touch(process.pid, Date.now() + 10 * SR.SEEN_REFRESH_MS);
  } finally { fs.fsyncSync = fsync; }
  assert.deepStrictEqual(events, ['fsync', 'rename', 'fsync', 'rename', 'fsync', 'rename'], 'before the fix: no fsync at all');
}));

test('a crash between the temp write and the rename leaves the old record whole, and the temp file it left is ignored', () => withRegistry((dir) => {
  const old = SR.register({ pid: process.pid, kind: 'worker', workerId: 'old' });
  SR.io.rename = () => { throw Object.assign(new Error('the process ended'), { code: 'ECRASH' }); };
  assert.throws(() => SR.register({ pid: process.pid, kind: 'worker', workerId: 'new' }), (e) => e.code === 'ECRASH');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, `${process.pid}.json`), 'utf8')), old);
  // a process killed there leaves its temp file, unwritten after a power loss
  put(path.join(dir, `${process.pid}.json.${process.pid}.9.zz.tmp`), NUL);
  assert.deepStrictEqual(SR.list().map((r) => r.worker_id), ['old']);
}));

test('doctor names the unproven files and what was moved to corrupt/, and writes nothing', () => withRegistry(async (dir) => {
  const doctor = require(path.join(__dirname, '..', '..', 'src', 'cli', 'cmd-doctor.cjs'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-doctor-reg-'));
  const row = async () => (await doctor.run({ argv: [], cwd: proj, dataDir: `${proj}/.belay`, json: true, fix: false, command: 'doctor' })).json.checks.find((c) => c.check === 'spawn-register');
  try {
    assert.strictEqual((await row()).verdict, 'ok');
    const live = put(path.join(dir, `${process.pid}.json`), NUL);
    const gone = put(path.join(dir, `${deadPid()}.json`), Buffer.alloc(0));
    let r = await row();
    assert.strictEqual(r.verdict, 'error');
    assert.ok(r.evidence.includes(live) && /name a pid a process holds now/.test(r.evidence), r.evidence);
    assert.ok(r.evidence.includes(gone) && /zero bytes/.test(r.evidence) && /next operator write reads a bounded lifetime/.test(r.evidence), r.evidence);
    assert.ok(fs.existsSync(gone) && corrupt(dir).length === 0, 'doctor moved nothing');
    fs.rmSync(live);
    Prov.refresh(new Map()); // a writer's refresh moves the gone one
    r = await row();
    assert.strictEqual(r.verdict, 'error');
    assert.strictEqual(r.moved.length, 1);
    assert.ok(/moved to .*corrupt.* no longer read/.test(r.evidence), r.evidence);
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
}));
