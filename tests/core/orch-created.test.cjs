'use strict';
// orch-created.test.cjs — the headless orchestrator's spawn-register record and the run's own spawned list carry its creation time once
// it is known, so a process that reuses its pid inside an intact chain is not taken for it. A record with no creation time still matches
// by pid alone (fail closed).

const { test } = require('node:test');
const assert = require('node:assert');
const { core, OLD_ROOT_CREATED } = require('./helpers.cjs');

const OC = core('operator-check.cjs');
const SR = core('spawn-register.cjs');

const T0 = Date.now();

test('an orchestrator record with its creation time does not refuse a reused pid in an intact chain; one without it still does', async () => {
  const conn = () => ({ belayTransport: 'tcp', remotePort: 61000, localPort: 52100 });
  const table = async () => '  TCP    127.0.0.1:61000        127.0.0.1:52100        ESTABLISHED     4242\r\n';
  // an intact chain to an old root; the middle process reuses the orchestrator's pid but was created at another time
  const shot = new Map([
    [4001, { ppid: 1, created: OLD_ROOT_CREATED, image: 'explorer.exe' }],
    [700, { ppid: 4001, created: OLD_ROOT_CREATED + 5000, image: 'pwsh.exe' }],
    [4242, { ppid: 700, created: T0 - 10, image: 'node.exe' }],
  ]);
  const run = (spawned) => OC.create({ startedAt: T0, spawned: () => spawned, deps: { table, snapshot: async () => shot } })({ conn: conn() });
  assert.strictEqual((await run([{ pid: 700, created: OLD_ROOT_CREATED + 123, kind: 'orchestrator' }])).ok, true, 'the record names another life of pid 700');
  assert.strictEqual((await run([{ pid: 700, created: OLD_ROOT_CREATED + 5000, kind: 'orchestrator' }])).ok, false, 'the same life is refused');
  assert.strictEqual((await run([{ pid: 700, created: null, kind: 'orchestrator' }])).ok, false, 'no creation time: pid alone, fail closed');
});

test('runSpawned lists the headless orchestrator with its creation time once known, and nothing for an interactive run', () => {
  assert.deepStrictEqual(SR.runSpawned(false, 700), [{ pid: 700, created: null, kind: 'orchestrator' }]);
  assert.deepStrictEqual(SR.runSpawned(false, 700, 1234), [{ pid: 700, created: 1234, kind: 'orchestrator' }]);
  assert.deepStrictEqual(SR.runSpawned(true, 700, 1234), []);
});
