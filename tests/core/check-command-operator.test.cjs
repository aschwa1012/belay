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
  let pid = null;
  const run = runCommand([process.execPath, '-e', 'setTimeout(() => {}, 300)'], os.tmpdir(), 30000, { register: 'check', onChild: (c) => { pid = c.pid; } });
  const during = SR.list({ persist: false }).map((x) => `${x.pid}:${x.kind}`); // the record is written before runCommand returns its promise
  const r = await run;
  assert.strictEqual(r.exit_code, 0);
  assert.deepStrictEqual(during, [`${pid}:check`], 'recorded as a check while it ran');
  assert.deepStrictEqual(SR.list({ persist: false }), [], 'no record left');
  assert.ok(SR.tombstones().some((t) => t.pid === pid && t.kind === 'check'), 'the tombstone names the check');
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

const HARNESS = path.join(__dirname, '..', 'helpers', 'check-harness.cjs');
const waitFor = async (ok, ms, what) => {
  for (const end = Date.now() + ms; Date.now() < end;) { if (ok()) return; await new Promise((r) => setTimeout(r, 25)); }
  assert.fail(`timed out waiting for ${what}`);
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }; // signal 0 sends nothing

test('a harness that exits mid-check retires the record at that moment, so the tombstone covers an orphan started late', { timeout: 60000 }, async () => {
  ownSpawnRegistry();
  const harness = spawn(process.execPath, [HARNESS, 'soft', '-e', 'setTimeout(() => {}, 4000)'], { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  harness.stdout.on('data', (d) => { out += d; });
  await new Promise((res) => harness.once('close', res));
  const [pidText, aliveAt] = out.trim().split(' ');
  const pid = Number(pidText);
  assert.ok(pid > 0, `the harness named no check pid: ${out}`);
  assert.deepStrictEqual(SR.list({ persist: false }).filter((r) => r.pid === pid), [], 'no live record is left for the check');
  const tomb = SR.tombstones().find((t) => t.pid === pid);
  assert.ok(tomb, 'a tombstone names the check');
  assert.strictEqual(tomb.kind, 'check');
  assert.ok(tomb.until >= Number(aliveAt), `the lifetime closed at ${tomb.until}, before the check was seen alive at ${aliveAt}`);
  await waitFor(() => !alive(pid), 15000, 'the check to end by itself'); // it ends by its own timer; nothing is killed by pid
});

test('a live check record is stamped at spawn and every second after', { timeout: 60000 }, async () => {
  ownSpawnRegistry();
  const CR = core('check-register.cjs');
  let child = null;
  const run = runCommand([process.execPath, '-e', 'setTimeout(() => {}, 400)'], os.tmpdir(), 30000, { register: 'check', onChild: (c) => { child = c; } });
  const file = path.join(SR.dir(), `${child.pid}.json`);
  const first = JSON.parse(fs.readFileSync(file, 'utf8')).seen_at;
  assert.ok(Number.isFinite(first), 'stamped at the spawn');
  CR.stamp(first + 1500); // the 30 s guard of a worker's touch does not apply
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).seen_at, first + 1500);
  await run;
});

// The owner is hard-killed (TerminateProcess: no exit handler runs) while its check has a detached process of its own, started 3 s in.
// A new owner must still refuse that process, so the check's lifetime must close at a stamp under the 2 s slack before the kill.
test('a hard-killed owner mid-check: a process the check started after its first seconds is refused by a new owner', { skip: SKIP, timeout: 120000 }, async () => {
  ownSpawnRegistry();
  const dir = sandbox();
  const f = (n) => path.join(dir, n);
  const harness = spawn(process.execPath, [HARNESS, 'hold', path.join(__dirname, '..', 'helpers', 'late-check.cjs'), f('flag'), f('started'), f('port'), f('out')], { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  harness.stdout.on('data', (d) => { out += d; });
  const closed = new Promise((res) => harness.once('close', res));
  try {
    await waitFor(() => /\n/.test(out), 20000, 'the harness to report its check');
    const checkPid = Number(out.trim().split(' ')[0]);
    await waitFor(() => fs.existsSync(f('started')), 20000, 'the check to start its detached process');
    harness.kill(); // a hard kill on Windows
    await closed;
    fs.writeFileSync(f('flag'), 'x'); // the check ends now, with nothing to observe it
    await waitFor(() => !alive(checkPid), 20000, 'the check to end');
    await withOwner(async (o) => {
      fs.writeFileSync(f('port'), String(o.tcpPort));
      await waitFor(() => fs.existsSync(f('out')), 60000, 'the detached process to get an answer');
      const forged = JSON.parse(fs.readFileSync(f('out'), 'utf8').trim().split('\n').pop());
      assert.strictEqual(forged.error && forged.error.code, 'E_UNBOUND', `the check's orphan was vouched for as the operator: ${JSON.stringify(forged)}`);
      assert.strictEqual(o.store.db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE text LIKE 'forged%'").get().n, 0);
    });
  } finally { cleanup(dir); }
});
