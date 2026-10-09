'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// run-election.test.cjs — three tests on the election and shutdown paths of `belay run`, owned by
// build step 5a-4: they share the same subprocess-driving scaffolding as tests/cli/run-paths.test.cjs and are
// kept in their own file only so that neither file approaches the 500-line repository limit, not
// because run-paths.test.cjs itself would have crossed it. Driven as a subprocess exactly as
// run-paths.test.cjs drives every case. Every assertion is about a derived fact, never about what the
// fake orchestrator said.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const P = require('../../src/run/process.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const FAKE_CORE_END_REJECTS = `${ROOT}/tests/cli/fakes/core-end-rejects.cjs`;
const FAKE_CORE_SHUTDOWN_REJECTS = `${ROOT}/tests/cli/fakes/core-shutdown-rejects.cjs`;

// ---------------------------------------------------------------- scaffolding (as run-paths.test.cjs)

const fwd = (p) => String(p).split(path.sep).join('/');

function sandbox() { return fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-election-'))); }

function cleanup(dir) {
  for (let i = 0; i < 5; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { process.emitWarning(`sandbox left behind at ${dir}: ${e.code || e.message}`); }
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

// Copy `memory.db` and its sidecars, then read the copy (invariant 6): never a read-only open of the
// live file.
function readCurrentRunRow(dataDir, runId) {
  const src = `${dataDir}/memory.db`;
  if (!fs.existsSync(src)) return null;
  const tmp = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-election-copy-')));
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(src + suffix)) fs.copyFileSync(src + suffix, `${tmp}/memory.db${suffix}`);
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(`${tmp}/memory.db`);
    try {
      const rows = db.prepare('SELECT * FROM run WHERE id = ? ORDER BY seq DESC LIMIT 1').all(runId);
      return rows[0] || null;
    } finally { db.close(); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function makeSpec(dir, overrides = {}) {
  const wt = `${dir}/wt`;
  fs.mkdirSync(wt, { recursive: true });
  const promptFile = `${dir}/prompt.txt`;
  fs.writeFileSync(promptFile, 'line one of the prompt\nline two of the prompt\n');
  const runId = overrides.run_id || `run-election-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const orchestratorDir = overrides.orchestrator_dir || `${dir}/orch`;
  const spec = {
    worktree: wt, prompt_file: promptFile, run_id: runId, orchestrator_dir: orchestratorDir,
    poll_ms: 500, startup_timeout_ms: 20000, on_embedder_failure: 'continue', ...overrides,
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

// The dispatcher writes a non-zero-code receipt to stderr, a zero-code one to stdout
// (src/cli/belay.cjs).
function receiptOf(run, exitCode) {
  return JSON.parse(exitCode === 0 ? run.stdout : run.stderr);
}

async function killIfAlive(proc) {
  if (proc && proc.exitCode === null) { try { await P.killTree(proc); } catch { /* best effort */ } }
}

// ================================================================ the tests

test('run: two runs started in the same tick on one data dir give one winner and one refusal, and the loser exits 1 with a receipt', async () => {
  for (let round = 0; round < 3; round += 1) {
    const dir = sandbox();
    const dataDir = `${dir}/.belay`;
    const { specPath, runId } = makeSpec(dir, { poll_ms: 300 });
    const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_DELAY_MS: '1500' };

    // Both CLIs spawned back to back with no `await` between them, so both processes are kicked off
    // in the same JS tick — the exact input 5a-3 review_2's blocking finding proved 5 of 5 times.
    const runA = runCli(specPath, dataDir, env);
    const runB = runCli(specPath, dataDir, env);

    try {
      const [exitedA, exitedB] = await Promise.all([
        waitForExit(runA.proc, 20000),
        waitForExit(runB.proc, 20000),
      ]);
      assert.ok(exitedA, `round ${round}: run A did not exit within 20,000 ms`);
      assert.ok(exitedB, `round ${round}: run B did not exit within 20,000 ms`);

      const pairs = [[runA, exitedA], [runB, exitedB]];
      const winners = pairs.filter(([, e]) => e.code === 0);
      const losers = pairs.filter(([, e]) => e.code === 1);
      assert.strictEqual(winners.length, 1, `round ${round}: expected exactly one winner, codes were ${exitedA.code}, ${exitedB.code} (stdout A: ${runA.stdout}, stderr A: ${runA.stderr}, stdout B: ${runB.stdout}, stderr B: ${runB.stderr})`);
      assert.strictEqual(losers.length, 1, `round ${round}: expected exactly one loser`);

      const [winnerRun] = winners[0];
      const [loserRun] = losers[0];
      const winnerPid = winnerRun.proc.pid;

      const loserReceipt = receiptOf(loserRun, 1);
      assert.strictEqual(loserReceipt.store.attach, null, `round ${round}: a refused run must not have opened an epoch`);
      assert.strictEqual(loserReceipt.store.ended, null, `round ${round}: a refused run must not have closed anything`);
      assert.strictEqual(loserReceipt.store.owner_pid, winnerPid, `round ${round}: the refusal must name the winner's pid`);
      assert.match(loserReceipt.store.established_by, /ping/, `round ${round}: established_by must name a bounded ping`);
      assert.match(loserReceipt.ended_by, /owner|election/, `round ${round}`);

      const winnerReceipt = receiptOf(winnerRun, 0);
      assert.strictEqual(winnerReceipt.orchestrator.turns, 1, `round ${round}: the winner must have actually run`);

      assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), `round ${round}: owner.lock present after both runs exited`);

      const row = readCurrentRunRow(dataDir, runId);
      assert.ok(row && row.ended_at, `round ${round}: the run row has no ended_at`);
      assert.strictEqual(row.adapter_pid, winnerPid, `round ${round}: the ended row's adapter_pid must be the winner's`);
    } finally {
      await killIfAlive(runA.proc);
      await killIfAlive(runB.proc);
      cleanup(dir);
    }
  }
});

