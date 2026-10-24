'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// run-wake.test.cjs — build step 5b, Done item 3. Drives
// the built CLI as a subprocess with tests/run/fakes/fake-claude.cjs standing in for the orchestrator,
// exactly as tests/cli/run-paths.test.cjs drives every case, and a real RunManager in THIS process
// standing in for the orchestrator's own adapter spawning workers: a core opened as
// { role: 'orchestrator', run_id, pid } on the same data dir connects to the CLI's already-elected
// owner over the pipe, and createRunManager wraps it exactly as an attached orchestrator would. Every
// assertion is about the receipt or the store; a `stream.jsonl` match on the orchestrator's own
// output is the arrival of a wake (the fake echoes what reached its stdin), never its intent.
//
// Run this file with --test-timeout=120000 (`node --test --test-timeout=120000
// tests/cli/run-wake.test.cjs`): several tests spawn a real CLI subprocess and a real store owner, and
// a lone run has no other bound on a stuck one. 5b-3 (FINDINGS.json note, tests/cli/run-wake.test.cjs
// line 146): every `waitUntil` below bounds the read it wraps with its own 5,000 ms race, so a hung
// store read fails the assertion that used it rather than the suite itself hanging — see the
// scaffolding test near the end of this file.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { openCore } = require('../../src/core/index.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { wakeText } = require('../../src/run/wake.cjs');
const P = require('../../src/run/process.cjs');
const { cleanupRun } = require('./run-teardown.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const USER_SETTINGS = `${ROOT}/tests/run/fixtures/user-settings.json`;

// ---------------------------------------------------------------- scaffolding (as run-paths.test.cjs)

const fwd = (p) => String(p).split(path.sep).join('/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sandbox() { return fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-wake-'))); }

function cleanup(dir) {
  for (let i = 0; i < 5; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { process.emitWarning(`sandbox left behind at ${dir}: ${e.code || e.message}`); }
}

// A3: the read `fn` wraps (a store read, a file read) is raced against this bound. A read that has
// not settled after READ_BOUND_MS is a hung read, not a slow one, and ends the wait with `null` at
// once instead of being retried — a caller whose own assertion depended on a real value then fails on
// that assertion, rather than the whole suite hanging on a read that will never come back.
const READ_BOUND_MS = 5000;

function boundedRead(fn) {
  return () => new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ hung: true });
    }, READ_BOUND_MS);
    Promise.resolve().then(fn).then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ hung: false, value: v }); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve({ hung: false, value: null }); } }
    );
  });
}

async function waitUntil(fn, timeoutMs, stepMs = 100) {
  const t0 = Date.now();
  const read = boundedRead(fn);
  for (;;) {
    const r = await read();
    if (r.hung) return null; // a hung read fails the wait at once; it is never retried
    if (r.value) return r.value;
    if (Date.now() - t0 >= timeoutMs) return null;
    await sleep(stepMs);
  }
}

