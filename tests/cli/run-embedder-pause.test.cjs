'use strict';
// run-embedder-pause.test.cjs — ADR 0034 decision 2 with a live worker: the pause an embedder failure triggers parks
// the worker under the SAME identity as the run row, so `belay resume` relaunches it; a resume re-attempts the load
// and, while it still fails, leaves the run paused; a second failure after a resume pauses the run again.
// Scaffolding as tests/cli/run-pause.test.cjs: a real `belay run` subprocess (fake core, fake-claude), and this
// process a real RunManager attached as the run's worker adapter.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const {
  ROOT, CLI, sleep, sandbox, cleanup, waitUntil, waitForExit, makeSpec, runCli, connectOrchestratorCore, currentRunRow, releaseCore,
} = require('./stop-helpers.cjs');
const { createRunManager, createWorkerControl } = require('../../src/run/index.cjs');
const P = require('../../src/run/process.cjs');

delete process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP; // stop-helpers sets it for the other suites; this one tests the warm-up
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const FAKE_CORE = `${ROOT}/tests/cli/fakes/core-fake-embedder.cjs`;
const USER_SETTINGS = `${ROOT}/tests/run/fixtures/user-settings.json`;

function cli(args, dataDir) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true });
    let stdout = ''; proc.stdout.on('data', (d) => { stdout += d; });
    let stderr = ''; proc.stderr.on('data', (d) => { stderr += d; });
    proc.once('exit', (status) => {
      let json = null;
      try { json = JSON.parse(status === 0 ? stdout : stderr); } catch { /* left null */ }
      resolve({ status, stdout, stderr, json });
    });
  });
}

async function start(dir, fixedFile, extraEnv = {}, withWorker = true) {
  const dataDir = `${dir}/.belay`;
  const { specPath, runId } = makeSpec(dir, { poll_ms: 300, on_embedder_failure: 'stop' });
  const cliProc = runCli(specPath, dataDir, {
    BELAY_CLAUDE_EXE: FAKE_CLAUDE, BELAY_FAKE_CORE: FAKE_CORE, FAKE_ANSWER_DELAY_MS: '60000', FAKE_EMBEDDER_FIXED: fixedFile, ...extraEnv,
  });
  const core = await connectOrchestratorCore(dataDir, runId);
  const m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE_CLAUDE, userSettings: USER_SETTINGS } });
  const control = createWorkerControl({ dataDir, manager: m, pid: cliProc.proc.pid });
  await control.listen();
  if (!withWorker) return { dataDir, runId, cliProc, core, m, control, pids: [] }; // n = 0 parked workers: the CLI's resume bound is its smallest
  const wt = `${dir}/w1-wt`;
  fs.mkdirSync(wt, { recursive: true });
  const row = await m.spawn({ substrate: 'claude-code', worktree: wt, prompt: 'hello', worker_id: 'w1' });
  return { dataDir, runId, cliProc, core, m, control, pids: [row.pid] };
}

async function teardown(ctx, dir) {
  if (ctx.cliProc && ctx.cliProc.proc.exitCode === null) { try { await cli(['stop', ctx.runId], ctx.dataDir); } catch { /* best effort */ } await waitForExit(ctx.cliProc.proc, 15000); }
  try { await ctx.control.close(); } catch { /* best effort */ }
  try { await ctx.m.shutdown(); } catch { /* best effort */ }
  for (const p of ctx.pids) require('../crash.cjs').crash(p.pid, p.created);
  await releaseCore(ctx.core);
  if (ctx.cliProc.proc.exitCode === null) { try { await P.killTree(ctx.cliProc.proc); } catch { /* best effort */ } }
  cleanup(dir);
}

const pausedRow = (ctx) => waitUntil(() => { const r = currentRunRow(ctx.dataDir, ctx.runId); return r && r.paused_at ? r : null; }, 30000, 200);
const unpausedRow = (ctx) => waitUntil(() => { const r = currentRunRow(ctx.dataDir, ctx.runId); return r && !r.paused_at ? r : null; }, 30000, 200);

