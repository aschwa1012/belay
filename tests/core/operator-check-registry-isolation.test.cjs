'use strict';
// operator-check-registry-isolation.test.cjs — a fake operator-check fixture invents a shell as the root of its chain. A live record of a
// spawned orchestrator in the register the check reads, whose lifetime covers that root's creation time, makes the root its descendant
// and the check refuses the peer. Test files run concurrently, so (1) no file may share a register with another (tests/helpers/tmp.cjs
// gives each test-file process its own, though `node --test --require` loads the helper in the runner too, and the files inherit it),
// and (2) the invented root is older than any recorded lifetime. Deterministic: the covering record is written here, no load.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { core, OLD_ROOT_CREATED, ownSpawnRegistry } = require('./helpers.cjs');

const OC = core('operator-check.cjs');
const SR = core('spawn-register.cjs');
const Prov = core('spawn-provenance.cjs');

const HELPER = path.join(__dirname, '..', 'helpers', 'tmp.cjs');
const NOW = Date.now();
const snap = (root) => new Map([[4242, { ppid: 4000, created: NOW - 5000, image: 'node.exe' }], [4000, { ppid: 1, created: root, image: 'pwsh.exe' }]]);
const tableOf = async () => '  TCP    127.0.0.1:52100        127.0.0.1:61000        ESTABLISHED     1234\r\n  TCP    127.0.0.1:61000        127.0.0.1:52100        ESTABLISHED     4242\r\n';
const check = (root) => OC.create({ startedAt: NOW, spawned: () => [], provenance: (s) => Prov.refresh(s), deps: { table: tableOf, snapshot: async () => snap(root) } });
const peer = { belayTransport: 'tcp', remotePort: 61000, localPort: 52100 };
const skip = !OC.SUPPORTED && 'bound mode needs the Windows peer check';

// A live orchestrator that began a minute before the fixture's invented root of T0 - 9000.
const coveringOrchestrator = () => SR.register({ pid: process.pid, kind: 'orchestrator', spawnedAt: NOW - 60000 });

test('an orchestrator registered in the same register covers a root made nine seconds before now (the defect)', { skip }, async () => {
  const reg = ownSpawnRegistry();
  try {
    coveringOrchestrator();
    const r = await check(NOW - 9000)({ conn: peer });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.reason, /descendant of orchestrator/);
  } finally { reg.remove(); }
});

test('the same orchestrator does not cover the fixtures\' old root, so a concurrent file\'s record cannot refuse the fake operator', { skip }, async () => {
  const reg = ownSpawnRegistry();
  try {
    coveringOrchestrator();
    const r = await check(OLD_ROOT_CREATED)({ conn: peer });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
  } finally { reg.remove(); }
});

test('a test-file process that inherits the runner\'s register makes its own; an explicit register is kept', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-reg-inherit-'));
  try {
    const script = path.join(scratch, 'print.cjs');
    fs.writeFileSync(script, 'console.log(process.env.BELAY_SPAWN_REGISTRY);');
    const run = (env) => spawnSync(process.execPath, ['--require', HELPER, script], { encoding: 'utf8', env }).stdout.trim();
    // the runner: loads the helper, so its environment names its own register and the marker
    const runner = spawnSync(process.execPath, ['--require', HELPER, '-e', 'console.log(JSON.stringify(process.env))'], { encoding: 'utf8', env: { ...process.env, BELAY_SPAWN_REGISTRY: '', BELAY_TEST_SPAWN_REGISTRY_MADE_BY: '' } });
    const renv = JSON.parse(runner.stdout);
    assert.ok(renv.BELAY_SPAWN_REGISTRY && renv.BELAY_TEST_SPAWN_REGISTRY_MADE_BY, 'the runner made a register and marked it');
    const child = run(renv); // a test-file process: inherits both
    assert.ok(path.basename(child).startsWith('belay-spawned-test-'), child);
    assert.notStrictEqual(child.toLowerCase(), renv.BELAY_SPAWN_REGISTRY.toLowerCase(), 'not the runner\'s register');
    const explicit = path.join(scratch, 'explicit');
    assert.strictEqual(run({ ...renv, BELAY_SPAWN_REGISTRY: explicit }), explicit, 'an explicit register is kept');
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
