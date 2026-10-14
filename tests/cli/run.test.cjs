'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// run.test.cjs — the acceptance criterion for build step 5a:
// `belay run <spec>` spawns the headless orchestrator (ADR 0009 §1) and holds its stdin. Every
// assertion here is about a derived fact — a process-table row, a store row read from a copy, an
// exit code, a lock directory that is or is not there — never about what the fake orchestrator said.
//
// Driven as a subprocess, the way tests/cli/slice-3a.test.cjs drives every other command, with
// BELAY_CLAUDE_EXE standing in for the orchestrator so no real Claude Code session is spent here.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const { openCore } = require('../../src/core/index.cjs');
const { releaseCore } = require('./stop-helpers.cjs');
const P = require('../../src/run/process.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const FAKE_NOREADY = `${ROOT}/tests/run/fakes/fake-claude-noready.cjs`;

// ---------------------------------------------------------------- scaffolding

const fwd = (p) => String(p).split(path.sep).join('/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sandbox() { return fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-test-'))); }

function cleanup(dir) {
  for (let i = 0; i < 5; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { process.emitWarning(`sandbox left behind at ${dir}: ${e.code || e.message}`); }
}

function listFiles(dir) {
  const out = [];
  (function walk(d, rel) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.push(`${r}/`); walk(`${d}/${e.name}`, r); } else out.push(r);
    }
  })(dir, '');
  return out;
}

// Poll `fn` until it returns a truthy value or the deadline passes; returns that value or null.
async function waitUntil(fn, timeoutMs, stepMs = 100) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
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

// One PowerShell CIM call, as the brief names it: the process table's own record of who spawned whom.
function parentPidOf(pid) {
  const ps = `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty ParentProcessId`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  const n = Number(String(r.stdout || '').trim());
  return Number.isFinite(n) ? n : null;
}

