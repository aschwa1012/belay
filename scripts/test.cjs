'use strict';
// scripts/test.cjs — build step 6h, design item 1; bounded in
// build step H1.
// `npm test` runs this file. It spawns phase 1 (the four globs package.json listed before 6h,
// unchanged) and, only once phase 1 has exited, phase 2 (the budgets glob) — never beside it, so a
// budget gate's floor and command samples always share a load window with nothing else of belay's
// running. Both phases inherit stdio, so their own summaries print exactly as they did when `npm test`
// was one `node --test` chain; this script adds only the two phase lines after both have run.
// H1: each phase has a wall-clock bound (`--test-timeout` is per test and never fires for a hung
// setup). On expiry the phase's child, held by a live handle, is stopped by exact pid with its tree.
// `npm run test:budgets` is unchanged and still runs the budgets glob alone.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { killTree } = require('../src/core/process.cjs');

const PHASE1_GLOBS = [
  'tests/core/**/*.test.cjs', 'tests/run/**/*.test.cjs', 'tests/mcp/**/*.test.cjs', 'tests/cli/**/*.test.cjs', 'tests/mod/**/*.test.cjs',
];
const PHASE2_GLOB = 'tests/budgets/**/*.test.cjs';
const PHASE1_TIMEOUT_MS = 1200000;
const PHASE2_TIMEOUT_MS = 300000;

function bound(envName, dflt) {
  const n = Number(process.env[envName]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

const CLOSE_WAIT_MS = 15000;
// Loaded into every test-file process: removes the directories its test made with mkdtemp on exit.
const TMP_HELPER = path.join(__dirname, '..', 'tests', 'helpers', 'tmp.cjs').split(path.sep).join('/');
// Top-level entries a run leaves on purpose: a run's receipt dir parent, and the read-copy parent (which
// must be empty of copies), and `claude`, the real Claude Code binary's own scratch dir, which the one real-worker
// test (tests/run/integration.test.cjs) makes it write and which is not belay's. `belay-snapshot` is the process
// snapshot's own TEMP (src/core/proc-identity.cjs): only PowerShell probe files belong in it, and the next snapshot
// sweeps those once stale, so they are counted on their own line; anything else in it is a leak.
const KEPT = new Set(['belay-run', 'belay-ro', 'claude', 'belay-snapshot']);
const PROBE_FILE = /^__PSScriptPolicyTest_/;
const snapshotResidue = (scratch) => { try { return fs.readdirSync(path.join(scratch, 'belay-snapshot')).filter((c) => PROBE_FILE.test(c)).length; } catch { return 0; } };

// The tmp guard. The suite runs with TEMP/TMP/TMPDIR pointed at a scratch directory of its own, so every
// entry found in it afterwards was left by this suite and nothing else (a snapshot diff of the shared temp
// dir would blame, or miss, other processes running beside it). Returns the leaked names.
function leaked(scratch) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(scratch); } catch { return out; }
  for (const n of names) {
    if (!KEPT.has(n)) {
      let kids = [];
      try { kids = fs.readdirSync(path.join(scratch, n)).slice(0, 3); } catch { /* a file */ }
      out.push(kids.length ? n + '/{' + kids.join(',') + '}' : n);
      continue;
    }
    if (n === 'belay-ro') { try { for (const c of fs.readdirSync(path.join(scratch, n))) out.push(n + '/' + c); } catch { /* gone */ } }
    if (n === 'belay-snapshot') { try { for (const c of fs.readdirSync(path.join(scratch, n))) if (!PROBE_FILE.test(c)) out.push(n + '/' + c); } catch { /* gone */ } }
  }
  return out;
}

