'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', '..', 'src', 'core');
const { sweep, PARENT } = require(path.join(SRC, 'copy-sweep.cjs'));
const { withCopy } = require(path.join(SRC, 'copy-read.cjs'));

const ls = d => { try { return fs.readdirSync(d).filter(n => !n.startsWith('.')); } catch { return []; } };
const mkroot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'belay-sweep-test-'));
function entry(root, name, ageMs) {
  const p = path.join(root, PARENT, name);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'memory.db'), 'x');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
  return p;
}
function legacy(root, name, ageMs) {
  const p = path.join(root, name);
  fs.mkdirSync(p, { recursive: true });
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
  return p;
}
// A pid that is certainly dead: a child that has exited.
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;
const MIN = 60 * 1000, DAY = 24 * 60 * MIN;

test('dead-pid entry older than 60 s is removed; live-pid, fresh and own entries are kept', () => {
  const root = mkroot();
  try {
    const dead = deadPid();
    const old = entry(root, `${dead}-aaaaaa`, 5 * MIN);
    const fresh = entry(root, `${dead}-bbbbbb`, 1000);
    const live = entry(root, `${process.ppid}-cccccc`, 5 * MIN);
    const own = entry(root, `${process.pid}-dddddd`, 5 * MIN);
    sweep(root);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(fresh), true);
    assert.equal(fs.existsSync(live), true);
    assert.equal(fs.existsSync(own), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the sweep examines at most 20 entries', () => {
  const root = mkroot();
  try {
    const dead = deadPid();
    const ps = [];
    for (let i = 0; i < 30; i++) ps.push(entry(root, `${dead}-${String(i).padStart(6, 'a')}`, 5 * MIN));
    const r = sweep(root);
    assert.equal(r.examined, 20);
    assert.equal(ps.filter(p => !fs.existsSync(p)).length, 20);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a sweep error does not fail the read', async () => {
  const root = mkroot();
  const prev = process.env.BELAY_RO_TMP_ROOT;
  try {
    // belay-ro as a file makes the sweep's readdir fail; the legacy scan is fine.
    process.env.BELAY_RO_TMP_ROOT = root;
    const dead = deadPid();
    const p = entry(root, `${dead}-aaaaaa`, 5 * MIN);
    const realRm = fs.rmSync;
    fs.rmSync = (q, o) => { if (q === p) throw new Error('boom'); return realRm(q, o); };
    try {
      const got = await withCopy(root, async (dst, how) => how);
      assert.equal(got, 'none');
    } finally { fs.rmSync = realRm; }
    assert.doesNotThrow(() => sweep(path.join(root, 'does', 'not', 'exist')));
  } finally {
    if (prev === undefined) delete process.env.BELAY_RO_TMP_ROOT; else process.env.BELAY_RO_TMP_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a read killed mid-read leaves an entry; the next read in another process removes it once old', async () => {
  const root = mkroot();
  const script = path.join(root, 'reader.cjs').replace(/\\/g, '/');
  fs.writeFileSync(script, `
const { withCopy } = require(${JSON.stringify(path.join(SRC, 'copy-read.cjs').replace(/\\/g, '/'))});
withCopy(process.argv[2], async () => { if (process.argv[3] === 'hang') { console.log('ready'); await new Promise(() => {}); } });
`);
  const env = { ...process.env, BELAY_RO_TMP_ROOT: root };
  try {
    const child = spawn(process.execPath, [script, root, 'hang'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    const ready = await new Promise(res => { child.stdout.once('data', () => res(true)); child.once('exit', () => res(false)); });
    assert.equal(ready, true, 'the reader reached its hang point');
    const killedPid = child.pid;
    const exited = new Promise(res => child.once('exit', res));
    child.kill();
    await exited;
    const parent = path.join(root, PARENT);
    const left = ls(parent);
    assert.equal(left.length, 1);
    assert.ok(left[0].startsWith(`${killedPid}-`));
    // Fresh: a second reader keeps it.
    assert.equal(spawnSync(process.execPath, [script, root, 'ok'], { env }).status, 0);
    assert.deepEqual(ls(parent), left);
    // Aged past 60 s: the next reader removes it.
    const t = new Date(Date.now() - 5 * MIN);
    fs.utimesSync(path.join(parent, left[0]), t, t);
    assert.equal(spawnSync(process.execPath, [script, root, 'ok'], { env }).status, 0);
    assert.deepEqual(ls(parent), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stuck live entries at the front do not starve the dead ones behind them', () => {
  const root = mkroot();
  try {
    const dead = deadPid();
    for (let i = 0; i < 25; i++) entry(root, `${process.ppid}-live${String(i).padStart(2, '0')}`, 5 * MIN);
    const old = entry(root, `${dead}-zzzzzz`, 5 * MIN);
    const r = sweep(root);
    assert.equal(fs.existsSync(old), false);
    assert.equal(r.examined, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a read leaves only the persistent empty belay-ro parent in the temp root', async () => {
  const root = mkroot();
  const prev = process.env.BELAY_RO_TMP_ROOT;
  process.env.BELAY_RO_TMP_ROOT = root;
  try {
    assert.deepEqual(fs.readdirSync(root), []);
    await withCopy(root, async () => 0);
    assert.deepEqual(fs.readdirSync(root), [PARENT]);
    assert.deepEqual(fs.readdirSync(path.join(root, PARENT)), []);
    await assert.rejects(withCopy(root, async () => { throw new Error('read failed'); }));
    assert.deepEqual(fs.readdirSync(root), [PARENT]);
    assert.deepEqual(fs.readdirSync(path.join(root, PARENT)), []);
  } finally {
    if (prev === undefined) delete process.env.BELAY_RO_TMP_ROOT; else process.env.BELAY_RO_TMP_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a non-empty belay-ro parent is left alone by a read; legacy dirs are never touched', async () => {
  const root = mkroot();
  const prev = process.env.BELAY_RO_TMP_ROOT;
  process.env.BELAY_RO_TMP_ROOT = root;
  try {
    const other = entry(root, `${process.ppid}-keepme`, 5 * MIN);
    const old = legacy(root, 'belay-ro-Ab3dE9', 2 * DAY);
    await withCopy(root, async () => 0);
    assert.equal(fs.existsSync(other), true);
    assert.equal(fs.existsSync(old), true);
  } finally {
    if (prev === undefined) delete process.env.BELAY_RO_TMP_ROOT; else process.env.BELAY_RO_TMP_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const { makeTmpDir } = require(path.join(SRC, 'copy-read.cjs'));

test('makeTmpDir retries EPERM, EACCES and ENOENT with a backoff, then succeeds', () => {
  const codes = ['EPERM', 'ENOENT', 'EACCES'];
  const sleeps = [];
  let mkdirs = 0;
  const fsx = {
    mkdirSync() { mkdirs++; },
    mkdtempSync(prefix) {
      const code = codes.shift();
      if (code) throw Object.assign(new Error(code), { code });
      return prefix + 'abcdef';
    },
  };
  const got = makeTmpDir(path.join('x', PARENT), fsx, ms => sleeps.push(ms));
  assert.match(got, /abcdef$/);
  assert.equal(mkdirs, 4);
  assert.equal(sleeps.length, 3);
  [5, 10, 20].forEach((nominal, i) => assert.ok(sleeps[i] >= nominal / 2 - 1 && sleeps[i] <= nominal, 'backoff ' + i + ' was ' + sleeps[i]));
});

test('makeTmpDir stops after the bounded retries and throws the real error; other errors are not retried', () => {
  const sleeps = [];
  const eperm = { mkdirSync() { throw Object.assign(new Error('x'), { code: 'EPERM' }); }, mkdtempSync() {} };
  assert.throws(() => makeTmpDir('p', eperm, ms => sleeps.push(ms)), { code: 'EPERM' });
  assert.ok(sleeps.length >= 5 && sleeps.length <= 7);
  assert.ok(sleeps.reduce((a, b) => a + b, 0) <= 300);
  const enospc = { mkdirSync() { throw Object.assign(new Error('x'), { code: 'ENOSPC' }); }, mkdtempSync() {} };
  const s2 = [];
  assert.throws(() => makeTmpDir('p', enospc, ms => s2.push(ms)), { code: 'ENOSPC' });
  assert.deepEqual(s2, []);
});

test('stress: 8 processes x 200 concurrent reads under one temp root, zero failures', async () => {
  const root = mkroot();
  const script = path.join(root, 'stress.cjs').replace(/\\/g, '/');
  fs.writeFileSync(script, `
const { withCopy } = require(${JSON.stringify(path.join(SRC, 'copy-read.cjs').replace(/\\/g, '/'))});
(async () => { let bad = 0;
  for (let i = 0; i < 200; i++) { try { await withCopy(process.argv[2], async () => 0); } catch (e) { bad++; console.error(e.code, e.message); } }
  process.exit(bad ? 1 : 0); })();
`);
  const env = { ...process.env, BELAY_RO_TMP_ROOT: root };
  try {
    const codes = await Promise.all(Array.from({ length: 8 }, () => new Promise(res => {
      const c = spawn(process.execPath, [script, root], { env, stdio: ['ignore', 'ignore', 'inherit'] });
      c.once('exit', code => res(code));
    })));
    assert.deepEqual(codes, [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(ls(path.join(root, PARENT)), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('withCopy creates its copy under belay-ro/<pid>-<random> and still cleans up', async () => {
  const root = mkroot();
  const prev = process.env.BELAY_RO_TMP_ROOT;
  process.env.BELAY_RO_TMP_ROOT = root;
  try {
    let seen;
    // The own copy is removed synchronously in the finally: gone at the moment the read resolves.
    let goneAtResolve;
    await withCopy(root, async dst => { seen = path.dirname(dst); }).then(() => { goneAtResolve = !fs.existsSync(seen); });
    assert.equal(goneAtResolve, true);
    assert.equal(path.dirname(seen), path.join(root, PARENT));
    assert.match(path.basename(seen), new RegExp(`^${process.pid}-[A-Za-z0-9]{6}$`));
    assert.equal(fs.existsSync(seen), false);
  } finally {
    if (prev === undefined) delete process.env.BELAY_RO_TMP_ROOT; else process.env.BELAY_RO_TMP_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