function waitForFileLine(filePath, needle, timeoutMs) {
  return waitUntil(() => {
    let text = '';
    try { text = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
    return text.includes(needle) ? true : null;
  }, timeoutMs, 100);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

function makeSpec(dir, overrides = {}) {
  const wt = `${dir}/wt`;
  fs.mkdirSync(wt, { recursive: true });
  const promptFile = `${dir}/prompt.txt`;
  fs.writeFileSync(promptFile, 'line one of the prompt\nline two of the prompt\n');
  const runId = overrides.run_id || `run-wake-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const orchestratorDir = overrides.orchestrator_dir || `${dir}/orch`;
  const spec = {
    worktree: wt, prompt_file: promptFile, run_id: runId, orchestrator_dir: orchestratorDir,
    startup_timeout_ms: 20000, on_embedder_failure: 'continue', ...overrides,
  };
  const specPath = `${dir}/spec.json`;
  fs.writeFileSync(specPath, JSON.stringify(spec));
  return { specPath, wt, promptFile, runId, orchestratorDir };
}

function runCli(specPath, dataDir, env) {
  const proc = spawn(process.execPath, [CLI, 'run', specPath, '--data', dataDir, '--json'], {
    cwd: ROOT, env: { ...process.env, ...env }, windowsHide: true,
  });
  let stdout = ''; proc.stdout.on('data', (d) => { stdout += d; });
  let stderr = ''; proc.stderr.on('data', (d) => { stderr += d; });
  return { proc, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

// The dispatcher writes a non-zero-code receipt to stderr, a zero-code one to stdout.
function receiptOf(run, exitCode) {
  return JSON.parse(exitCode === 0 ? run.stdout : run.stderr);
}

// -------------------------------------------------------- this file's own scaffolding

// The test's own RunManager stands in for the orchestrator's adapter: a core opened as role
// `orchestrator` on the CLI's data dir connects to the CLI's already-elected owner over the pipe
// (invariant 2: only a write elects, and the CLI elected first).
async function connectOrchestratorCore(dataDir, runId) {
  return require('../helpers/bound-orchestrator.cjs').connectBoundOrchestrator(dataDir, runId, { waitMs: 10000 });
}

function workerWorktree(dir, id) {
  const wt = `${dir}/${id}-wt`;
  fs.mkdirSync(wt, { recursive: true });
  return wt;
}

// Polls the store (not the in-memory record) for a worker's row once it carries a pid — the fact the
// orchestrator's own poll reads. Used for a worker spawned with FAKE_HANG=1, whose `m.spawn` promise
// never resolves on its own (the fake produces no ready event at all) and is fired without an await.
async function waitForWorkerPid(core, workerId, timeoutMs) {
  return waitUntil(async () => {
    try {
      const w = await core.worker.get({ worker_id: workerId });
      return w && w.pid && w.pid_created ? w : null; // ADR 0039: the crash below needs the row's own creation time
    } catch { return null; }
  }, timeoutMs, 50);
}

// ================================================================ the test

// The pid poll holds a death for the child's exit event (exit-hold.cjs). An idle orchestrator's close must outlast
// that hold (DEATH_GRACE_MS), or the dead row lands after stdin is closed and the death is never announced. Here the
// worker is ready and mid-turn, its exit event is held back 3,000 ms (the grace was 1,500 ms), and the wake must
// still arrive, carrying the integer exit code.
test('run: a worker whose exit event trails its death by 3,000 ms still wakes an idle orchestrator, with the exit code', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId, orchestratorDir } = makeSpec(dir, { poll_ms: 300 });
  // the run's owner vouches for this test by its process before it binds it (ADR 0045): the first answer waits for the gate, written once the setup is done
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_DELAY_MS: '1500', FAKE_ANSWER_GATE_FILE: `${dir}/orch.gate` };
  const runCliProc = runCli(specPath, dataDir, env);
  let core = null; let m = null; const spawnedPids = [];
  try {
    core = await connectOrchestratorCore(dataDir, runId);
    m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE_CLAUDE, userSettings: USER_SETTINGS } });

    process.env.FAKE_ANSWER_DELAY_MS = '120000'; // ready at once, mid-turn for the whole test
    let row;
    try { row = await m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' }); }
    finally { delete process.env.FAKE_ANSWER_DELAY_MS; }
    spawnedPids.push({ pid: row.pid, created: row.pid_created });
    fs.writeFileSync(`${dir}/orch.gate`, '');

    const gotResult = await waitForFileLine(`${orchestratorDir}/stream.jsonl`, '"type":"result"', 15000);
    assert.ok(gotResult, "the orchestrator's own first turn never ended");
    await sleep(2 * 300);

    const child = m._worker('w1').child;
    const emit = child.emit;
    child.emit = function (ev, ...a) { // the exit event, 3,000 ms late
      if (ev === 'exit') { setTimeout(() => emit.call(this, ev, ...a), 3000); return true; }
      return emit.call(this, ev, ...a);
    };
    assert.ok(require('../crash.cjs').crash(child), 'the worker was not killed');

    const exited = await waitForExit(runCliProc.proc, 25000);
    assert.ok(exited, 'the CLI did not exit in time');
    assert.strictEqual(exited.code, 0, `stdout: ${runCliProc.stdout}, stderr: ${runCliProc.stderr}`);
    const receipt = receiptOf(runCliProc, 0);
    assert.strictEqual(receipt.wakes.length, 1, JSON.stringify(receipt.wakes));
    const w = receipt.wakes[0];
    assert.strictEqual(w.event, 'death');
    assert.strictEqual(w.worker_id, 'w1');
    assert.ok(Number.isInteger(w.exit_code), JSON.stringify(w));
    assert.match(w.death_established_by, /exit-event/);
  } finally {
    await cleanupRun({ m, core, cliProc: runCliProc, spawnedPids, dir, runId, cleanup });
  }
});