test('run: a failing run.end after a clean run is reported, not hidden', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath } = makeSpec(dir);
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, BELAY_FAKE_CORE: FAKE_CORE_END_REJECTS };

  const runCliProc = runCli(specPath, dataDir, env);
  try {
    const exited = await waitForExit(runCliProc.proc, 15000);
    assert.ok(exited, 'the CLI did not exit within 15,000 ms');
    assert.strictEqual(exited.code, 1, `stdout: ${runCliProc.stdout}, stderr: ${runCliProc.stderr}`);
    const receipt = receiptOf(runCliProc, 1);
    assert.match(receipt.ended_by, /stdin closed; then .*run\.end/);
    assert.strictEqual(receipt.store.ended, null, 'run.end rejected, so no ended block can exist');
    assert.ok(receipt.store.shutdown !== null, 'shutdownOwner must still have run');
    assert.ok(!('error' in receipt.store.shutdown), `shutdownOwner itself must not have failed: ${JSON.stringify(receipt.store.shutdown)}`);
    assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'owner.lock is still present after the run.end failure');
  } finally {
    await killIfAlive(runCliProc.proc);
    cleanup(dir);
  }
});

// 5a-3 fix round (should-fix, review_2's finding at src/cli/cmd-run.cjs:255): a shutdownOwner()
// rejection after a clean run must not leave the CLI process alive forever with owner.lock still
// held — belay.cjs only ever sets process.exitCode, so a live pipe Server or an unstopped timer would
// keep the exit code above unreachable to any caller.
test('run: a failing shutdownOwner after a clean run is reported, and the process still exits', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath } = makeSpec(dir);
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, BELAY_FAKE_CORE: FAKE_CORE_SHUTDOWN_REJECTS };

  const runCliProc = runCli(specPath, dataDir, env);
  try {
    const exited = await waitForExit(runCliProc.proc, 15000);
    assert.ok(exited, `the CLI did not exit within 15,000 ms (still alive: ${runCliProc.proc.exitCode === null}) — stdout: ${runCliProc.stdout}, stderr: ${runCliProc.stderr}`);
    assert.strictEqual(exited.code, 1, `stdout: ${runCliProc.stdout}, stderr: ${runCliProc.stderr}`);
    const receipt = receiptOf(runCliProc, 1);
    assert.match(receipt.ended_by, /stdin closed; then .*shutdownOwner/);
    assert.ok(receipt.store.ended && receipt.store.ended.ended_at, 'run.end/run.get must still have landed');
    assert.ok(receipt.store.shutdown && typeof receipt.store.shutdown.error === 'string', 'store.shutdown must name the failure');
    assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'owner.lock is still present after the shutdownOwner failure');
  } finally {
    await killIfAlive(runCliProc.proc);
    cleanup(dir);
  }
});
