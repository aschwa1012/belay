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

const deadPid = () => new Promise((resolve) => {
  const c = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
  const pid = c.pid;
  c.on('exit', () => resolve(pid));
});

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

test('an unreadable register is an error, never an empty list', () => withRegistry((dir) => {
  fs.writeFileSync(path.join(dir, '4242.json'), '{ not json');
  assert.throws(() => SR.list(), /cannot be read/);
  fs.rmSync(path.join(dir, '4242.json'));
  fs.writeFileSync(path.join(dir, '4243.json'), JSON.stringify({ kind: 'worker' }));
  assert.throws(() => SR.list(), /names no pid/);
  fs.rmSync(path.join(dir, '4243.json'));
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
