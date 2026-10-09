'use strict';
// status-text.test.cjs — build step 4a-2, design item
// 2(b): round-2 finding 2 noted that no test in the suite ever drives `belay status`/`belay workers`
// without --json, so renderText, the workers table and the `(no workers)` line were never asserted.
// This file drives the built CLI in text mode with the scaffolding of tests/cli/status.test.cjs and
// tests/cli/stop-helpers.cjs, every planted process killed by exact pid and every elected owner shut
// down in a finally.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');

const P = require('../../src/run/process.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { ROOT, CLI, sandbox, cleanup, listRecursive } = require('./stop-helpers.cjs');

const RUNGS = ['configured', 'store-present', 'owner-alive', 'run-alive', 'worker-alive', 'worker-responsive'];
const COLUMNS = [
  'id', 'substrate', 'pid', 'state', 'pid_alive', 'mid_turn', 'turns',
  'last_event_age_ms', 'input_tokens', 'output_tokens', 'cost_usd', 'death_established_by',
];

// A pid that is certainly dead by the time it is used: a child that has already exited, never a
// made-up number (pids are recycled).
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
  return r.pid;
}

function statusTextOf(runId, dataDir) {
  return spawnSync(process.execPath, [CLI, 'status', runId, '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
}

// Amendment A1, carried by the 4a-2 brief's design item
// 2(b) into this file too ("every invocation bracketed by the listing comparison A1 fixed"): reading
// never writes (invariant 6) is asserted around every belay status/workers invocation below, by the
// sorted list of relative NAMES only (immune to the owner's own background heartbeat/WAL churn), the
// same comparison tests/cli/status.test.cjs's checkedStatusJson/checkedWorkersJson use.
function withListingCheck(dataDir, label, fn) {
  const before = listRecursive(dataDir);
  const r = fn();
  assert.deepStrictEqual(listRecursive(dataDir), before, `${label}: changed the data dir listing`);
  return r;
}

let dir = null;
let dataDir = null;
let liveProc = null;
let deadAdapterPid = null;
let ended = { ended_at: null, exit_reason: null };

// Three run rows planted through a core opened as role orchestrator on the sandbox's data dir, then
// shut down before any read below, so every belay status/workers invocation in this file takes the
// copy path (invariant 6). Shared by both named tests, so it runs once for the file.
before(async () => {
  dir = sandbox();
  dataDir = `${dir}/.belay`;
  liveProc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve) => liveProc.once('spawn', resolve));
  deadAdapterPid = deadPid();

  // Round-2 finding 1 (re-opened by this file, closed here): the three cores must be declared before
  // the try and shut down in a finally, not left as `const` opened outside any try — otherwise a throw
  // between opening any of them and this loop (a regression in run.attach, run.end, worker.write or
  // openCore, all owned files of the step this file belongs to) leaves the elected owner alive: pipe
  // server listening, owner.lock held, sqlite handle open, and `node --test` never exits instead of
  // turning red. The shutdown lives in before()'s OWN finally, not after()'s, so it runs even when
  // before() throws and after() is never reached (after() has no way to see these cores at all — they
  // are local to before()).
  let a = null;
  let b = null;
  let c = null;
  try {
    a = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-dead-adapter', pid: process.pid } });
    await a.run.attach({ adapter_pid: deadAdapterPid });

    b = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-ended', pid: process.pid } });
    await b.run.attach({ adapter_pid: deadAdapterPid });
    await b.run.end({ exit_reason: 'closed for the status-text fixture' });

    c = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-live', pid: process.pid } });
    await c.run.attach({ adapter_pid: liveProc.pid });
    await c.worker.write({
      id: 'w1', substrate: 'claude-code', pid: liveProc.pid, pid_image: 'node.exe', state: 'running',
      turns: 3, mid_turn: 1, input_tokens: 10, output_tokens: 20, cost_usd: 0.05, started_at: Date.now(),
    });
  } finally {
    for (const core of [a, b, c]) {
      if (core) { try { await core.shutdownOwner(); } catch { /* best effort */ } try { await core.close(); } catch { /* best effort */ } }
    }
  }

  // The ended run's number and reason are read back from the JSON form of the same read (the brief's
  // own rule), not guessed by this file, so the text-mode comparison below compares against what the
  // store actually recorded. Bracketed like every other invocation in this file (A1).
  const r = withListingCheck(dataDir, 'status run-ended --json', () => spawnSync(
    process.execPath, [CLI, 'status', 'run-ended', '--data', dataDir, '--json'],
    { cwd: ROOT, windowsHide: true, encoding: 'utf8' },
  ));
  assert.strictEqual(r.status, 0, `status run-ended --json: ${r.stdout} / ${r.stderr}`);
  const j = JSON.parse(r.stdout);
  ended = { ended_at: j.run.ended_at, exit_reason: j.run.exit_reason };
});

after(() => {
  if (liveProc && P.pidAlive(liveProc.pid)) { try { require('../crash.cjs').crash(liveProc); } catch { /* best effort */ } }
  if (dir) cleanup(dir);
});

