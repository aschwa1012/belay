'use strict';
// spawn-register-write.test.cjs — the register is written by many processes at once, and on Windows a rename onto a file another
// process has open answers EPERM, EBUSY or EACCES for a moment. A transient refusal is retried, a target that already holds the same
// text is a success, a temp name is never shared, and a reader meeting the same refusal retries. The fault is injected through the
// module's `io` seam so the interleaving is the test's, not the machine's.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { core } = require('./helpers.cjs');

const SR = core('spawn-register.cjs');

async function withRegistry(fn) {
  const keep = process.env.BELAY_SPAWN_REGISTRY;
  const real = { ...SR.io };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-spawn-register-w-'));
  process.env.BELAY_SPAWN_REGISTRY = dir;
  SR.io.sleep = () => {}; // the backoff is not what is under test
  try { return await fn(dir); } finally { Object.assign(SR.io, real); process.env.BELAY_SPAWN_REGISTRY = keep; fs.rmSync(dir, { recursive: true, force: true }); }
}
const errno = (code) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
const strays = (dir) => [dir, path.join(dir, 'exited')].flatMap((d) => { try { return fs.readdirSync(d).filter((n) => n.endsWith('.tmp')); } catch { return []; } });

test('a record write retried through EPERM on the first renames still lands, and leaves no temp file', () => withRegistry((dir) => {
  const realRename = SR.io.rename; let calls = 0;
  SR.io.rename = (a, b) => { if (++calls <= 3) throw errno('EPERM'); return realRename(a, b); };
  const rec = SR.register({ pid: process.pid, kind: 'worker', workerId: 'w1' });
  assert.strictEqual(calls, 4, 'three refusals, then the rename that worked');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, `${process.pid}.json`), 'utf8')), rec);
  assert.deepStrictEqual(strays(dir), []);
}));

test('EBUSY and EACCES are retried the same way, and a refusal that is not transient is not retried', () => withRegistry((dir) => {
  const realRename = SR.io.rename;
  // One pid per code: a record carries its write time to the millisecond, so a second write of one pid's record within the same
  // millisecond is the same text, which is rightly taken as already written and is not retried.
  for (const [k, code] of ['EBUSY', 'EACCES'].entries()) {
    let calls = 0;
    SR.io.rename = (a, b) => { if (++calls === 1) throw errno(code); return realRename(a, b); };
    SR.register({ pid: process.pid + k });
    assert.strictEqual(calls, 2, code);
  }
  let calls = 0;
  SR.io.rename = () => { calls++; throw errno('ENOSPC'); };
  assert.throws(() => SR.register({ pid: process.pid }), (e) => e.code === 'ENOSPC');
  assert.strictEqual(calls, 1, 'a full disk is not waited out');
  assert.deepStrictEqual(strays(dir), []);
}));

test('a tombstone write is retried through EPERM too', () => withRegistry((dir) => {
  const realRename = SR.io.rename; let calls = 0;
  SR.io.rename = (a, b) => { if (++calls <= 2) throw errno('EPERM'); return realRename(a, b); };
  const t = { pid: 4000, created: 1700000000000, from: 1700000000000, until: 1700000001000, kind: 'worker', via: null };
  SR.saveTombstone(t);
  assert.strictEqual(calls, 3);
  assert.deepStrictEqual(SR.tombstones().map((x) => x.pid), [4000]);
  assert.deepStrictEqual(strays(dir), []);
}));

test('a target that already holds the same text is a success when every rename is refused; different text is an error, with no temp file left', () => withRegistry((dir) => {
  SR.io.rename = () => { throw errno('EPERM'); };
  const t = { pid: 4001, created: 1700000000000, from: 1700000000000, until: 1700000001000, kind: 'worker', via: null };
  fs.mkdirSync(path.join(dir, 'exited'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'exited', '4001-1700000000000.json'), JSON.stringify(t));
  assert.doesNotThrow(() => SR.saveTombstone(t), 'the same tombstone is already there');
  assert.throws(() => SR.saveTombstone({ ...t, until: 1700000009999 }), (e) => e.code === 'EPERM', 'a different one is not swallowed');
  assert.deepStrictEqual(strays(dir), []);
}));

test('two writes of one target use different temp names', () => withRegistry(() => {
  const realRename = SR.io.rename; const seen = [];
  SR.io.rename = (a, b) => { seen.push(a); return realRename(a, b); };
  SR.register({ pid: process.pid }); SR.register({ pid: process.pid });
  assert.strictEqual(seen.length, 2);
  assert.notStrictEqual(seen[0], seen[1]);
  assert.ok(seen.every((n) => n.includes(`.${process.pid}.`)), 'each still names the writer');
}));

test('a reader that meets EBUSY while a record is being replaced retries; one that never gets in fails closed', () => withRegistry(() => {
  SR.register({ pid: process.pid, kind: 'worker', workerId: 'w9' });
  const realRead = SR.io.read; let refused = 0;
  SR.io.read = (p) => { if (++refused <= 2) throw errno('EBUSY'); return realRead(p); };
  assert.deepStrictEqual(SR.list().map((r) => r.worker_id), ['w9']);
  assert.strictEqual(refused, 3);
  SR.io.read = () => { throw errno('EBUSY'); };
  assert.throws(() => SR.list(), (e) => /cannot be read/.test(e.message), 'a record that cannot be read is an error, not an empty list');
}));

test('processes writing one tombstone together all succeed (real renames)', () => withRegistry((dir) => {
  const script = path.join(dir, 'writer.cjs');
  fs.writeFileSync(script, [
    "const SR = require(process.argv[2]);",
    "const t = { pid: 4002, created: 1700000000000, from: 1700000000000, until: 1700000001000, kind: 'worker', via: null };",
    "for (let i = 0; i < 40; i++) SR.saveTombstone(t);",
  ].join('\n'));
  const src = path.join(__dirname, '..', '..', 'src', 'core', 'spawn-register.cjs').split(path.sep).join('/');
  return Promise.all([1, 2, 3, 4].map(() => new Promise((resolve) => {
    const c = spawn(process.execPath, [script, src], { env: { ...process.env, BELAY_SPAWN_REGISTRY: dir }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = ''; c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code) => resolve({ code, err }));
  }))).then((rs) => {
    for (const r of rs) assert.strictEqual(r.code, 0, r.err);
    assert.deepStrictEqual(strays(dir), []);
    assert.strictEqual(SR.tombstones().length, 1);
  });
}));
