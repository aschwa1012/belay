'use strict';
// cli-budgets.test.cjs — build step 0018-gate-2,
// implementing ADR 0018 amendment 1. Every spawned-process budget gate lives here, in a directory
// package.json's four `test` globs do not reach: `npm test` runs this file in a second, sequential
// phase with nothing else of belay's running, so the floor and the commands it gates see the same
// load window. Each gate samples interleaved (tests/cli/budget.cjs's `interleaved`): one spawn of the
// empty script immediately before each command spawn, byte-identical spawnSync options except the
// script argument, seven rounds, one assertion at the end over every command in the group, naming
// every miss.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { openCore } = require('../../src/core/index.cjs');
const { emptyScript, interleaved, SPAWN_OVER_FLOOR_MS } = require('../cli/budget.cjs');
const { listRecursive } = require('../cli/stop-helpers.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const N = 7;

function sandbox() { return fs.mkdtempSync(path.join(os.tmpdir(), 'belay-budgets-')).split(path.sep).join('/'); }

function cleanup(dir) {
  for (let i = 0; i < 5; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { process.emitWarning(`sandbox left behind at ${dir}: ${e.code || e.message}`); }
}

// A sandbox that looks like a project root, so config discovery has somewhere to stop that is not the
// home directory (the config-path/doctor/mcp-status cold-start fixture, as tests/cli/slice-3a.test.cjs
// used to plant it).
function projectSandbox() {
  const dir = sandbox();
  fs.writeFileSync(`${dir}/package.json`, JSON.stringify({ name: 'sandbox-project' }), 'utf8');
  fs.mkdirSync(`${dir}/.git`, { recursive: true });
  return dir;
}

const vec = (seed) => Array.from({ length: 384 }, (_, i) => (((i + seed) % 7) + 1) / 10);

// The plant recipe of tests/cli/observe.test.cjs, unchanged: run.attach, worker.write (w1, this
// process's own live pid), two tasks (the second depends_on the first), the first assigned to w1 and
// checkpointed, three memory rows with a supplied embedding, the owner shut down in a finally. The
// core handle is declared before the try so the finally can always reach it. Build step 4c: a 30-line
// stream.jsonl for w1, so the `logs` gate below reads a real tail rather than a missing file.
async function plant(dataDir, runId, pid) {
  let memoryId = null;
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
  try {
    await core.run.attach({ adapter_pid: pid });
    await core.usage.record({ worker_id: 'w1', turn: 1, substrate: 'claude-code', model: 'sonnet', input_tokens: 10, output_tokens: 5, cost_usd: 0.01, cost_basis: 'delta-of-cumulative' }); // the ledger `usage` reads
    await core.worker.write({ id: 'w1', substrate: 'claude-code', pid, state: 'running', turns: 0, started_at: Date.now() });
    const t1 = await core.task.create({ spec: 'first task, assigned to w1 and checkpointed' });
    await core.task.create({ spec: 'second task, depends on the first', depends_on: [t1.id] });
    await core.task.assign({ task_id: t1.id, worker_id: 'w1' });
    await core.continuity.checkpoint({ task_id: t1.id, worker_id: 'w1', turn: 1, files_touched: ['a.txt'] });
    for (let i = 0; i < 3; i += 1) {
      const stored = await core.memory.store({ namespace: `run/${runId}`, text: `note ${i} about task ${t1.id}`, tags: [t1.id], embedding: vec(i), embedding_model: 'fixture', dim: 384 });
      if (i === 0) memoryId = stored.id;
    }
  } finally {
    await core.shutdownOwner();
    await core.close();
  }
  const streamDir = `${dataDir}/workers/w1`;
  fs.mkdirSync(streamDir, { recursive: true });
  const lines = [];
  for (let i = 1; i <= 30; i += 1) lines.push(`${JSON.stringify({ line: i })}\n`);
  fs.writeFileSync(`${streamDir}/stream.jsonl`, lines.join(''));
  return { memoryId };
}

// One belay invocation, spawned with the exact options `makeSpawnFloor` below builds its paired floor
// spawn from (cwd, encoding, windowsHide, timeout, env): the subtraction is of byte-identical spawns
// except the script/command argument.
function spawnCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd || ROOT, encoding: 'utf8', windowsHide: true, timeout: 20000,
    env: { ...process.env, ...(opts.env || {}) },
  });
}