// Resolves { status, timed_out, ms, killed[, stop_failed] }. Never rejects. `killTreeImpl` is a test seam.
function runPhase(globs, { timeoutMs, label = 'phase', killTreeImpl = killTree, env } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    let timer = null;
    let timedOut = false;
    const child = spawn(process.execPath, ['--test', '--test-timeout=60000', '--require', TMP_HELPER, ...globs], { stdio: 'inherit', windowsHide: true, ...(env ? { env } : {}) });
    const closed = new Promise((r) => child.once('close', () => r(true)));
    const finish = (r) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(r); };
    child.once('error', () => finish({ status: 1, timed_out: false, ms: Date.now() - t0, killed: null }));
    child.once('exit', (code, signal) => {
      if (timedOut) return; // the timer path reports this exit
      finish({ status: code === null ? (signal ? 1 : 0) : code, timed_out: false, ms: Date.now() - t0, killed: null });
    });
    if (timeoutMs) {
      timer = setTimeout(async () => {
        // Act only while this script's own handle is live: the pid cannot have been reused, and if the
        // dispatcher already exited nothing is killed (orphans are not guessed at).
        if (settled || child.exitCode !== null || child.signalCode !== null) return;
        timedOut = true;
        let killed;
        // ADR 0039: the live handle (checked just above) is the identity, never its bare pid.
        try { killed = await killTreeImpl(child); } catch (e) { killed = { ok: false, error: String(e && e.message) }; }
        let waitTimer = null;
        const didClose = await Promise.race([closed, new Promise((r) => { waitTimer = setTimeout(() => r(false), CLOSE_WAIT_MS); })]);
        clearTimeout(waitTimer);
        const stopFailed = !killed || killed.ok === false || !!killed.error || !didClose;
        const ms = Date.now() - t0;
        if (stopFailed) console.log(`${label}: TIMEOUT after ${ms} ms, tree of pid ${child.pid} NOT confirmed stopped (killTree ${JSON.stringify(killed)}, closed ${didClose})`);
        else console.log(`${label}: TIMEOUT after ${ms} ms, tree of pid ${child.pid} stopped`);
        finish({ status: 124, timed_out: true, ms, killed, ...(stopFailed ? { stop_failed: true } : {}) });
      }, timeoutMs);
    }
  });
}

// Both phases in order. Phase 2 starts only after phase 1 has exited, and never when phase 1's tree could
// not be stopped. Returns { p1, p2 (null when skipped), code }.
async function runPhases({ globs1 = PHASE1_GLOBS, glob2 = PHASE2_GLOB, timeout1 = bound('BELAY_TEST_PHASE1_TIMEOUT_MS', PHASE1_TIMEOUT_MS), timeout2 = bound('BELAY_TEST_PHASE2_TIMEOUT_MS', PHASE2_TIMEOUT_MS), killTreeImpl, guard = true } = {}) {
  // Review 3, finding F: phase 1 runs with an EMPTY model cache unless the caller has named one, because
  // the run path stores every turn's text and would otherwise load the 243 MB model in every owner. The
  // files that need the model opt back in (tests/core/helpers.cjs optInModel) by seeing the marker.
  const scratch = guard ? fs.mkdtempSync(path.join(os.tmpdir(), 'belay-suite-tmp-')) : null;
  const tmpEnv = scratch ? { TEMP: scratch, TMP: scratch, TMPDIR: scratch } : {};
  const named = !!process.env.BELAY_MODEL_CACHE;
  const emptyCache = named ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'belay-phase1-no-models-')).split('\\').join('/');
  const env1 = named ? (scratch ? { ...process.env, ...tmpEnv } : undefined) : { ...process.env, ...tmpEnv, BELAY_MODEL_CACHE: emptyCache, BELAY_PHASE_EMPTY_CACHE: '1' };
  let p1;
  try { p1 = await runPhase(globs1, { timeoutMs: timeout1, label: 'phase 1', killTreeImpl, env: env1 }); }
  finally { if (emptyCache) { try { fs.rmSync(emptyCache, { recursive: true, force: true }); } catch { /* best effort */ } } }
  const leak1 = scratch ? leaked(scratch) : [];
  let p2 = null;
  if (p1.stop_failed) {
    console.log(`phase 1: exit ${p1.status} (stop failed)`);
    console.log('phase 2: not started (phase 1 could not be stopped)');
  } else {
    p2 = await runPhase([glob2], { timeoutMs: timeout2, label: 'phase 2', killTreeImpl, env: scratch ? { ...process.env, ...tmpEnv } : undefined });
    console.log(`phase 1: exit ${p1.status}`);
    console.log(`phase 2: exit ${p2.status}`);
  }
  // The guard and the scratch removal run on every path, the stop-failed one included.
  let leaks = [];
  let scratchLeft = false;
  if (scratch) {
    leaks = [...new Set([...leak1, ...leaked(scratch)])];
    console.log(`tmp guard: ${leaks.length} top-level entries left in the suite's temp dir${leaks.length ? ' (possibly held by a surviving child): ' + leaks.slice(0, 20).join(', ') + (leaks.length > 20 ? ', ...' : '') : ''}`);
    console.log(`tmp guard: ${snapshotResidue(scratch)} PowerShell probe files in belay-snapshot (swept by a later snapshot)`);
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* checked below */ }
    scratchLeft = fs.existsSync(scratch);
    if (scratchLeft) console.log(`tmp guard: could not remove the suite's temp dir ${scratch}`);
  }
  const bad = !p2 || p1.status !== 0 || p2.status !== 0 || leaks.length > 0 || scratchLeft;
  return { p1, p2, leaks, scratchLeft, code: bad ? 1 : 0 };
}

async function main() { process.exit((await runPhases()).code); }

module.exports = { runPhase, runPhases, leaked, snapshotResidue, PHASE1_GLOBS, PHASE2_GLOB };

if (require.main === module) main();
