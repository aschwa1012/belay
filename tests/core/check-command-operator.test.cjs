'use strict';
// A check command is code a worker wrote, and the owner runs it as its own child. The operator check (ADR 0045 decision 4) refuses a
// peer that descends from a process belay spawned, but the owner's own children were in no register, so a check command that
// called the owner passed as the operator. runCommand now records a check command in the spawn register (`register: 'check'`),
// which task.evaluate and the integration checks pass. Here a real bound owner is called by a check command that claims the
// operator: it is refused; the same command run by an unregistered parent is vouched for (the control); the record is retired when
// the command exits; a register that cannot be written ends the command at once; a harness that ends mid-check retires the record
// with its lifetime closed at that moment, and the record is stamped while the check lives.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
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

test('a register that cannot be written ends the check command at once', { timeout: 60000 }, async () => {
  const reg = ownSpawnRegistry();
  const asFile = path.join(os.tmpdir(), `belay-check-register-not-a-dir-${process.pid}`);
  fs.writeFileSync(asFile, 'x');
  process.env.BELAY_SPAWN_REGISTRY = path.join(asFile, 'registry'); // a directory under a file: no record can be written
  const marker = path.join(os.tmpdir(), `belay-check-ran-${process.pid}`);
  let child = null;
  try {
    const t0 = Date.now();
    const r = await runCommand([process.execPath, '-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'), 20000)`], os.tmpdir(), 30000, { register: 'check', onChild: (c) => { child = c; } });
    assert.strictEqual(r.executable, false, JSON.stringify(r));
    assert.match(r.spawn_error, /^ended at once.*could not be recorded in the spawn register/);
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'the child was ended before the result came back');
    assert.ok(Date.now() - t0 < 20000 && !fs.existsSync(marker), 'it ended long before its own timer');
  } finally { try { fs.unlinkSync(asFile); } catch { /* gone */ } try { fs.unlinkSync(marker); } catch { /* never written */ } reg.remove(); }
});

test('a harness that exits mid-check retires the record at that moment, so the tombstone covers an orphan started late', { timeout: 60000 }, async () => {
  ownSpawnRegistry();
  const harness = spawn(process.execPath, [path.join(__dirname, '..', 'helpers', 'check-harness.cjs')], { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  harness.stdout.on('data', (d) => { out += d; });
  await new Promise((res) => harness.once('close', res));
  const [pidText, aliveAt] = out.trim().split(' ');
  const pid = Number(pidText);
  try {
    assert.ok(pid > 0, `the harness named no check pid: ${out}`);
    assert.deepStrictEqual(SR.list({ persist: false }).filter((r) => r.pid === pid), [], 'no live record is left for the check');
    const tomb = SR.tombstones().find((t) => t.pid === pid);
    assert.ok(tomb, 'a tombstone names the check');
    assert.strictEqual(tomb.kind, 'check');
    assert.ok(tomb.until >= Number(aliveAt), `the lifetime closed at ${tomb.until}, before the check was seen alive at ${aliveAt}`);
  } finally { try { process.kill(pid); } catch { /* gone */ } } // the check child, by its exact pid
});

test('a live check record is stamped on the timer', { timeout: 60000 }, async () => {
  ownSpawnRegistry();
  const CR = core('check-register.cjs');
  let child = null;
  const run = runCommand([process.execPath, '-e', 'setTimeout(() => {}, 400)'], os.tmpdir(), 30000, { register: 'check', onChild: (c) => { child = c; } });
  const file = path.join(SR.dir(), `${child.pid}.json`);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).seen_at, undefined, 'not stamped at the spawn');
  CR.stamp(Date.now() + CR.STAMP_MS + 1000);
  assert.ok(Number.isFinite(JSON.parse(fs.readFileSync(file, 'utf8')).seen_at), 'stamped');
  await run;
});