// Copy `memory.db` and its sidecars, then read the copy (invariant 6): never a read-only open of the
// live file.
function readCurrentRunRow(dataDir, runId) {
  const src = `${dataDir}/memory.db`;
  if (!fs.existsSync(src)) return null;
  const tmp = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-test-copy-')));
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
  const runId = overrides.run_id || `run-test-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const orchestratorDir = overrides.orchestrator_dir || `${dir}/orch`;
  const spec = {
    worktree: wt, prompt_file: promptFile, run_id: runId, orchestrator_dir: orchestratorDir,
    poll_ms: 500, startup_timeout_ms: 20000, on_embedder_failure: 'continue', ...overrides,
  };
  const specPath = `${dir}/spec.json`;
  fs.writeFileSync(specPath, JSON.stringify(spec));
  return { specPath, wt, promptFile, runId, orchestratorDir };
}

// ================================================================ the tests

test('run: the orchestrator is a child of the CLI, the run row is written, stdin holds across a turn end while a worker is mid-turn, and the receipt names pid, session id and turns', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, wt, runId, orchestratorDir } = makeSpec(dir);
  const env = {
    ...process.env,
    BELAY_CLAUDE_EXE: FAKE_CLAUDE,
    // The orchestrator's first answer is held until the test has planted the mid-turn worker row, so the setup
    // cannot lose a race against a fixed answer delay on a slow host.
    FAKE_ANSWER_GATE_FILE: `${dir}/orchestrator-gate`,
    FAKE_SESSION_ID: 'fake-session-run-test-0001',
  };

  const cliProc = spawn(process.execPath, [CLI, 'run', specPath, '--data', dataDir, '--json'], {
    cwd: ROOT, env, windowsHide: true,
  });
  let cliStdout = ''; cliProc.stdout.on('data', (d) => { cliStdout += d; });
  let cliStderr = ''; cliProc.stderr.on('data', (d) => { cliStderr += d; });

  let testCore = null;
  let fakeWorker = null;
  try {
    testCore = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });

    const row = await waitUntil(async () => {
      const got = await testCore.run.get();
      return got.run || null;
    }, 10000, 100);
    assert.ok(row, 'the run row never appeared within 10,000 ms of the CLI spawning');
    assert.strictEqual(row.adapter_pid, cliProc.pid, "adapter_pid must be the CLI process's own pid");
    assert.ok(Number.isInteger(row.orchestrator_pid) && row.orchestrator_pid > 0, 'orchestrator_pid must be a positive integer');

    fakeWorker = spawn(process.execPath, [FAKE_CLAUDE], {
      cwd: wt, env: { ...process.env, FAKE_HANG: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const written = await testCore.worker.write({
      id: 'w-hold', run_id: runId, substrate: 'claude-code', pid: fakeWorker.pid, pid_image: 'node.exe',
      state: 'running', turns: 0, started_at: Date.now(),
    });
    assert.strictEqual(written.state, 'running', 'the worker row must have been written as running');
    fs.writeFileSync(env.FAKE_ANSWER_GATE_FILE, ''); // the worker is mid-turn in the store: the orchestrator may now end its turn

    const streamPath = `${orchestratorDir}/stream.jsonl`;
    const gotResult = await waitForFileLine(streamPath, '"type":"result"', 15000);
    assert.ok(gotResult, `stream.jsonl at ${streamPath} never held a result line within 15,000 ms`);

    await sleep(2 * 500);

    assert.strictEqual(cliProc.exitCode, null, 'the CLI process exited before the fake worker was killed');
    const row2 = await testCore.run.get();
    const orchPid = row2.run.orchestrator_pid;
    assert.ok(P.pidAlive(orchPid), `orchestrator pid ${orchPid} is not alive`);
    const ppid = parentPidOf(orchPid);
    assert.strictEqual(ppid, cliProc.pid, `orchestrator's parent pid ${ppid} is not the CLI's pid ${cliProc.pid}`);

    require('../crash.cjs').crash(fakeWorker);

    const exited = await waitForExit(cliProc, 4 * 500 + 5000);
    assert.ok(exited, 'the CLI did not exit in time after the fake worker was killed');
    assert.strictEqual(exited.code, 0, `the CLI exited ${exited.code}, stderr: ${cliStderr.slice(-2000)}`);

    const receipt = JSON.parse(cliStdout);
    assert.strictEqual(receipt.orchestrator.pid, orchPid);
    assert.strictEqual(receipt.orchestrator.session_id, 'fake-session-run-test-0001');
    assert.strictEqual(receipt.orchestrator.turns, 1);
    assert.strictEqual(receipt.orchestrator.exit_code, 0);
    assert.match(receipt.ended_by, /stdin closed/);
    assert.ok(receipt.holds.length >= 1, 'the receipt records no hold');
    assert.deepStrictEqual(receipt.holds[0].busy, ['w-hold']);
    assert.strictEqual(receipt.store.ended.exit_reason, receipt.ended_by);
    assert.ok(Number.isInteger(receipt.store.ended.ended_at));

    const storeRow = readCurrentRunRow(dataDir, runId);
    assert.ok(storeRow && storeRow.ended_at, "the store's current run row has no ended_at");
    assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'owner.lock is still present after shutdownOwner');
    const runJson = JSON.parse(fs.readFileSync(`${orchestratorDir}/run.json`, 'utf8'));
    assert.deepStrictEqual(runJson, receipt);
    assert.ok(!P.pidAlive(orchPid), 'the orchestrator pid is still alive after the CLI exited');
  } finally {
    await releaseCore(testCore);
    if (fakeWorker && P.pidAlive(fakeWorker.pid)) require('../crash.cjs').crash(fakeWorker);
    if (cliProc.exitCode === null) { try { await P.killTree(cliProc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});

test('run: a usage error costs no process and no file', () => {
  const dirNoSpec = sandbox();
  try {
    const before = listFiles(dirNoSpec);
    const r = spawnSync(process.execPath, [CLI, 'run'], { cwd: dirNoSpec, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.strictEqual(r.status, 2, `expected exit 2 with no spec argument, got ${r.status}: ${r.stderr}`);
    assert.match((r.stdout || '') + (r.stderr || ''), /usage/);
    // 5a-2 (review 1's note on this test): a dispatcher that does not know `run` at all answers the
    // same way (exit 2, "usage" in the output), so this proves nothing about cmd-run.cjs's own spec
    // parser unless it also checks the error came from `run` specifically, not "unknown command".
    assert.match(r.stderr || '', /^belay run:/, `stderr did not open with "belay run:": ${r.stderr}`);
    assert.deepStrictEqual(listFiles(dirNoSpec), before, 'a usage error with no spec left files behind');
  } finally { cleanup(dirNoSpec); }

  const dirNoWorktree = sandbox();
  try {
    const promptFile = `${dirNoWorktree}/prompt.txt`;
    fs.writeFileSync(promptFile, 'hi\n');
    const specPath = `${dirNoWorktree}/spec.json`;
    fs.writeFileSync(specPath, JSON.stringify({ prompt_file: promptFile }));
    const before = listFiles(dirNoWorktree);
    const r = spawnSync(process.execPath, [CLI, 'run', specPath], { cwd: dirNoWorktree, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.strictEqual(r.status, 2, `expected exit 2 for a spec lacking worktree, got ${r.status}: ${r.stderr}`);
    assert.match((r.stdout || '') + (r.stderr || ''), /usage/);
    assert.match(r.stderr || '', /^belay run:/, `stderr did not open with "belay run:": ${r.stderr}`);
    assert.deepStrictEqual(listFiles(dirNoWorktree), before, 'a usage error for a spec lacking worktree left files behind');
  } finally { cleanup(dirNoWorktree); }
});

test('run: --effort with an unknown level is exit 2 naming the levels', () => {
  const dir = sandbox();
  try {
    fs.mkdirSync(`${dir}/wt`);
    fs.writeFileSync(`${dir}/prompt.txt`, 'hi\n');
    const specPath = `${dir}/spec.json`;
    fs.writeFileSync(specPath, JSON.stringify({ worktree: `${dir}/wt`, prompt_file: `${dir}/prompt.txt` }));
    const before = listFiles(dir);
    for (const args of [['--effort', 'ultra'], ['--effort=ultra'], ['--effort']]) {
      const r = spawnSync(process.execPath, [CLI, 'run', specPath, ...args], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 20000 });
      assert.strictEqual(r.status, 2, `${args.join(' ')}: expected exit 2, got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr || '', /^belay run: --effort must be one of low, medium, high, xhigh, max/);
      assert.deepStrictEqual(listFiles(dir), before, `${args.join(' ')} left files behind`);
    }
  } finally { cleanup(dir); }
});

