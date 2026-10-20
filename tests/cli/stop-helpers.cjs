'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// stop-helpers.cjs — build step 5c-2, owned: split out of
// tests/cli/stop.test.cjs so that file stays under 500 lines once its two new tests landed. Every
// export here is exactly what stop.test.cjs had inline, unchanged, in the shape of
// tests/cli/run-wake.test.cjs (sandbox, makeSpec, runCli, receiptOf, waitForExit,
// connectOrchestratorCore, the store copy readers).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const { openCore } = require('../../src/core/index.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;

const fwd = (p) => String(p).split(path.sep).join('/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sandbox() { return fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-stop-'))); }

function cleanup(dir) {
  for (let i = 0; i < 5; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { process.emitWarning(`sandbox left behind at ${dir}: ${e.code || e.message}`); }
}

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

function makeSpec(dir, overrides = {}) {
  const wt = `${dir}/wt`;
  fs.mkdirSync(wt, { recursive: true });
  const promptFile = `${dir}/prompt.txt`;
  fs.writeFileSync(promptFile, 'line one of the prompt\nline two of the prompt\n');
  const runId = overrides.run_id || `run-stop-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const orchestratorDir = overrides.orchestrator_dir || `${dir}/orch`;
  const spec = {
    worktree: wt, prompt_file: promptFile, run_id: runId, orchestrator_dir: orchestratorDir,
    startup_timeout_ms: 20000, poll_ms: 500, on_embedder_failure: 'continue', ...overrides,
  };
  const specPath = `${dir}/spec.json`;
  fs.writeFileSync(specPath, JSON.stringify(spec));
  return { specPath, wt, promptFile, runId, orchestratorDir };
}

function runCli(specPath, dataDir, env, cwd = ROOT) {
  const proc = spawn(process.execPath, [CLI, 'run', specPath, '--data', dataDir, '--json'], {
    cwd, env: { ...process.env, ...env }, windowsHide: true,
  });
  let stdout = ''; proc.stdout.on('data', (d) => { stdout += d; });
  let stderr = ''; proc.stderr.on('data', (d) => { stderr += d; });
  return { proc, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

// The dispatcher writes a non-zero-code receipt to stderr, a zero-code one to stdout.
function receiptOf(run, exitCode) {
  return JSON.parse(exitCode === 0 ? run.stdout : run.stderr);
}

async function connectOrchestratorCore(dataDir, runId) {
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
  // A hang guard: a node CLI's start-up took several seconds on a saturated host (w2-flakes), so 10 s was a speed claim.
  const row = await waitUntil(async () => (await core.run.get()).run || null, 60000, 100);
  assert.ok(row, "the CLI's run row never appeared within 60,000 ms");
  return core;
}

// A test core that won the election owns the store: close() only drops the client, so shut the owner down
// first. Guarded on isOwner() so it never ends the CLI run's own owner (belay stop / run.stop end that one).
async function releaseCore(core) {
  if (!core) return;
  try { if (core.isOwner()) await core.shutdownOwner(); } catch { /* best effort */ }
  try { await core.close(); } catch { /* best effort */ }
}

// ---- store copy readers (invariant 6: copy memory.db and its sidecars, then read the copy) --------

function readStoreCopy(dataDir, fn) {
  const src = `${dataDir}/memory.db`;
  if (!fs.existsSync(src)) return null;
  const tmp = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-stop-copy-')));
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(src + suffix)) fs.copyFileSync(src + suffix, `${tmp}/memory.db${suffix}`);
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(`${tmp}/memory.db`);
    try { return fn(db); } finally { db.close(); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function currentRunRow(dataDir, runId) {
  return readStoreCopy(dataDir, (db) => {
    const rows = db.prepare('SELECT * FROM run WHERE id = ? ORDER BY seq DESC LIMIT 1').all(runId);
    return rows[0] || null;
  });
}

function listRecursive(dir) {
  const out = [];
  (function walk(d, rel) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.push(`${r}/`); walk(`${d}/${e.name}`, r); }
      else out.push(r);
    }
  })(dir, '');
  return out;
}

// ---- driving `belay stop` as a subprocess -----------------------------------------------------------

function runStopSync(dataDir, runId) {
  const r = spawnSync(process.execPath, [CLI, 'stop', runId, '--data', dataDir, '--json'], {
    cwd: ROOT, windowsHide: true, encoding: 'utf8',
  });
  let receipt = null;
  try { receipt = JSON.parse(r.status === 0 ? r.stdout : r.stderr); } catch { /* left null */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, receipt, pid: r.pid };
}

function spawnStopAsync(dataDir, runId) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, 'stop', runId, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true });
    let stdout = ''; proc.stdout.on('data', (d) => { stdout += d; });
    let stderr = ''; proc.stderr.on('data', (d) => { stderr += d; });
    proc.once('exit', (code) => {
      let receipt = null;
      try { receipt = JSON.parse(code === 0 ? stdout : stderr); } catch { /* left null */ }
      resolve({ status: code, stdout, stderr, receipt, pid: proc.pid });
    });
  });
}

module.exports = {
  ROOT, CLI, fwd, sleep, sandbox, cleanup, waitUntil, waitForFileLine, waitForExit, makeSpec, runCli,
  receiptOf, connectOrchestratorCore, readStoreCopy, currentRunRow, listRecursive, runStopSync,
  spawnStopAsync, releaseCore,
};