// listingDir, when given, brackets the sample with a before/after listRecursive check (invariant 6:
// reading never writes) — the same bracket status.test.cjs's and observe.test.cjs's `measure` keep
// around every sample of a command that reads the store.
function timedCli(args, opts, expectCode = 0, listingDir = null) {
  const beforeListing = listingDir ? listRecursive(listingDir) : null;
  const t0 = Date.now();
  const r = spawnCli(args, opts);
  const ms = Date.now() - t0;
  assert.strictEqual(r.status, expectCode, `${args.join(' ')} exited ${r.status}, expected ${expectCode}: ${r.stderr}`);
  if (listingDir) {
    assert.deepStrictEqual(listRecursive(listingDir), beforeListing, `${args.join(' ')} changed the data dir listing`);
  }
  return ms;
}

// Builds spawnFloor() with the same spawnSync options as the commands it will be interleaved with.
function makeSpawnFloor(opts = {}) {
  const script = emptyScript();
  return () => {
    const t0 = Date.now();
    spawnSync(process.execPath, [script], {
      cwd: opts.cwd || ROOT, encoding: 'utf8', windowsHide: true, timeout: 20000,
      env: { ...process.env, ...(opts.env || {}) },
    });
    return Date.now() - t0;
  };
}

const receipt = {};
const receiptsDir = path.join(__dirname, 'receipts');

// One JSON line per gate to stdout (a receipt taken with rr.cjs carries the numbers), and the running
// receipt file, gitignored like every other measurement sandbox (recorded limit: the committed
// artefact of these deltas is A12's receipt and the orchestrator's own commands.json).
function report(gate, result) {
  const commands = {};
  for (const [name, r] of Object.entries(result.commands)) {
    commands[name] = { min: r.min, median: r.median, over_floor_ms: r.over_floor_ms };
  }
  const line = { gate, floor: { min: result.floor.min, median: result.floor.median }, commands };
  console.log(JSON.stringify(line));
  receipt[gate] = line;
  fs.mkdirSync(receiptsDir, { recursive: true });
  fs.writeFileSync(path.join(receiptsDir, 'last.json'), JSON.stringify(receipt, null, 2));
}

// One assertion over every command in the group, naming every miss, not the first only.
function assertGate(result) {
  const misses = Object.entries(result.commands).filter(([, r]) => r.over_floor_ms >= SPAWN_OVER_FLOOR_MS);
  assert.ok(misses.length === 0, misses.map(([name, r]) =>
    `${name} min ${r.min} ms (median ${r.median} ms) is ${r.over_floor_ms} ms above the host floor `
    + `(min ${result.floor.min} ms, median ${result.floor.median} ms); samples ${r.samples.join(', ')}`,
  ).join(' | '));
}

let dir = null;
let dataDir = null;
let memoryId = null;
let projDir = null;
let noStoreDir = null;
let orchDir = null;
let txDir = null; // an interactive run's orchestrator dir: a launch marker and no stream
let txCfg = null; // the sandbox CLAUDE_CONFIG_DIR holding the ~10 MB transcript the marker names

before(async () => {
  dir = sandbox();
  dataDir = `${dir}/.belay`;
  ({ memoryId } = await plant(dataDir, 'run-budgets', process.pid));
  projDir = projectSandbox();
  noStoreDir = `${dir}/.belay-no-store`; // exists, holds no memory.db (build step 6h design item 6)
  fs.mkdirSync(noStoreDir, { recursive: true });
  // ADR 0036 U1: transcript and agents parse a long orchestrator stream (242 lines, generated), so
  // the gate measures their parsing, not a missing-file path.
  orchDir = `${dir}/orch`;
  fs.mkdirSync(orchDir, { recursive: true });
  require('../helpers/synthetic-stream.cjs').writeSyntheticStream(`${orchDir}/stream.jsonl`);
  // An interactive run's usage comes from its session transcript: the marker names a ~10 MB one under the sandbox
  // CLAUDE_CONFIG_DIR/projects (the run row's epoch is what the marker must carry).
  txDir = `${dir}/orch-interactive`;
  txCfg = `${dir}/claude-config`;
  fs.mkdirSync(txDir, { recursive: true });
  fs.mkdirSync(`${txCfg}/projects/p`, { recursive: true });
  const session = `${txCfg}/projects/p/s.jsonl`;
  require('../helpers/synthetic-transcript.cjs').writeSyntheticTranscript(session, 10);
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-budgets', pid: process.pid } });
  let epoch;
  try { epoch = (await core.run.list({})).runs.find((r) => r.id === 'run-budgets').epoch; } finally { await core.shutdownOwner(); await core.close(); }
  fs.writeFileSync(`${txDir}/run-start.json`, JSON.stringify({ run_id: 'run-budgets', epoch, mode: 'interactive', started_at: 1, launcher_pid: 1, session_id: 's', session_file: session }));
});

