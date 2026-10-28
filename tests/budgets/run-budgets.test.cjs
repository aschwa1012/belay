'use strict';
// run-budgets.test.cjs — the time bounds the functional `belay run` tests do not assert, in the quiet phase (ADR 0018's shape): the
// run is driven N times, the minimum is the figure, and the raw samples are printed beside the gate. The functional suites keep the
// facts (the kill came after the grace, the run says so); here is how long it took.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { spawnSync } = require('node:child_process');
const P = require('../../src/run/process.cjs');
const { emptyScript } = require('../cli/budget.cjs');
const { makeSpec, runCli, receiptOf, waitUntil, waitForFileLine, waitForExit, fwd, cleanup } = require('../cli/stop-helpers.cjs');
const { sampleHolds } = require('../cli/holds-helpers.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const N = 3;
const CLOSE_GRACE_MS = 1500;
const KILL_OVER_GRACE_MS = 4500; // the orchestrator that ignores a closed stdin is gone within close_grace_ms plus this, its own identity snapshot aside
const TOTAL_MS = 9000;

async function onceIgnoringStdin() {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-budgets-')));
  const dataDir = `${dir}/.belay`;
  const { specPath, orchestratorDir } = makeSpec(dir, { close_grace_ms: CLOSE_GRACE_MS });
  const t0 = Date.now();
  const run = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_IGNORE_STDIN_END: '1' });
  try {
    assert.ok(await waitForFileLine(`${orchestratorDir}/stream.jsonl`, '"type":"result"', 30000), 'the orchestrator never answered');
    const turnEndAt = Date.now();
    const exited = await waitForExit(run.proc, 60000);
    assert.ok(exited, 'the CLI did not exit within 60,000 ms');
    const totalMs = Date.now() - t0;
    const sinceTurnEnd = Date.now() - turnEndAt;
    const receipt = receiptOf(run, 1);
    const snapMs = (receipt.orchestrator.kill && receipt.orchestrator.kill.snapshot_ms) || 0;
    return { sinceTurnEnd, totalMs, snapMs, killed: receipt.orchestrator.killed_after_close };
  } finally {
    if (run.proc.exitCode === null) { try { await P.killTree(run.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
}

// ADR 0018 amendment 1: a gate is floor-relative. Each sample is taken between two reads of the host's own empty-script spawn time, the
// minimum of n is taken for both, and the gate is on the difference. The raw minimum, the floor and every sample are recorded beside it.
const floorScript = emptyScript();
const floorOnce = () => { const t = Date.now(); spawnSync(process.execPath, [floorScript], { windowsHide: true, timeout: 20000 }); return Date.now() - t; };

async function gate(name, boundMs, sampleFn) {
  const samples = []; const floors = [floorOnce()];
  for (let i = 0; i < N; i += 1) { samples.push(await sampleFn(i)); floors.push(floorOnce()); }
  const min = Math.min(...samples); const floor = Math.min(...floors);
  console.log(JSON.stringify({ gate: name, bound_ms: boundMs, min_over_floor_ms: min - floor, raw_min_ms: min, floor_min_ms: floor, raw_samples_ms: samples, floor_samples_ms: floors }));
  assert.ok(min - floor <= boundMs, `${name}: ${min - floor} ms above the host floor (minimum of ${N}), over ${boundMs} ms; raw min ${min}, floor ${floor}, samples ${samples.join(', ')}`);
}

test('budgets: an orchestrator that ignores a closed stdin is killed within its grace plus 4,500 ms, and the run ends within 9,000 ms', { timeout: 300000 }, async () => {
  const runs = [];
  const once = async (i) => { const r = await onceIgnoringStdin(); assert.strictEqual(r.killed, true, `run ${i} did not kill the orchestrator after the close`); runs.push(r); return r; };
  await gate('kill after the turn end (identity snapshot subtracted)', CLOSE_GRACE_MS + KILL_OVER_GRACE_MS, async (i) => { const r = await once(i); return r.sinceTurnEnd - r.snapMs; });
  await gate('whole run (identity snapshot subtracted)', TOTAL_MS, async (i) => { const r = runs[i]; return r.totalMs - r.snapMs; });
});

// ---- the death wake's lag behind the kill (moved from tests/cli/run-wake.test.cjs, which keeps the ordering facts) -------------

const { createRunManager } = require('../../src/run/index.cjs');
const { cleanupRun } = require('../cli/run-teardown.cjs');


const USER_SETTINGS = `${ROOT}/tests/run/fixtures/user-settings.json`;
const WAKE_LAG_MS = 3000; // about one poll (300 ms) plus the detector's landing

async function deathWakeLag() {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-budgets-')));
  const dataDir = `${dir}/.belay`;
  const { specPath, runId } = makeSpec(dir, { poll_ms: 300 });
  const holdsFile = `${dir}/holds.jsonl`;
  const sampler = sampleHolds(holdsFile);
  const run = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_DELAY_MS: '1500', FAKE_ANSWER_GATE_FILE: `${dir}/orch.gate`, BELAY_TEST_HOLDS_FILE: holdsFile });
  let core = null; let m = null; const spawnedPids = [];
  try {
    core = await require('../helpers/bound-orchestrator.cjs').connectBoundOrchestrator(dataDir, runId, { waitMs: 60000 });
    m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE_CLAUDE, userSettings: USER_SETTINGS } });
    const wt = `${dir}/w1-wt`; fs.mkdirSync(wt, { recursive: true });
    process.env.FAKE_HANG = '1';
    m.spawn({ substrate: 'claude-code', worktree: wt, prompt: 'hello', worker_id: 'w1' }).catch(() => {});
    const row = await waitUntil(async () => { const w = await core.worker.get({ worker_id: 'w1' }); return w && w.pid && w.pid_created ? w : null; }, 60000, 50);
    delete process.env.FAKE_HANG;
    assert.ok(row, 'the planted worker never got a live pid in the store');
    spawnedPids.push({ pid: row.pid, created: row.pid_created });
    fs.writeFileSync(`${dir}/orch.gate`, '');
    assert.ok(await waitUntil(() => sampler.seen.find((s) => Array.isArray(s.hold.busy) && s.hold.busy[0] === 'w1') || null, 60000, 20), 'the run never recorded the worker as busy');
    const ref = sampler.seen.find((s) => Array.isArray(s.hold.busy) && s.hold.busy[0] === 'w1');
    const killAt = await require('../crash.cjs').crashAsync(row.pid, row.pid_created);
    assert.ok(killAt, 'the planted worker was not killed');
    assert.ok(await waitForExit(run.proc, 90000), 'the CLI did not exit');
    const w = receiptOf(run, 0).wakes[0];
    assert.ok(w && w.event === 'death', 'no death wake');
    return w.at_ms - (ref.hold.at_ms + (killAt - ref.seenAt));
  } finally {
    delete process.env.FAKE_HANG;
    sampler.stop();
    await cleanupRun({ m, core, cliProc: run, spawnedPids, dir, runId, cleanup });
  }
}