test('an embedder-failure pause parks a live worker under the run row\'s own identity, and a resume relaunches it', { timeout: 300000 }, async () => {
  const dir = sandbox();
  let ctx;
  try {
    const fixed = `${dir}/fixed.flag`;
    ctx = await start(dir, fixed);
    await sleep(500);
    await assert.rejects(ctx.core.memory.store({ text: 'a note' }), (e) => e.detail && e.detail.embedder === true);
    const row = await pausedRow(ctx);
    assert.ok(row, 'the run never paused');
    assert.match(row.paused_by, /^operator:\d+ \[embedder-failure \(orchestrator, memory\.store, E_TIMEOUT, timeout\)\]$/);
    const w1 = await waitUntil(async () => { const w = await ctx.core.worker.get({ worker_id: 'w1' }); return w.state === 'paused' ? w : null; }, 30000, 200);
    assert.ok(w1, 'the worker was never parked');
    assert.strictEqual(w1.paused_by, row.paused_by, 'the park and the run share one identity');
    const withParks = await waitUntil(() => { const r = currentRunRow(ctx.dataDir, ctx.runId); return r && r.pause_parks ? r : null; }, 30000, 200);
    assert.ok(withParks, 'pause_parks was never recorded');
    const pauseParks = typeof withParks.pause_parks === 'string' ? JSON.parse(withParks.pause_parks) : withParks.pause_parks;
    assert.deepStrictEqual(pauseParks.parked.map((p) => p.worker_id), ['w1'], 'the park is this pause\'s own');

    // S1: the embedder is not fixed, so the resume's re-load fails and the run stays paused, w1 parked.
    const refused = await cli(['resume', ctx.runId], ctx.dataDir);
    assert.notStrictEqual(refused.status, 0, refused.stdout);
    assert.match(refused.stderr + refused.stdout, /the embedder still cannot load, so the run stays paused: E_MODEL_ABSENT/);
    assert.ok(currentRunRow(ctx.dataDir, ctx.runId).paused_at, 'a refused resume leaves the run paused');
    assert.strictEqual((await ctx.core.worker.get({ worker_id: 'w1' })).state, 'paused');

    // The operator fixes the embedder; the resume now relaunches w1 and tells the orchestrator who paused.
    fs.writeFileSync(fixed, 'ok');
    const resumed = await cli(['resume', ctx.runId], ctx.dataDir);
    assert.strictEqual(resumed.status, 0, `${resumed.stdout} / ${resumed.stderr}`);
    assert.deepStrictEqual(resumed.json.workers_resumed.map((w) => w.worker_id), ['w1']);
    assert.match(resumed.json.line, /an embedder failure paused this run \(embedder-failure \(orchestrator, memory\.store, E_TIMEOUT, timeout\)\) \d+ ms ago/);
    const after = await ctx.core.worker.get({ worker_id: 'w1' });
    assert.notStrictEqual(after.state, 'paused');
    if (after.pid) ctx.pids.push({ pid: after.pid, created: after.pid_created });
  } finally { if (ctx) await teardown(ctx, dir); else cleanup(dir); }
});

test('a resume whose embedder re-load outlasts the ordinary 35 s CLI bound still reports its true outcome', { timeout: 300000 }, async () => {
  const dir = sandbox();
  let ctx;
  try {
    const fixed = `${dir}/fixed.flag`;
    ctx = await start(dir, fixed, { FAKE_EMBEDDER_WARM_DELAY_MS: '40000' }, false);
    await sleep(500);
    await assert.rejects(ctx.core.memory.store({ text: 'x' }));
    assert.ok(await waitUntil(() => { const r = currentRunRow(ctx.dataDir, ctx.runId); return r && r.pause_parks ? r : null; }, 30000, 200), 'paused');
    fs.writeFileSync(fixed, 'ok');
    const t0 = Date.now();
    const resumed = await cli(['resume', ctx.runId], ctx.dataDir);
    assert.ok(Date.now() - t0 >= 39000, 'the re-load really was slow');
    assert.strictEqual(resumed.status, 0, `the CLI must report what happened: ${resumed.stdout} / ${resumed.stderr}`);
    assert.strictEqual(resumed.json.resumed, true);
    assert.strictEqual(currentRunRow(ctx.dataDir, ctx.runId).paused_at, null, 'and the run is in fact resumed');
  } finally { if (ctx) await teardown(ctx, dir); else cleanup(dir); }
});

test('a second embedder failure after a resume pauses the run again, and a pause the run refused is retried by the next failure', { timeout: 300000 }, async () => {
  const dir = sandbox();
  let ctx;
  try {
    const fixed = `${dir}/fixed.flag`;
    ctx = await start(dir, fixed);
    await sleep(500);
    await assert.rejects(ctx.core.memory.store({ text: 'one' }));
    assert.ok(await pausedRow(ctx), 'first pause');
    assert.ok(await waitUntil(() => { const r = currentRunRow(ctx.dataDir, ctx.runId); return r && r.pause_parks ? r : null; }, 30000, 200), 'the pause finished parking'); // a resume while the pause is in flight is E_BUSY
    fs.writeFileSync(fixed, 'ok');
    assert.strictEqual((await cli(['resume', ctx.runId], ctx.dataDir)).status, 0);
    assert.ok(await unpausedRow(ctx), 'the run resumed');
    // The embedder breaks again (the flag goes away, so embed() fails again): the second failure must pause again.
    fs.rmSync(fixed);
    await assert.rejects(ctx.core.memory.store({ text: 'two' }), (e) => e.detail && e.detail.embedder === true);
    const again = await pausedRow(ctx);
    assert.ok(again, 'the second failure did not pause the run again');
    await cli(['stop', ctx.runId], ctx.dataDir);
    await waitForExit(ctx.cliProc.proc, 20000);
    const receipt = JSON.parse(fs.readFileSync(`${dir}/orch/run.json`, 'utf8'));
    // The worker's own turn-text store fails too (the run stores every turn), so there may be more than two.
    assert.ok(receipt.embedder_failures.length >= 2, JSON.stringify(receipt.embedder_failures));
    assert.ok(receipt.embedder_failures.every((f) => f.pause && f.pause.ok === true), JSON.stringify(receipt.embedder_failures));
  } finally { if (ctx) await teardown(ctx, dir); else cleanup(dir); }
});