after(() => {
  cleanup(dir);
  cleanup(projDir);
});

test('budgets: --help and a usage error add under 500 ms to the host floor, interleaved (ADR 0018 amendment 1)', () => {
  const result = interleaved({
    spawnFloor: makeSpawnFloor(),
    commands: {
      help: () => timedCli(['--help'], {}, 0),
      usage_error: () => timedCli(['nosuchcommand'], {}, 2),
    },
    n: N,
  });
  report('help_usage_error', result);
  assertGate(result);
});

test('budgets: config path, doctor and mcp status each add under 500 ms to the host floor, interleaved', () => {
  const result = interleaved({
    spawnFloor: makeSpawnFloor({ cwd: projDir }),
    commands: {
      config_path: () => timedCli(['config', 'path'], { cwd: projDir }, 0),
      settings: () => timedCli(['settings'], { cwd: projDir }, 0),
      doctor: () => timedCli(['doctor'], { cwd: projDir }, 0),
      mcp_status: () => timedCli(['mcp', 'status'], { cwd: projDir }, 0),
    },
    n: N,
  });
  report('cold_start', result);
  assertGate(result);
});

test('budgets: status, workers, tasks, receipts, memory stats and reads (held --awaiting, a hybrid search among them), usage, briefing, logs (with --memory too) and diff each add under 500 ms to the host floor, interleaved, on a dead store', () => {
  const result = interleaved({
    spawnFloor: makeSpawnFloor(),
    commands: {
      status: () => timedCli(['status', '--data', dataDir], {}, 0, dataDir),
      workers: () => timedCli(['workers', '--data', dataDir], {}, 0, dataDir),
      tasks: () => timedCli(['tasks', '--data', dataDir], {}, 0, dataDir),
      receipts: () => timedCli(['receipts', '--data', dataDir], {}, 0, dataDir),
      memory_stats: () => timedCli(['memory', 'stats', '--data', dataDir], {}, 0, dataDir),
      memory_search_keyword: () => timedCli(['memory', 'search', 'about task', '--mode', 'keyword', '--index', 'run-budgets', '--data', dataDir], {}, 0, dataDir),
      // A hybrid search with no owner: the semantic half cannot embed the query and is named in modes_failed;
      // the keyword half answers from the copy, so the command still exits 0 and pays only the read path.
      memory_search_hybrid: () => timedCli(['memory', 'search', 'about task', '--mode', 'hybrid', '--index', 'run-budgets', '--data', dataDir], {}, 0, dataDir),
      memory_list: () => timedCli(['memory', 'list', 'run-budgets', '--index', '--data', dataDir], {}, 0, dataDir),
      memory_show: () => timedCli(['memory', 'show', memoryId, '--data', dataDir], {}, 0, dataDir),
      memory_timeline: () => timedCli(['memory', 'timeline', memoryId, '--data', dataDir], {}, 0, dataDir),
      memory_held_awaiting: () => timedCli(['memory', 'held', '--awaiting', '--data', dataDir], {}, 0, dataDir), // the panel's awaiting-notes read
      memory_export: () => timedCli(['memory', 'export', 'run-budgets', '--data', dataDir], {}, 0, dataDir),
      usage: () => timedCli(['usage', 'run-budgets', '--by', 'worker', '--data', dataDir], {}, 0, dataDir),
      briefing: () => timedCli(['briefing', 'w1', '--data', dataDir], {}, 0, dataDir),
      logs: () => timedCli(['logs', 'w1', '--tail', '5', '--data', dataDir], {}, 0, dataDir),
      logs_memory: () => timedCli(['logs', 'w1', '--tail', '5', '--memory', '--data', dataDir], {}, 0, dataDir),
      diff: () => timedCli(['diff', '--data', dataDir], {}, 0, dataDir),
    },
    n: N,
  });
  report('reads_dead_store', result);
  assertGate(result);
});