test('budgets: the death wake lands within 3,000 ms of the kill', { timeout: 300000 }, async () => {
  await gate('death wake lag behind the kill', WAKE_LAG_MS, () => deathWakeLag());
});

// ---- the stop's own exit speed (moved from tests/cli/stop.test.cjs, which keeps the facts) --------------------------------------

const { runStopSync, currentRunRow } = require('../cli/stop-helpers.cjs');

async function stopMsToExit() {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-budgets-')));
  const dataDir = `${dir}/.belay`;
  const { specPath, runId } = makeSpec(dir, { startup_timeout_ms: 120000, close_grace_ms: 5000 });
  const run = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_HANG: '1' });
  try {
    assert.ok(await waitUntil(() => currentRunRow(dataDir, runId), 60000, 100), 'the run row never appeared');
    const stop = runStopSync(dataDir, runId);
    assert.strictEqual(stop.status, 0, `stop: ${stop.stdout} / ${stop.stderr}`);
    assert.strictEqual(stop.receipt.orchestrator.graceful, true);
    assert.ok(await waitForExit(run.proc, 90000), 'the run did not exit after the stop');
    return stop.receipt.orchestrator.ms_to_exit;
  } finally {
    if (run.proc.exitCode === null) { try { await P.killTree(run.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
}

test('budgets: a stop closes a hung orchestrator within 4,999 ms of its 5,000 ms grace', { timeout: 300000 }, async () => {
  await gate('stop ms_to_exit', 4999, () => stopMsToExit());
});
