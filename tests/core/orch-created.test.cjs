'use strict';
// orch-created.test.cjs — the headless orchestrator's spawn-register record and the run's own spawned list carry its creation time once
// it is known, so a process that reuses its pid inside an intact chain is not taken for it. A record with no creation time still matches
// by pid alone (fail closed). The register is real (a directory of its own); the host's tables are injected.

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { core, OLD_ROOT_CREATED, ownSpawnRegistry } = require('./helpers.cjs');
const { registerOrchestrator, wireRun } = require('../../src/run/register-orchestrator.cjs');

const OC = core('operator-check.cjs');
const SR = core('spawn-register.cjs');

const T0 = Date.now();
const tick = () => new Promise((r) => setImmediate(r));
const conn = () => ({ belayTransport: 'tcp', remotePort: 61000, localPort: 52100 });
const table = async () => '  TCP    127.0.0.1:61000        127.0.0.1:52100        ESTABLISHED     4242\r\n';
// an intact chain to an old root; the middle process reuses the orchestrator's pid but is another life of it
const shot = new Map([
  [4001, { ppid: 1, created: OLD_ROOT_CREATED, image: 'explorer.exe' }],
  [700, { ppid: 4001, created: OLD_ROOT_CREATED + 5000, image: 'pwsh.exe' }],
  [4242, { ppid: 700, created: T0 - 10, image: 'node.exe' }],
]);
const verdict = () => OC.create({ startedAt: T0, spawned: () => SR.list({ snap: shot, persist: false }), deps: { table, snapshot: async () => shot } })({ conn: conn() });

test('the register record of the headless orchestrator, once it carries its creation time, no longer refuses a reused pid', async () => {
  const reg = ownSpawnRegistry();
  try {
    const proc = new EventEmitter();
    let reading = null; const pending = new Promise((r) => { reading = r; });
    registerOrchestrator({ pid: 700, exited: () => null }, { dataDir: 'A:/store', proc, createdOf: () => pending, schedule: [0], stampOpts: { every: 3600000 } });
    assert.strictEqual((await verdict()).ok, false, 'before the reading lands the record matches by pid alone: refused (fail closed)');
    reading({ created: Date.now() + 5 }); await tick(); await tick();
    assert.strictEqual((await verdict()).ok, true, 'the record names another life of pid 700');
    proc.emit('exit');
  } finally { reg.remove(); }
});

test('runSpawned lists the headless orchestrator with its creation time once known, and nothing for an interactive run', () => {
  assert.deepStrictEqual(SR.runSpawned(false, 700), [{ pid: 700, created: null, kind: 'orchestrator' }]);
  assert.deepStrictEqual(SR.runSpawned(false, 700, 1234), [{ pid: 700, created: 1234, kind: 'orchestrator' }]);
  assert.deepStrictEqual(SR.runSpawned(true, 700, 1234), []);
});

test('the run\'s wiring: the hook goes into hookBox, the time read lands in hookBox.created, and the owner\'s list shows it', () => {
  const hookBox = {};
  let seen = null;
  const w = wireRun({ hookBox, dataDir: 'A:/store', interactive: false, register: (h, o) => { seen = { h, o }; } });
  assert.deepStrictEqual(w.spawned(), [], 'before the hook: nothing');
  const h = { pid: 700, exited: () => null };
  w.attach(h);
  assert.strictEqual(hookBox.pid, 700);
  assert.deepStrictEqual(w.spawned(), [{ pid: 700, created: null, kind: 'orchestrator' }]);
  seen.o.onCreated(1234);
  assert.strictEqual(hookBox.created, 1234);
  assert.deepStrictEqual(w.spawned(), [{ pid: 700, created: 1234, kind: 'orchestrator' }]);
  // an interactive run registers nothing and lists nothing
  let called = false; const box2 = {};
  const wi = wireRun({ hookBox: box2, dataDir: 'A:/store', interactive: true, register: () => { called = true; } });
  wi.attach(h);
  assert.strictEqual(called, false);
  assert.deepStrictEqual(wi.spawned(), []);
});