test('budgets: transcript, notices and agents (ADR 0036 U1) each add under 500 ms to the host floor, interleaved, on a dead store', () => {
  const result = interleaved({
    spawnFloor: makeSpawnFloor(),
    commands: {
      transcript: () => timedCli(['transcript', 'run-budgets', '--dir', orchDir, '--data', dataDir], {}, 0, dataDir),
      notices: () => timedCli(['notices', 'run-budgets', '--data', dataDir], {}, 0, dataDir),
      agents: () => timedCli(['agents', 'run-budgets', '--dir', orchDir, '--data', dataDir], {}, 0, dataDir),
      wake_stream: () => timedCli(['wake-stream', '--run', 'run-budgets', '--nonce', 'n', '--data', dataDir], {}, 1, dataDir), // no publisher: ENOENT at once, exit 1
    },
    n: N,
  });
  report('panel_reads_dead_store', result);
  assertGate(result);
});

// An interactive orchestrator's row reads its ~10 MB session transcript. The sample first proves the transcript was
// read (context tokens present), so the gate cannot pass by measuring a refusal; the bound is the same as every read's.
test('budgets: agents on an interactive run reading a ~10 MB session transcript adds under 500 ms to the host floor, interleaved', () => {
  const env = { CLAUDE_CONFIG_DIR: txCfg };
  const args = ['agents', 'run-budgets', '--dir', txDir, '--data', dataDir, '--json'];
  const probe = spawnCli(args, { env });
  assert.strictEqual(probe.status, 0, probe.stderr);
  const orch = JSON.parse(probe.stdout).agents.find((a) => a.role === 'orchestrator');
  assert.ok(orch.context_tokens > 0, `the transcript was not read: ${JSON.stringify({ n: orch.cost_note, p: orch.transcript_path })}`);
  const result = interleaved({
    spawnFloor: makeSpawnFloor({ env }),
    commands: { agents_transcript: () => timedCli(args, { env }, 0, dataDir) },
    n: N,
  });
  report('agents_interactive_transcript', result);
  assertGate(result);
});

// build step 6a-2: --run is gone from both verbs (design item 2): a lease belongs to its task's run,
// read from the task row itself, so there is nothing left for an argument to validate. Against this
// same dead store (the owner shut down in plant()'s own finally, so there is no owner.lock at all), the
// single mode-C call this file now makes — core.control('task.get', ...), the same connection the write
// would use — reads the lock and rejects E_NO_OWNER without ever dialling (src/core/index.cjs): the
// fast path this gate measures is that lock check, never a run.list read spent up front. The task and
// worker ids need not exist — E_NO_OWNER fires before either is ever looked at.
test('budgets: take-control and task assign each add under 500 ms to the host floor, interleaved, with no live owner', () => {
  const result = interleaved({
    spawnFloor: makeSpawnFloor(),
    commands: {
      take_control: () => timedCli(['take-control', 't1', '--data', dataDir], {}, 1, dataDir),
      task_assign: () => timedCli(['task', 'assign', 't1', 'w1', '--data', dataDir], {}, 1, dataDir),
    },
    n: N,
  });
  report('controls_no_owner', result);
  assertGate(result);
});

// build step 6h design item 6: a data dir that exists but holds no memory.db no longer routes through
// withCopy's mkdtemp-then-copy-then-rm — `_read` builds the engine over an in-memory store instead
// (src/core/index.cjs), so this no-argument path (run.list finds nothing, then a second read) stops
// costing the 82-108 ms over the floor A12 had recorded and never asserted since build step 4b. The
// listing bracket asserts the fixture directory stays empty: no file, no lock, no copy left behind.
//
// build step 6h had a second, tighter 65 ms bound here, a guard against a regression to the pre-6h
// copy-then-read path (82-108 ms over floor). ADR 0035 retires it: it failed at 66 ms on a quiet host
// against a 91 ms floor, which is the host noise the 500 ms bound exists for. The empty-directory
// assertion below is kept.

test('budgets: status and workers with no run id against a data dir with no store each add under 500 ms to the host floor, interleaved, creating nothing', () => {
  const result = interleaved({
    spawnFloor: makeSpawnFloor(),
    commands: {
      status: () => timedCli(['status', '--data', noStoreDir], {}, 0, noStoreDir),
      workers: () => timedCli(['workers', '--data', noStoreDir], {}, 0, noStoreDir),
    },
    n: N,
  });
  report('reads_no_store', result);
  assertGate(result);
  assert.deepStrictEqual(listRecursive(noStoreDir), [], 'the no-store fixture directory must stay empty');
});
