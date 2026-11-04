'use strict';
// spawn-register.test.cjs — the machine-wide record of what belay spawned (ADR 0045 decision 4, across stores): one record per pid,
// removed when the child exits, a record whose pid is gone pruned on read, and an unreadable register an error rather than "empty".

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { core } = require('./helpers.cjs');

const SR = core('spawn-register.cjs');

function withRegistry(fn) {
  const keep = process.env.BELAY_SPAWN_REGISTRY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-spawn-register-'));
  process.env.BELAY_SPAWN_REGISTRY = dir;
  return Promise.resolve().then(() => fn(dir)).finally(() => { process.env.BELAY_SPAWN_REGISTRY = keep; fs.rmSync(dir, { recursive: true, force: true }); });
}

const deadPid = async () => require('../helpers/dead-pid.cjs').deadPid(); // never an exited child's pid: Windows reuses those

test('register, list, update and unregister: one record per pid, the creation time filled in later', () => withRegistry(() => {
  assert.deepStrictEqual(SR.list(), [], 'an empty register lists nothing');
  SR.register({ pid: process.pid, kind: 'worker', dataDir: 'D:/a/.belay', workerId: 'w1' });
  assert.deepStrictEqual(SR.list(), [{ pid: process.pid, created: null, kind: 'worker', data_dir: 'D:/a/.belay', worker_id: 'w1' }]);
  assert.strictEqual(SR.update(process.pid, 12345), true);
  assert.strictEqual(SR.list()[0].created, 12345);
  assert.strictEqual(SR.list()[0].worker_id, 'w1', 'an update keeps the rest of the record');
  assert.strictEqual(SR.update(process.pid + 100000, 1), false, 'there is nothing to update for an unregistered pid');
  SR.unregister(process.pid);
  assert.deepStrictEqual(SR.list(), []);
  SR.unregister(process.pid); // twice is fine
}));

test('a record whose pid is gone is removed when the register is read', () => withRegistry(async (dir) => {
  const pid = await deadPid();
  SR.register({ pid, kind: 'worker' });
  assert.ok(fs.existsSync(path.join(dir, `${pid}.json`)));
  assert.deepStrictEqual(SR.list(), []);
  assert.ok(!fs.existsSync(path.join(dir, `${pid}.json`)), 'pruned');
}));

test('an unreadable register is an error, never an empty list; one unreadable record is unproven, never a throw', () => withRegistry((dir) => {
  // one record that does not parse, or names no pid: its pid alive, it is listed by pid alone; gone, a writer moves it aside
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), '{ not json');
  assert.deepStrictEqual(SR.list().map((r) => [r.pid, r.created, /does not parse/.test(r.kind)]), [[process.pid, null, true]]);
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ kind: 'worker' }));
  assert.deepStrictEqual(SR.list().map((r) => [r.pid, /names no pid/.test(r.kind)]), [[process.pid, true]]);
  fs.rmSync(path.join(dir, `${process.pid}.json`));
  const gone = require('../helpers/dead-pid.cjs').deadPid();
  fs.writeFileSync(path.join(dir, `${gone}.json`), '{ not json');
  assert.deepStrictEqual(SR.list(), []);
  assert.ok(!fs.existsSync(path.join(dir, `${gone}.json`)) && fs.readdirSync(path.join(dir, 'corrupt')).length === 1, 'moved to corrupt/');
  const file = path.join(dir, 'a-file');
  fs.writeFileSync(file, 'x');
  process.env.BELAY_SPAWN_REGISTRY = file;
  assert.throws(() => SR.list(), (e) => e.code === 'ENOTDIR', 'a path that is a file is not an empty register');
  assert.throws(() => SR.register({ pid: process.pid }), 'and nothing can be registered under it');
  assert.throws(() => SR.register({ pid: 'x' }), /not a pid/);
}));

test('belay run lists its headless orchestrator once its pid is known, and the interactive orchestrator never', () => {
  assert.deepStrictEqual(SR.runSpawned(false, 4321), [{ pid: 4321, created: null, kind: 'orchestrator' }]);
  assert.deepStrictEqual(SR.runSpawned(true, 4321), [], 'the interactive orchestrator is the human\'s own session');
  assert.deepStrictEqual(SR.runSpawned(false, undefined), [], 'before the run process learns the pid');
});

test('a retired record leaves a tombstone with the lifetime of its process, whether the harness retired it or the register found its pid gone', () => withRegistry(async () => {
  SR.register({ pid: process.pid, kind: 'worker', created: 5000 });
  SR.unregister(process.pid);
  const [t] = SR.tombstones();
  assert.deepStrictEqual([t.pid, t.created, t.from, t.kind, t.via, t.until > 0], [process.pid, 5000, 5000, 'worker', null, true]);
  const pid = await deadPid();
  SR.register({ pid, kind: 'orchestrator', spawnedAt: 7000 });
  assert.deepStrictEqual(SR.list(), []);
  const dead = SR.tombstones().find((x) => x.pid === pid);
  assert.deepStrictEqual([dead.created, dead.from, dead.kind], [null, 7000, 'orchestrator'], 'a record with no creation time starts when its spawn call did');
  assert.strictEqual(SR.live().length, 0);
  // a tombstone that names no pid or start is unproven: its pid (from the name) alive, it is listed as a live descendant naming the file
  fs.writeFileSync(path.join(SR.dir(), 'exited', `${process.pid}-0.json`), '{}');
  const u = SR.tombstones().find((x) => x.unproven);
  assert.deepStrictEqual([u.pid, u.until, u.kind, u.via.includes(`${process.pid}-0.json`), u.unproven.why], [process.pid, null, 'descendant', true, 'names no pid']);
}));
