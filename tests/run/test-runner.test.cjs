'use strict';
// Build step H1: scripts/test.cjs runs each phase under a
// wall-clock bound and, on expiry, stops that phase's exact child pid with its tree.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const P = require('../../src/run/process.cjs');
const { runPhase, runPhases, concurrencyFromEnv } = require('../../scripts/test.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const HANG = fwd(path.resolve(__dirname, 'fixtures', 'hang-fixture.cjs'));
const PASS = fwd(path.resolve(__dirname, 'fixtures', 'pass-fixture.cjs'));
const PROBE = fwd(path.resolve(__dirname, 'fixtures', 'runphase-probe.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The phase runs a nested `node --test`; inside this test file that would see NODE_TEST_CONTEXT and act
// as a reporting child of ours, so the variable is removed for the nested run and restored after.
async function withNestedEnv(extra, fn) {
  const saved = {};
  for (const k of ['NODE_TEST_CONTEXT', ...Object.keys(extra)]) saved[k] = process.env[k];
  delete process.env.NODE_TEST_CONTEXT;
  Object.assign(process.env, extra);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

async function waitDead(pid, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (!P.pidAlive(pid)) return true; await sleep(100); }
  return !P.pidAlive(pid);
}

// Whatever runPhase did, the fixture's two pids are stopped by exact pid (the fixture also ends itself
// after 30 s), so a broken runPhase cannot leave this test file hanging.
function stopFixturePids(pidsFile) {
  let pids = null;
  try { pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8')); } catch { return null; }
  try { require('../crash.cjs').crashDescendants([pids.child, pids.grandchild].filter((p) => P.pidAlive(p))); } catch { /* best effort */ }
  return pids;
}

test('test-runner: a hung phase is stopped by exact pid, its tree included, within the bound', async () => {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-h1-runner-')));
  const pidsFile = `${dir}/pids.json`;
  let pids = null;
  try {
    const t0 = Date.now();
    const r = await withNestedEnv({ H1_PIDS_FILE: pidsFile }, () => runPhase([HANG], { timeoutMs: 2000 }));
    const took = Date.now() - t0;
    assert.strictEqual(r.timed_out, true, `the hung phase must report timed_out: ${JSON.stringify(r)}`);
    assert.strictEqual(r.status, 124);
    assert.ok(!r.stop_failed, `the tree must be confirmed stopped: ${JSON.stringify(r)}`);
    // timeoutMs is 2000. A phase that was not stopped runs until the fixture ends itself at 30 s, so 20,000 separates the two; the
    // old 10,000 left a loaded runner (7.2 s for this whole test) under 3 s of room.
    assert.ok(took < 20000, `runPhase took ${took} ms, over the 20,000 ms bound`);
    assert.ok(fs.existsSync(pidsFile), 'the fixture never wrote its pids: it was stopped before it started, so the tree claim is unchecked');
    pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
    assert.ok(await waitDead(pids.child, 5000), `fixture child pid ${pids.child} is still alive`);
    assert.ok(await waitDead(pids.grandchild, 5000), `fixture grandchild pid ${pids.grandchild} is still alive: the tree was not stopped`);
  } finally {
    stopFixturePids(pidsFile);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('test-runner: a passing phase returns its status and leaves no timer', async () => {
  // The probe runs one passing phase under a 120,000 ms bound and then lets its event loop drain. A
  // timer left pending would keep it alive far past the 45 s allowed here.
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const probe = spawn(process.execPath, [PROBE, PASS], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = ''; probe.stdout.on('data', (d) => { out += d; });
  const t0 = Date.now();
  const exited = await new Promise((resolve) => {
    const guard = setTimeout(() => resolve(false), 45000);
    probe.once('exit', () => { clearTimeout(guard); resolve(true); });
  });
  try {
    assert.ok(exited, 'the probe process was still alive 45 s after its passing phase returned: a timer is pending');
    const m = out.match(/^RESULT (.+)$/m);
    assert.ok(m, `no RESULT line: ${out.slice(-500)}`);
    const r = JSON.parse(m[1]);
    assert.strictEqual(r.status, 0, JSON.stringify(r));
    assert.strictEqual(r.timed_out, false);
    assert.ok(Date.now() - t0 < 45000);
  } finally {
    if (probe.exitCode === null && probe.signalCode === null) { try { require('../crash.cjs').crash(probe); } catch { /* best effort */ } }
  }
});

test('test-runner: a phase whose tree could not be stopped reports stop_failed and phase 2 is not started', async () => {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-h1-runner-')));
  const pidsFile = `${dir}/pids.json`;
  const seen = [];
  const stub = async (target) => { seen.push(target); return { ok: false, error: 'stubbed killTree failure' }; };
  try {
    const r = await withNestedEnv({ H1_PIDS_FILE: pidsFile }, () => runPhase([HANG], { timeoutMs: 1500, killTreeImpl: stub }));
    assert.strictEqual(r.timed_out, true, JSON.stringify(r));
    assert.strictEqual(r.status, 124);
    assert.strictEqual(r.stop_failed, true, `a failed killTree must be reported: ${JSON.stringify(r)}`);
    assert.strictEqual(typeof seen[0], 'object', 'ADR 0039: the runner hands the kill its live child handle, never a bare pid');
    assert.strictEqual(seen[0].exitCode, null);
    const stopped = stopFixturePids(pidsFile); // the stub stopped nothing: end the fixture (and so the dispatcher) by its place in this test's own process tree
    assert.ok(stopped && await waitDead(stopped.child, 8000) && await waitDead(stopped.grandchild, 8000), 'ADR 0039: stopFixturePids really stopped the fixtures');

    const dir2 = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-h1-runner-')));
    try {
      const all = await withNestedEnv({ H1_PIDS_FILE: `${dir2}/pids.json` }, () => runPhases({ globs1: [HANG], glob2: PASS, timeout1: 1500, timeout2: 60000, killTreeImpl: stub }));
      stopFixturePids(`${dir2}/pids.json`);
      assert.strictEqual(all.p1.stop_failed, true);
      assert.strictEqual(all.p2, null, 'phase 2 must not start when phase 1 could not be stopped');
      assert.strictEqual(all.code, 1);
    } finally { stopFixturePids(`${dir2}/pids.json`); fs.rmSync(dir2, { recursive: true, force: true }); }
  } finally {
    stopFixturePids(pidsFile);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stopFixturePids really stops a live fixture and its detached grandchild (ADR 0039: by place in this process\'s own tree)', async (t) => {
  if (process.platform !== 'win32') return t.skip('the process tree comes from the CIM snapshot');
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-h1-stopfix-')));
  const pidsFile = `${dir}/pids.json`;
  const env = { ...process.env, H1_PIDS_FILE: pidsFile }; delete env.NODE_TEST_CONTEXT;
  const holder = spawn(process.execPath, [HANG], { env, stdio: 'ignore', windowsHide: true });
  try {
    // The fixture writes the file in place, so it can exist before its content does: wait for a parseable file.
    let pids = null;
    for (let i = 0; i < 200 && !pids; i++) { try { pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8')); } catch { await sleep(50); } }
    assert.ok(pids, 'the fixture never wrote its pids');
    await sleep(300);
    assert.ok(P.pidAlive(pids.child) && P.pidAlive(pids.grandchild), 'both fixture pids start alive');
    stopFixturePids(pidsFile);
    assert.ok(await waitDead(pids.child, 5000), 'the fixture child is still alive');
    assert.ok(await waitDead(pids.grandchild, 5000), 'the fixture grandchild is still alive');
  } finally { if (holder.exitCode === null) holder.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// A test directory that no phase glob names is a suite that never runs (the panel's tests were in none for a time).
test('every tests/<dir> that holds a *.test.cjs file is named by a phase glob', () => {
  const { PHASE1_GLOBS, PHASE2_GLOB } = require('../../scripts/test.cjs');
  const named = new Set([...PHASE1_GLOBS, PHASE2_GLOB].map((g) => g.split('/')[1]));
  const root = path.resolve(__dirname, '..');
  const holds = (dir) => fs.readdirSync(dir, { withFileTypes: true }).some((e) => (e.isFile() && /\.test\.cjs$/.test(e.name)) || (e.isDirectory() && e.name !== 'fixtures' && holds(path.join(dir, e.name))));
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && holds(path.join(root, e.name))).map((e) => e.name);
  assert.ok(dirs.includes('mod') && dirs.includes('core'), 'the scan sees the directories');
  // acceptance rows run by `npm run test:acceptance`, not by a glob
  assert.deepStrictEqual(dirs.filter((d) => !named.has(d) && d !== 'acceptance'), []);
});

// BELAY_TEST_CONCURRENCY: a fake spawn captures each phase's argv; no real test phase runs.
function fakeSpawn(argvs) {
  const { EventEmitter } = require('node:events');
  return (_exe, argv) => { argvs.push(argv); const c = new EventEmitter(); c.pid = 0; c.exitCode = null; c.signalCode = null; setImmediate(() => { c.exitCode = 0; c.emit('exit', 0, null); c.emit('close', 0); }); return c; };
}
const flagOf = (argv) => argv.filter((a) => a.startsWith('--test-concurrency'));

test('test-runner: a valid concurrency is passed to the node --test argv of both phases', async () => {
  const argvs = [];
  await runPhases({ globs1: ['a'], glob2: 'b', guard: false, concurrency: 3, spawnImpl: fakeSpawn(argvs) });
  assert.strictEqual(argvs.length, 2);
  for (const a of argvs) assert.deepStrictEqual(flagOf(a), ['--test-concurrency=3']);
});

test('test-runner: no concurrency means no flag on either phase', async () => {
  const argvs = [];
  await runPhases({ globs1: ['a'], glob2: 'b', guard: false, concurrency: null, spawnImpl: fakeSpawn(argvs) });
  assert.strictEqual(argvs.length, 2);
  for (const a of argvs) assert.deepStrictEqual(flagOf(a), []);
});

test('test-runner: BELAY_TEST_CONCURRENCY is read as a positive integer; anything else is ignored with a log line', () => {
  const run = (v) => { const lines = []; const n = concurrencyFromEnv(v === undefined ? {} : { BELAY_TEST_CONCURRENCY: v }, (l) => lines.push(l)); return { n, lines }; };
  assert.deepStrictEqual(run('4'), { n: 4, lines: [] });
  assert.deepStrictEqual(run(undefined), { n: null, lines: [] });
  for (const bad of ['0', '-1', 'abc', '1.5']) {
    const r = run(bad);
    assert.strictEqual(r.n, null, bad);
    assert.strictEqual(r.lines.length, 1, bad);
    assert.match(r.lines[0], /BELAY_TEST_CONCURRENCY.*ignored/, bad);
  }
});
