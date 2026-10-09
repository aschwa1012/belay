'use strict';
// embedder-proc.test.cjs — review 3 of build step E1: a wedged owner fails a vector call within its ping
// (m12, MF3-1), the embedder child's environment is an allow-list with no execArgv, and the child dies
// with its owner (SF3-5). Only the owner-death test needs the fetched model.

const nodeTest = require('node:test').test;
const test = (name, fn) => nodeTest(name, { timeout: 240000 }, fn); // model loads under a parallel phase can outrun 60 s
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup, callerFor, optInModel } = require('./helpers.cjs');
optInModel();

const { openCore } = core('index.cjs');
const { Embedder } = core('embedder.cjs');
const { pidAlive } = core('lock.cjs');
const M = core('models.cjs');
const K = core('model-cache.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const VOYAGE = M.MODELS[M.DEFAULT_MODEL];
const absence = () => {
  if (!K.packageDir()) return 'the transformers package is not installed at the pinned version';
  const c = K.checkPresent(VOYAGE);
  return c.present ? null : `the model ${VOYAGE.id} is not fetched (belay embedder fetch)`;
};

test('memory.search: a live owner whose loop is blocked fails a vector call within its ping, naming the ping (m12)', async () => {
  const dir = sandbox();
  let child = null;
  try {
    child = spawn(process.execPath, [`${ROOT}/tests/core/fixtures/owner-wedged.cjs`, dir, '6000'], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise(res => child.once('exit', res));
    let buf = '';
    child.stdout.on('data', d => { buf += d; });
    for (let i = 0; i < 400 && !buf.includes('READY'); i += 1) await new Promise(r => setTimeout(r, 25));
    assert.ok(buf.includes('READY'), `the wedged owner did not start: ${buf}`);
    await new Promise(r => setTimeout(r, 700)); // it is now wedged
    const c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    const t0 = Date.now();
    await assert.rejects(c.memory.search({ query: 'which process?' }), x => {
      const ms = Date.now() - t0;
      assert.strictEqual(x.code, 'E_OWNER_LOST', `${x.code}: ${x.message}`);
      assert.match(x.message, /did not answer a 300 ms ping/);
      assert.match(x.message, /2000 ms re-ping/);
      assert.ok(!/loading/.test(x.message), x.message);
      assert.strictEqual(x.detail.owner_pid, child.pid);
      assert.strictEqual(x.detail.ping.ok, false);
      assert.ok(ms < 4000, `the wedged owner cost ${ms} ms`); // 300 ms ping, then one 2,000 ms re-ping (E2)
      return true;
    });
    // A text store takes the same path.
    const t1 = Date.now();
    await assert.rejects(c.memory.store({ text: 'x' }), x => x.code === 'E_OWNER_LOST' && Date.now() - t1 < 4000);
    await c.close();
    await exited;
  } finally {
    if (child && child.exitCode === null) { try { process.kill(child.pid); } catch { /* gone */ } }
    cleanup(dir);
  }
});

test('embedder: the child gets an allow-listed environment and no execArgv (SF3-4)', async () => {
  const saved = {};
  const set = { BELAY_TEST_MODE: '1', PLANTED_SECRET_TOKEN: 'hunter2', ANTHROPIC_API_KEY: 'sk-planted', NODE_OPTIONS: '--max-old-space-size=200', NODE_TEST_CONTEXT: 'child-v8' };
  for (const k of Object.keys(set)) { saved[k] = process.env[k]; process.env[k] = set[k]; }
  const e = new Embedder({ cacheDir: sandbox() });
  try {
    e._start();
    const r = await e._call({ op: 'env' }, 20000);
    for (const k of ['PLANTED_SECRET_TOKEN', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT']) assert.strictEqual(r.env[k], undefined, `${k} reached the child`);
    assert.strictEqual(r.env.BELAY_TEST_MODE, '1', 'BELAY_TEST_MODE passes when set');
    const allowed = new Set(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOME', 'XDG_CACHE_HOME', 'BELAY_MODEL_CACHE', 'BELAY_TRANSFORMERS_PKG', 'BELAY_TEST_MODE', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE',
      // added by Windows itself to any new process from the user's profile, none of them a secret
      'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME', 'WINDIR']);
    const extra = Object.keys(r.env).filter(k => !allowed.has(k) && !k.startsWith('='));
    assert.deepStrictEqual(extra, [], 'the child sees only the allow-list (plus the IPC variables node adds)');
    assert.deepStrictEqual(r.execArgv, [], 'no inherited execArgv');
  } finally {
    await e.close();
    for (const k of Object.keys(set)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    cleanup(e.cacheDir);
  }
});

test('embedder: killing the owner by its exact pid mid-embed takes the embedder child with it within 2 s (SF3-5)', async t => {
  const why = absence();
  if (why) return t.skip(why);
  const dir = sandbox();
  let owner = null;
  try {
    owner = spawn(process.execPath, [`${ROOT}/tests/core/fixtures/owner-embed-stop.cjs`, dir, 'hold'], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '', info = null;
    owner.stdout.on('data', d => { out += d; for (const l of out.split('\n')) if (l.includes('"stopping"') && !info) info = JSON.parse(l); });
    for (let i = 0; i < 4800 && !info; i += 1) await new Promise(r => setTimeout(r, 25));
    assert.ok(info, `the owner never had an embed in flight: ${out}`);
    assert.ok(pidAlive(info.embedder_pid), 'the embedder child is up and busy');
    process.kill(info.owner_pid); // the exact pid of the owner this test spawned
    const t0 = Date.now();
    while (pidAlive(info.embedder_pid) && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 20));
    const ms = Date.now() - t0;
    assert.strictEqual(pidAlive(info.embedder_pid), false, 'the child outlived its owner');
    assert.ok(ms < 2000, `the child took ${ms} ms to go`);
  } finally {
    if (owner && owner.exitCode === null) { try { process.kill(owner.pid); } catch { /* gone */ } }
    cleanup(dir);
  }
});