test('status text: an open row with a dead adapter pid reads not running, an ended run reads ended, a live row reads alive, and every line is a rung or a named fact', () => {
  const cases = [
    ['run-dead-adapter', `run: run-dead-adapter epoch 1 not running: adapter pid ${deadAdapterPid} is not alive, and the run was never ended`],
    ['run-ended', `run: run-ended epoch 1 ended at ${ended.ended_at}: ${ended.exit_reason}`],
    ['run-live', 'run: run-live epoch 1 alive'],
  ];
  for (const [runId, expectedRunLine] of cases) {
    const r = withListingCheck(dataDir, `status ${runId}`, () => statusTextOf(runId, dataDir));
    assert.strictEqual(r.status, 0, `status ${runId}: ${r.stdout} / ${r.stderr}`);
    const lines = r.stdout.split(/\r?\n/).filter((l) => l.length > 0);
    assert.deepStrictEqual(lines.slice(0, 6).map((l) => l.split(/\s{2,}/)[0]), RUNGS, `${runId}: rung lines out of order:\n${r.stdout}`);
    assert.ok(lines[6].startsWith('verdict: '), `${runId}: line 7 must be verdict::\n${r.stdout}`);
    assert.ok(lines[7].startsWith('established_by: '), `${runId}: line 8 must be established_by::\n${r.stdout}`);
    assert.strictEqual(lines[8], expectedRunLine, `${runId}: the run: line must match exactly`);
    assert.match(lines[9], /^store: schema 1, last written by belay@\S+\+(?:[0-9a-f]{12}|unknown)$/, `${runId}: the store: line must name the stamp:\n${r.stdout}`);
    assert.strictEqual(lines.length, 10,`${runId}: unexpected extra lines:\n${r.stdout}`);
    assert.ok(!r.stdout.includes('null'), `${runId}: text output must name every fact, never print the literal "null":\n${r.stdout}`);
  }
});

test('workers text: the table carries the twelve columns in order and an empty store prints (no workers)', () => {
  const r = withListingCheck(dataDir, 'workers run-live', () => spawnSync(
    process.execPath, [CLI, 'workers', 'run-live', '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' },
  ));
  assert.strictEqual(r.status, 0, `workers run-live: ${r.stdout} / ${r.stderr}`);
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.length > 0);
  assert.deepStrictEqual(lines[0].trim().split(/\s{2,}/), COLUMNS, `header mismatch:\n${r.stdout}`);
  assert.strictEqual(lines.length, 2, `expected the header plus exactly one planted worker row:\n${r.stdout}`);
  assert.match(lines[1], /^w1\s/, `the worker row must start with the planted worker id w1:\n${r.stdout}`);

  const emptyDir = sandbox();
  const emptyDataDir = `${emptyDir}/.belay-empty`;
  try {
    const re = withListingCheck(emptyDataDir, 'workers (empty store)', () => spawnSync(
      process.execPath, [CLI, 'workers', '--data', emptyDataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' },
    ));
    assert.strictEqual(re.status, 0, `workers (empty store): ${re.stdout} / ${re.stderr}`);
    assert.strictEqual(re.stdout, '(no workers)\n');
  } finally {
    cleanup(emptyDir);
  }
});

test('status text: no store prints no store line, and a store that predates the stamp prints schema 1, unstamped', () => {
  const { Store } = require('../../src/core/store.cjs');
  const d = sandbox();
  try {
    // (a) an empty data dir: no memory.db, so nothing to say about a stamp.
    const empty = `${d}/.belay-empty`;
    require('node:fs').mkdirSync(empty, { recursive: true });
    const a = withListingCheck(empty, 'status (no store)', () => spawnSync(process.execPath, [CLI, 'status', '--data', empty], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }));
    assert.strictEqual(a.status, 0, `${a.stdout} / ${a.stderr}`);
    assert.ok(!/^store:/m.test(a.stdout), `no store, so no store: line:\n${a.stdout}`);
    const aj = JSON.parse(spawnSync(process.execPath, [CLI, 'status', '--data', empty, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }).stdout);
    assert.strictEqual(aj.store, null);

    // (b) a legacy store: tables and no stamp (a plain Store open stamps nothing).
    const legacy = `${d}/.belay-legacy`;
    new Store(`${legacy}/memory.db`).close();
    const b = withListingCheck(legacy, 'status (legacy store)', () => spawnSync(process.execPath, [CLI, 'status', '--data', legacy], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }));
    assert.strictEqual(b.status, 0, `${b.stdout} / ${b.stderr}`);
    assert.match(b.stdout, /^store: schema 1, unstamped \(written before the stamp existed\)$/m);
    assert.ok(!b.stdout.includes('null'), b.stdout);
    const bj = JSON.parse(spawnSync(process.execPath, [CLI, 'status', '--data', legacy, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }).stdout);
    assert.deepStrictEqual(bj.store, { schema_version: null, written_by: null });
  } finally { cleanup(d); }
});
