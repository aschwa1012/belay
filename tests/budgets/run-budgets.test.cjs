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
const { makeSpec, runCli, receiptOf, waitForFileLine, waitForExit, fwd, cleanup } = require('../cli/stop-helpers.cjs');

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

test('budgets: an orchestrator that ignores a closed stdin is killed within its grace plus 4,500 ms, minimum of 3', async () => {
  const samples = [];
  const floors = []; // the host's own spawn floor, taken between the runs and printed beside the figure (ADR 0018), never asserted
  const floorScript = emptyScript();
  for (let i = 0; i < N; i += 1) {
    const s = await onceIgnoringStdin();
    assert.strictEqual(s.killed, true, `run ${i} did not kill the orchestrator after the close`);
    samples.push(s);
    const f0 = Date.now();
    spawnSync(process.execPath, [floorScript], { windowsHide: true, timeout: 20000 });
    floors.push(Date.now() - f0);
  }
  const afterTurn = Math.min(...samples.map((s) => s.sinceTurnEnd - s.snapMs));
  const total = Math.min(...samples.map((s) => s.totalMs - s.snapMs));
  console.log(JSON.stringify({ close_grace_ms: CLOSE_GRACE_MS, since_turn_end_minus_snapshot_min: afterTurn, total_minus_snapshot_min: total, host_floor_ms: floors, samples }));
  assert.ok(afterTurn <= CLOSE_GRACE_MS + KILL_OVER_GRACE_MS, `the kill came ${afterTurn} ms after the turn end (minimum of ${N}), over ${CLOSE_GRACE_MS + KILL_OVER_GRACE_MS} ms; samples ${JSON.stringify(samples)}`);
  assert.ok(total < TOTAL_MS, `the run took ${total} ms (minimum of ${N}), over ${TOTAL_MS} ms; samples ${JSON.stringify(samples)}`);
});

// ---- the death wake's lag behind the kill (moved from tests/cli/run-wake.test.cjs, which keeps the ordering facts) -------------

const { createRunManager } = require('../../src/run/index.cjs');
const { cleanupRun } = require('../cli/run-teardown.cjs');
const { sampleHolds, waitUntil } = require('../cli/holds-helpers.cjs');

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

test('budgets: the death wake lands within 3,000 ms of the kill, minimum of 3', { timeout: 300000 }, async () => {
  const lags = [];
  for (let i = 0; i < N; i += 1) lags.push(await deathWakeLag());
  console.log(JSON.stringify({ death_wake_lag_ms: lags, min: Math.min(...lags) }));
  assert.ok(Math.min(...lags) <= WAKE_LAG_MS, `the death wake came ${Math.min(...lags)} ms after the kill (minimum of ${N}), over ${WAKE_LAG_MS} ms; samples ${lags.join(', ')}`);
});
