'use strict';
// A check command is code a worker wrote, and the owner runs it as its own child. The operator check (ADR 0045 decision 4) refuses a
// peer that descends from a process belay spawned, but the owner's own children were in no register, so a check command that
// called the owner passed as the operator. runCommand now records a check command in the spawn register (`register: 'check'`),
// which task.evaluate and the integration checks pass. Here a real bound owner is called by a check command that claims the
// operator: it is refused; the same command run by an unregistered parent is vouched for (the control); the record is retired when
// the command exits; and a register that cannot be written means the command does not run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { core, sandbox, cleanup, ownSpawnRegistry } = require('./helpers.cjs');

const SR = core('spawn-register.cjs');
const { Owner } = core('owner.cjs');
const { runAcceptance, runCommand } = core('evaluate.cjs');
const CLIENT = path.join(__dirname, '..', 'helpers', 'raw-claim.cjs');
const SKIP = process.platform !== 'win32' && 'the peer check reads Windows tools';

async function withOwner(fn) {
  const dir = sandbox();
  const o = new Owner(dir, { embed: false, mode: 'bound' });
  await o.start();
  try { return await fn(o, dir); } finally { await o.stop().catch(() => {}); cleanup(dir); }
}

const lastJson = (text) => JSON.parse(String(text).trim().split('\n').pop());

test('a check command run by task.evaluate that claims the operator is refused; the same call from an unregistered parent is vouched for', { skip: SKIP, timeout: 120000 }, async () => {
  ownSpawnRegistry();
  await withOwner(async (o, dir) => {
    const argv = [process.execPath, CLIENT, String(o.tcpPort), 'tcp'];
    const checks = await runAcceptance({ commands: [{ argv, timeout_ms: 60000 }] }, dir, []);
    assert.strictEqual(checks[0].executable, true, JSON.stringify(checks[0]));
    const tail = checks[0].detail.stdout_tail; // cut at 400 characters, so matched, not parsed
    assert.match(tail, /E_UNBOUND/, `the check command was vouched for as the operator: ${tail}`);
    assert.match(tail, /descends from a process belay spawned .check pid/);
    assert.strictEqual(o.store.db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE text LIKE 'forged%'").get().n, 0, 'a forged write reached the store');

    // Control: a command nothing registered (as the old code ran it) reaches the operator role, so the refusal above is the register's.
    const ok = await runCommand(argv, dir, 60000, { keep: 'ends' });
    const vouched = lastJson(ok.stdout);
    assert.ok(vouched.result && vouched.result.id, JSON.stringify(vouched));
    assert.strictEqual(vouched.result.written_by, 'operator');
  });
});

test('a check command is retired from the register when it exits, and its tombstone keeps its lifetime', { timeout: 60000 }, async () => {
  ownSpawnRegistry();
  const seen = [];
  const r = await runCommand([process.execPath, '-e', 'setTimeout(() => {}, 300)'], os.tmpdir(), 30000, { register: 'check', onChild: (c) => seen.push(c.pid, SR.list({ persist: false }).map((x) => `${x.pid}:${x.kind}`)) });
  assert.strictEqual(r.exit_code, 0);
  assert.deepStrictEqual(seen[1], [`${seen[0]}:check`], 'recorded as a check while it ran');
  assert.deepStrictEqual(SR.list({ persist: false }), [], 'no record left');
  assert.ok(SR.tombstones().some((t) => t.pid === seen[0] && t.kind === 'check'), 'the tombstone names the check');
});

test('a register that cannot be written means the check command does not run', { timeout: 60000 }, async () => {
  const reg = ownSpawnRegistry();
  const asFile = path.join(os.tmpdir(), `belay-check-register-not-a-dir-${process.pid}`);
  fs.writeFileSync(asFile, 'x');
  process.env.BELAY_SPAWN_REGISTRY = path.join(asFile, 'registry'); // a directory under a file: no record can be written
  const marker = path.join(os.tmpdir(), `belay-check-ran-${process.pid}`);
  try {
    const r = await runCommand([process.execPath, '-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'), 1500)`], os.tmpdir(), 30000, { register: 'check' });
    assert.strictEqual(r.executable, false, JSON.stringify(r));
    assert.match(r.spawn_error, /^not run: .*could not be recorded in the spawn register/);
    await new Promise((res) => setTimeout(res, 2000)); // the child would have written by now had it survived
    assert.ok(!fs.existsSync(marker), 'the command ran without a record');
  } finally { try { fs.unlinkSync(asFile); } catch { /* gone */ } try { fs.unlinkSync(marker); } catch { /* never written */ } reg.remove(); }
});
