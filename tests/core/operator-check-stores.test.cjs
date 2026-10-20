'use strict';
// operator-check-stores.test.cjs — ADR 0045 decision 4 across stores. An owner's own worker rows name only its own store's workers;
// a child of a worker that belongs to ANOTHER store (or another run's headless orchestrator) has an intact chain to an older shell and
// was accepted as the operator. Every harness records what it spawns in the machine-wide spawn register (spawn-register.cjs), and the
// owner reads it. Here this test process stands in for another store's worker: it is in the register under another data dir, and a
// real child of it (a worker's Bash) forges the operator against a `bound` owner that has never heard of it. Writes, an orchestrator
// bind and the run controls are all refused; the same child is vouched for once the register no longer names its parent; and a
// register that cannot be read refuses it too (fail closed).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup } = require('./helpers.cjs');

const SR = core('spawn-register.cjs');
const { Owner } = core('owner.cjs');
const CLIENT = path.join(__dirname, '..', 'helpers', 'raw-claim.cjs');
const SKIP = process.platform !== 'win32' && 'the peer check reads Windows tools';

function viaChild(port, mode) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [CLIENT, String(port), mode], { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let errOut = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { errOut += d; });
    c.on('close', () => { try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { reject(new Error(`no answer: ${out} ${errOut}`)); } });
  });
}

// An owner of a store that has no worker of this process in it. `stopped` counts run.stop calls that reached the control.
async function withOtherStoreOwner(fn) {
  const dir = sandbox();
  const stopped = { n: 0 };
  const o = new Owner(dir, { embed: false, mode: 'bound', controls: { 'run.stop': () => { stopped.n++; return { stopped: true }; } } });
  await o.start();
  try { return await fn(o, stopped); } finally { await o.stop().catch(() => {}); cleanup(dir); }
}

const other = (extra) => ({ pid: process.pid, kind: 'worker', dataDir: 'C:/some/other/store/.belay', workerId: 'w-elsewhere', ...extra });

test('a child of another store\'s worker is refused as the operator: a write, an orchestrator bind and the run controls', { skip: SKIP, timeout: 120000 }, async () => {
  await withOtherStoreOwner(async (o, stopped) => {
    SR.register(other());
    try {
      const write = await viaChild(o.tcpPort, 'tcp');
      assert.strictEqual(write.error && write.error.code, 'E_UNBOUND', JSON.stringify(write));
      assert.match(write.error.message, /descends from a process belay spawned \(worker pid \d+/);
      const bind = await viaChild(o.tcpPort, 'orch-bind');
      assert.strictEqual(bind.error && bind.error.code, 'E_UNBOUND', `bind.open as the forged operator: ${JSON.stringify(bind)}`);
      assert.strictEqual(o.binds.byId.size, 0, 'no bind was opened');
      const stop = await viaChild(o.tcpPort, 'run-stop');
      assert.strictEqual(stop.error && stop.error.code, 'E_UNBOUND', `run.stop as the forged operator: ${JSON.stringify(stop)}`);
      assert.strictEqual(stopped.n, 0, 'the run control was reached');
      const rows = o.store.db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE text LIKE 'forged%'").get().n;
      assert.strictEqual(rows, 0, 'a forged write reached the store');
    } finally { SR.unregister(process.pid); }
  });
});

test('control: the same child is vouched for when the register does not name its parent, so the refusal above is the register\'s', { skip: SKIP, timeout: 120000 }, async () => {
  await withOtherStoreOwner(async (o) => {
    const ok = await viaChild(o.tcpPort, 'tcp');
    assert.ok(ok.result && ok.result.id, JSON.stringify(ok));
    assert.strictEqual(ok.result.written_by, 'operator');
  });
});

test('a register that cannot be read refuses the operator, naming why', { skip: SKIP, timeout: 120000 }, async () => {
  await withOtherStoreOwner(async (o) => {
    const keep = process.env.BELAY_SPAWN_REGISTRY;
    const asFile = path.join(os.tmpdir(), `belay-register-not-a-dir-${process.pid}`);
    fs.writeFileSync(asFile, 'x');
    process.env.BELAY_SPAWN_REGISTRY = asFile; // readdir of a file: ENOTDIR, which is not "nothing registered"
    try {
      const r = await viaChild(o.tcpPort, 'tcp');
      assert.strictEqual(r.error && r.error.code, 'E_UNBOUND', JSON.stringify(r));
      assert.match(r.error.message, /could not be listed/);
    } finally { process.env.BELAY_SPAWN_REGISTRY = keep; fs.rmSync(asFile, { force: true }); }
  });
});
