'use strict';
// spawn-register.test.cjs (run) — ADR 0045 decision 4 across stores, the spawning side: every worker the run manager launches is
// recorded in the machine-wide spawn register at once and removed when it exits, and a register that cannot be written ends the child
// and fails the launch (a worker no owner can recognise must not run). Real manager, the fake core and the fake Claude.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const SR = require('../../src/core/spawn-register.cjs');
const P = require('../../src/run/process.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const USER_SETTINGS = path.join(__dirname, 'fixtures', 'user-settings.json');
const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-spawnreg-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: fwd(d), worktree: fwd(path.join(d, 'wt')) };
}

test('a spawned worker is in the register while it lives and gone once it has exited', async () => {
  const { data, worktree } = sandbox();
  const m = createRunManager({ core: createFakeCore(), dataDir: data, runId: 'run-sr', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: USER_SETTINGS } });
  try {
    const w = await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hi', worker_id: 'w-sr' });
    const mine = SR.list().find((r) => r.pid === w.pid);
    assert.ok(mine, `the worker (pid ${w.pid}) is not in the register: ${JSON.stringify(SR.list())}`);
    assert.strictEqual(mine.kind, 'worker');
    assert.strictEqual(mine.worker_id, 'w-sr');
    assert.strictEqual(mine.data_dir, data);
    await m.stop({ worker_id: 'w-sr' });
    await m._waitExit('w-sr', 10000);
    assert.ok(!SR.list().some((r) => r.pid === w.pid), 'the register still names an exited worker');
    assert.ok(!fs.existsSync(path.join(SR.dir(), `${w.pid}.json`)));
  } finally { await m.shutdown(); cleanup(data); }
});

test('a register that cannot be written ends the child and refuses the launch', async () => {
  const { data, worktree } = sandbox();
  const keep = process.env.BELAY_SPAWN_REGISTRY;
  const file = path.join(os.tmpdir(), `belay-spawnreg-file-${process.pid}`);
  fs.writeFileSync(file, 'x');
  process.env.BELAY_SPAWN_REGISTRY = file; // mkdir under a file: the register cannot be written
  const core = createFakeCore();
  const m = createRunManager({ core, dataDir: data, runId: 'run-sr2', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: USER_SETTINGS } });
  let pid = null;
  try {
    await assert.rejects(m.spawn({ substrate: 'claude-code', worktree, prompt: 'hi', worker_id: 'w-sr2' }), (e) => {
      assert.strictEqual(e.code, 'E_SUBSTRATE', e.message);
      assert.strictEqual(e.detail.reason, 'spawn_register');
      assert.ok(Number.isInteger(e.detail.pid));
      pid = e.detail.pid;
      return true;
    });
    const gone = await P.waitPidGone(pid, { timeoutMs: 10000 });
    assert.ok(gone !== null, `the child (pid ${pid}) is still alive`);
    const row = core.currentWorker('w-sr2'); // the refusal settles the `starting` row: no process and no exit listener is left to do it
    assert.ok(row && row.state === 'dead', `the worker row is ${row && row.state}, not dead`);
  } finally {
    process.env.BELAY_SPAWN_REGISTRY = keep;
    await m.shutdown().catch(() => {});
    fs.rmSync(file, { force: true });
    cleanup(data);
  }
});

// pid-identity.cjs noteSpawn: the creation time is written to the register after the first rows went out. That write can fail after its
// retries (a persistent EPERM); nothing awaits it, so a rejection there is an unhandled rejection that ends the adapter.
test('a register update that fails is kept on the worker and never rejects the creation-time promise or throws in a snapshot callback', async () => {
  const keepDir = process.env.BELAY_SPAWN_REGISTRY;
  const keepRename = SR.io.rename; const keepSleep = SR.io.sleep;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-spawnreg-upd-'));
  process.env.BELAY_SPAWN_REGISTRY = dir;
  const PI = require('../../src/run/pid-identity.cjs');
  const { EventEmitter } = require('node:events');
  const eperm = () => Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  const mk = (pid) => { const child = new EventEmitter(); child.pid = pid; child.exitCode = null; child.signalCode = null; child.belaySpawnStartedAt = Date.now(); return child; };
  try {
    SR.register({ pid: 424201, kind: 'worker' }); SR.register({ pid: 424202, kind: 'worker' });
    SR.io.rename = () => { throw eperm(); }; SR.io.sleep = () => {};
    // 1) the first read answers: the closing step of the promise chain writes the register
    const w1 = { id: 'w-u1', pid: 424201 };
    const created = Date.now();
    await PI.noteSpawn(w1, mk(424201), { createdOf: async () => ({ created }) });
    assert.strictEqual(w1.pidCreated, created);
    assert.strictEqual(w1.lastError && w1.lastError.where, 'spawn-register.update', JSON.stringify(w1.lastError));
    assert.strictEqual(w1.lastError.code, 'EPERM');
    // 2) the first read fails and a later snapshot supplies it: the gate's callback runs the update, and must not throw
    let cb = null;
    const gate = { stamp: () => 1, onSnapshot: (f) => { cb = f; return () => { cb = null; }; } };
    const w2 = { id: 'w-u2', pid: 424202 };
    await PI.noteSpawn(w2, mk(424202), { createdOf: async () => null, gate, schedule: [3600000], every: 3600000, snapshotShared: async () => ({ snap: null }) });
    assert.ok(cb, 'the pending read subscribed to the snapshot gate');
    assert.doesNotThrow(() => cb({ snap: new Map([[424202, { created }]]), startSeq: 2 }));
    assert.strictEqual(w2.pidCreated, created);
    assert.strictEqual(w2.lastError && w2.lastError.where, 'spawn-register.update', JSON.stringify(w2.lastError));
  } finally {
    SR.io.rename = keepRename; SR.io.sleep = keepSleep; process.env.BELAY_SPAWN_REGISTRY = keepDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