test('run: an orchestrator that never becomes ready ends the run with exit 1, a run row that names why, and no owner left', () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId } = makeSpec(dir, { startup_timeout_ms: 3000 });
  const env = { ...process.env, BELAY_CLAUDE_EXE: FAKE_NOREADY };
  try {
    const r = spawnSync(process.execPath, [CLI, 'run', specPath, '--data', dataDir, '--json'], {
      cwd: ROOT, env, encoding: 'utf8', windowsHide: true, timeout: 60000,
    });
    assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}; stdout: ${r.stdout}; stderr: ${r.stderr}`);
    // Exit code 1 puts the receipt on stderr (src/cli/belay.cjs: non-zero code writes to stderr).
    const receipt = JSON.parse(r.stderr);
    assert.match(receipt.ended_by, /ready/);
    assert.strictEqual(receipt.orchestrator.exit_code, 1);
    const storeRow = readCurrentRunRow(dataDir, runId);
    assert.ok(storeRow && storeRow.ended_at, "the store's current run row has no ended_at");
    assert.match(String(storeRow.exit_reason), /ready/);
    assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'owner.lock is still present after a failed start');
  } finally { cleanup(dir); }
});

test('run: a receipt with no orchestrator launch carries surface and instructions as null', () => {
  const block = require(`${ROOT}/src/cli/cmd-run.cjs`).emptyOrchestratorBlock();
  assert.ok('surface' in block, 'the no-launch block has a surface key');
  assert.ok('instructions' in block, 'the no-launch block has an instructions key');
  assert.strictEqual(block.surface, null);
  assert.strictEqual(block.instructions, null);
});
