'use strict';
// run-embedder.test.cjs — ADR 0034: `belay run` warms the embedder before anything is spawned and refuses a run it
// cannot warm; an embedder failure during the run pauses it (on_embedder_failure stop, the default) or is recorded
// and the run goes on (continue); the lever is validated. Drives the built CLI as a subprocess against a sandbox;
// tests/cli/fakes/core-fake-embedder.cjs stands in for the model (BELAY_FAKE_CORE), fake-claude for the orchestrator.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const {
  ROOT, CLI, sandbox, cleanup, waitUntil, waitForExit, makeSpec, runCli, receiptOf, connectOrchestratorCore, currentRunRow, releaseCore,
} = require('./stop-helpers.cjs');
const { parseLevers } = require('../../src/cli/run-levers.cjs');
const { createEmbedderGuard, isEmbedderFailure, fixFor } = require('../../src/run/embedder-guard.cjs');

delete process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP; // stop-helpers sets it for the other suites; this one tests the warm-up
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const FAKE_CORE = `${ROOT}/tests/cli/fakes/core-fake-embedder.cjs`;

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

// A belay run subprocess under the fake embedder, with this process connected as the orchestrator's own client.
async function startRun(dir, specExtra, env) {
  const dataDir = `${dir}/.belay`;
  const { specPath, runId, orchestratorDir } = makeSpec(dir, { poll_ms: 300, on_embedder_failure: 'stop', ...specExtra });
  const run = runCli(specPath, dataDir, {
    BELAY_CLAUDE_EXE: FAKE_CLAUDE, BELAY_FAKE_CORE: FAKE_CORE, FAKE_ANSWER_DELAY_MS: '60000', ...env,
  });
  const core = await connectOrchestratorCore(dataDir, runId);
  return { dataDir, runId, orchestratorDir, run, core };
}

async function finish({ run, core, dataDir, runId, dir }) {
  if (run && run.proc.exitCode === null) { try { await cli(['stop', runId], dataDir); } catch { /* best effort */ } await waitForExit(run.proc, 15000); }
  await releaseCore(core);
  cleanup(dir);
}

test('warm-up: an absent model refuses the run at start, names the cause and the fix, and spawns nothing', () => {
  const dir = sandbox();
  try {
    const emptyCache = `${dir}/no-models`;
    fs.mkdirSync(emptyCache);
    const { specPath, runId } = makeSpec(dir, { on_embedder_failure: 'stop' });
    const r = spawnSync(process.execPath, [CLI, 'run', specPath, '--data', `${dir}/.belay`, '--json'], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 90000,
      env: { ...process.env, BELAY_CLAUDE_EXE: FAKE_CLAUDE, BELAY_MODEL_CACHE: emptyCache },
    });
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    const rc = JSON.parse(r.stderr);
    assert.strictEqual(rc.run_id, runId);
    assert.strictEqual(rc.embedder.ok, false);
    assert.strictEqual(rc.embedder.code, 'E_MODEL_ABSENT');
    assert.match(rc.ended_by, /the embedder could not be warmed, so the run did not start: E_MODEL_ABSENT/);
    assert.match(rc.ended_by, /belay embedder fetch/);
    assert.strictEqual(rc.orchestrator.pid, null, 'no orchestrator was spawned');
    assert.strictEqual(rc.store.attach, null, 'no run row was attached');
    assert.strictEqual(fs.existsSync(`${dir}/orch/run.json`), false, 'the refusal writes no run receipt');
    const text = spawnSync(process.execPath, [CLI, 'run', specPath, '--data', `${dir}/.belay`], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 90000,
      env: { ...process.env, BELAY_CLAUDE_EXE: FAKE_CLAUDE, BELAY_MODEL_CACHE: emptyCache },
    });
    assert.match(text.stderr + text.stdout, /embedder: warm-up FAILED, E_MODEL_ABSENT/);
  } finally { cleanup(dir); }
});

test('warm-up: a fake warm-up failure refuses the run even when the lever is continue (the lever governs the run, not its start)', () => {
  const dir = sandbox();
  try {
    const { specPath } = makeSpec(dir, { on_embedder_failure: 'continue' });
    const r = spawnSync(process.execPath, [CLI, 'run', specPath, '--data', `${dir}/.belay`, '--json'], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 90000,
      env: { ...process.env, BELAY_CLAUDE_EXE: FAKE_CLAUDE, BELAY_FAKE_CORE: FAKE_CORE, FAKE_EMBEDDER_MODE: 'warm-fails' },
    });
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    const rc = JSON.parse(r.stderr);
    assert.strictEqual(rc.embedder.code, 'E_MODEL_ABSENT');
    assert.strictEqual(rc.orchestrator.pid, null);
  } finally { cleanup(dir); }
});

test('stop (the default): an embedder failure mid-run pauses the run, records the event, and status and receipts show it', { timeout: 240000 }, async () => {
  const dir = sandbox();
  let ctx;
  try {
    ctx = await startRun(dir, {}, {});
    await assert.rejects(ctx.core.memory.store({ text: 'a note' }), (e) => e.code === 'E_TIMEOUT' && e.detail && e.detail.embedder === true);
    const paused = await waitUntil(() => { const r = currentRunRow(ctx.dataDir, ctx.runId); return r && r.paused_at ? r : null; }, 30000, 200);
    assert.ok(paused, 'the run row never read paused');
    assert.match(paused.paused_by, /^operator:\d+ \[embedder-failure \(orchestrator, memory\.store, E_TIMEOUT, timeout\)\]$/);

    const st = await cli(['status', ctx.runId], ctx.dataDir);
    assert.strictEqual(st.json.run.paused_by, paused.paused_by);
    const stText = spawnSync(process.execPath, [CLI, 'status', ctx.runId, '--data', ctx.dataDir], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.match(stText.stdout, /run paused at .* by operator:\d+ \[embedder-failure .*an embedder failure/);
    const rc = await cli(['receipts', ctx.runId], ctx.dataDir);
    assert.strictEqual(rc.json.run.paused_by, paused.paused_by);
    const rcText = spawnSync(process.execPath, [CLI, 'receipts', ctx.runId, '--data', ctx.dataDir], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.match(rcText.stdout, /PAUSED for an embedder failure .* by operator:\d+ \[embedder-failure [(]orchestrator,/);

    await cli(['stop', ctx.runId], ctx.dataDir);
    await waitForExit(ctx.run.proc, 20000);
    const receipt = JSON.parse(fs.readFileSync(`${ctx.orchestratorDir}/run.json`, 'utf8'));
    assert.strictEqual(receipt.levers.on_embedder_failure, 'stop');
    assert.strictEqual(receipt.embedder.ok, true);
    assert.strictEqual(receipt.embedder.load_ms, 7);
    assert.strictEqual(receipt.embedder_failures.length, 1);
    const f = receipt.embedder_failures[0];
    assert.deepStrictEqual([f.call, f.code, f.cause, f.action], ['memory.store', 'E_TIMEOUT', 'timeout', 'pause']);
    assert.match(f.worker, /^orchestrator$/);
    assert.strictEqual(f.pause.ok, true);
  } finally { await finish({ ...ctx, dir }); }
});

test('continue: the error goes back to the caller, the run is not paused, and the failure is recorded in the receipt', { timeout: 240000 }, async () => {
  const dir = sandbox();
  let ctx;
  try {
    ctx = await startRun(dir, { on_embedder_failure: 'continue' }, {});
    await assert.rejects(ctx.core.memory.search({ query: 'anything' }), (e) => e.code === 'E_TIMEOUT');
    await new Promise((r) => setTimeout(r, 1500)); // a pause, were one coming, lands well inside this
    assert.strictEqual(currentRunRow(ctx.dataDir, ctx.runId).paused_at, null, 'the run must not be paused');

    await cli(['stop', ctx.runId], ctx.dataDir);
    await waitForExit(ctx.run.proc, 20000);
    const receipt = JSON.parse(fs.readFileSync(`${ctx.orchestratorDir}/run.json`, 'utf8'));
    assert.strictEqual(receipt.levers.on_embedder_failure, 'continue');
    assert.strictEqual(receipt.embedder_failures.length, 1);
    assert.deepStrictEqual([receipt.embedder_failures[0].call, receipt.embedder_failures[0].action, receipt.embedder_failures[0].pause], ['memory.search', 'continue', null]);
  } finally { await finish({ ...ctx, dir }); }
});

test('a caller error out of the embedder phase (E_TOO_LONG, no detail.embedder) does not pause the run', { timeout: 240000 }, async () => {
  const dir = sandbox();
  let ctx;
  try {
    ctx = await startRun(dir, {}, { FAKE_EMBEDDER_MODE: 'caller' });
    await assert.rejects(ctx.core.memory.store({ text: 'x' }), (e) => e.code === 'E_TOO_LONG');
    await new Promise((r) => setTimeout(r, 1500));
    assert.strictEqual(currentRunRow(ctx.dataDir, ctx.runId).paused_at, null);
    await cli(['stop', ctx.runId], ctx.dataDir);
    await waitForExit(ctx.run.proc, 20000);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${ctx.orchestratorDir}/run.json`, 'utf8')).embedder_failures, []);
  } finally { await finish({ ...ctx, dir }); }
});

test('E_MODEL_CHANGED under stop ends the run with the error (resuming can never succeed); under continue the run goes on', { timeout: 240000 }, async () => {
  const dir = sandbox();
  let ctx;
  try {
    ctx = await startRun(dir, {}, { FAKE_EMBEDDER_MODE: 'changed' });
    await assert.rejects(ctx.core.memory.store({ text: 'x' }), (e) => e.code === 'E_MODEL_CHANGED');
    const exited = await waitForExit(ctx.run.proc, 40000);
    assert.ok(exited, 'the run did not end');
    assert.strictEqual(exited.code, 1, 'a run ended by an unfixable embedder failure is not a clean exit');
    const rc = JSON.parse(ctx.run.stderr);
    assert.match(rc.ended_by, /ended by an embedder failure that cannot be fixed inside a run: E_MODEL_CHANGED: .*stop, then run with the store's model or a fresh data dir; stdin closed/);
    assert.deepStrictEqual([rc.embedder_failures[0].action, rc.embedder_failures[0].stop], ['stop', { ok: true }]);
    assert.strictEqual(rc.embedder_failures[0].pause, null, 'it is not a pause');
    assert.strictEqual(currentRunRow(ctx.dataDir, ctx.runId).paused_at, null, 'ended, not paused');
  } finally { await finish({ ...ctx, dir }); }
  const dir2 = sandbox();
  let ctx2;
  try {
    ctx2 = await startRun(dir2, { on_embedder_failure: 'continue' }, { FAKE_EMBEDDER_MODE: 'changed' });
    await assert.rejects(ctx2.core.memory.store({ text: 'x' }), (e) => e.code === 'E_MODEL_CHANGED');
    await new Promise((r) => setTimeout(r, 1500));
    assert.strictEqual(ctx2.run.proc.exitCode, null, 'continue: the run goes on');
  } finally { await finish({ ...ctx2, dir: dir2 }); }
});

test('fix text keys on the cause: exited is not "fetch the model", an op timeout is not "the load did not finish"', () => {
  assert.match(fixFor('E_MODEL_ABSENT', 'absent'), /belay embedder fetch/);
  assert.doesNotMatch(fixFor('E_MODEL_ABSENT', 'dead'), /fetch/);
  assert.match(fixFor('E_MODEL_ABSENT', 'dead'), /exited or cannot be reached/);
  assert.match(fixFor('E_INTERNAL', 'op_failed'), /embed call failed inside the embedder process/);
  assert.doesNotMatch(fixFor('E_INTERNAL', 'op_failed'), /load did not finish|fetch/);
  assert.match(fixFor('E_EMBEDDER_TIMEOUT', 'timeout', 'load'), /load did not finish/);
  assert.doesNotMatch(fixFor('E_EMBEDDER_TIMEOUT', 'timeout', 'op'), /load did not finish/);
  assert.match(fixFor('E_EMBEDDER_TIMEOUT', 'timeout', 'op'), /hung on a call/);
  assert.match(fixFor('E_MODEL_CHANGED', 'canary'), /cannot change inside a run/);
  assert.match(fixFor('E_TIMEOUT', null), /wait for the model load ended before the load did/);
  assert.doesNotMatch(fixFor('E_TIMEOUT', null), /fetch|hung/);
});

test('lever: on_embedder_failure defaults to stop and accepts only stop or continue', () => {
  assert.strictEqual(parseLevers({}).on_embedder_failure, 'stop');
  assert.strictEqual(parseLevers({ on_embedder_failure: 'continue' }).on_embedder_failure, 'continue');
  for (const bad of ['Stop', '', 'pause', 1, null, true, [], {}]) {
    assert.match(parseLevers({ on_embedder_failure: bad }).error, /on_embedder_failure must be one of stop, continue/, String(bad));
  }
  const dir = sandbox();
  try {
    const { specPath } = makeSpec(dir, { on_embedder_failure: 'pause' });
    const r = spawnSync(process.execPath, [CLI, 'run', specPath, '--data', `${dir}/.belay`], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr + r.stdout, /on_embedder_failure must be one of stop, continue/);
    assert.strictEqual(fs.existsSync(`${dir}/.belay`), false, 'a usage error creates no data dir');
  } finally { cleanup(dir); }
});

test('guard: only detail.embedder === true is an embedder failure, every embedder failure asks the idempotent run pause, message text never read', async () => {
  assert.strictEqual(isEmbedderFailure({ code: 'E_MODEL_ABSENT', message: 'the embedder is dead', detail: {} }), false);
  assert.strictEqual(isEmbedderFailure({ code: 'E_TIMEOUT', detail: { embedder: 'true' } }), false);
  assert.strictEqual(isEmbedderFailure({ code: 'E_TIMEOUT', detail: { embedder: true } }), true);
  const pauses = [];
  const g = createEmbedderGuard({ mode: 'stop', pauseRun: async (by) => { pauses.push(by); return { already: false }; } });
  g.onFailure({ caller: { role: 'worker', worker_id: 'w1' }, by: 'w1', call: 'memory.store', error: { code: 'E_TIMEOUT', message: 'm', detail: { embedder: true, cause: 'timeout' } } });
  await g.settled();
  g.onFailure({ caller: { role: 'worker', worker_id: 'w2' }, by: 'w2', call: 'memory.search', error: { code: 'E_MODEL_ABSENT', message: 'm', detail: { embedder: true, cause: 'dead' } } });
  g.onFailure({ caller: { role: 'worker', worker_id: 'w3' }, by: 'w3', call: 'memory.search', error: { code: 'E_ARGS', message: 'bad', detail: {} } });
  await g.settled();
  assert.deepStrictEqual(pauses, ['embedder-failure (w1, memory.store, E_TIMEOUT, timeout)', 'embedder-failure (w2, memory.search, E_MODEL_ABSENT, dead)']);
  assert.deepStrictEqual(g.events().map((e) => [e.worker, e.call, e.cause]), [['w1', 'memory.store', 'timeout'], ['w2', 'memory.search', 'dead']]);
  const failing = createEmbedderGuard({ mode: 'stop', pauseRun: async () => { throw new Error('no orchestrator'); } });
  failing.onFailure({ caller: { role: 'worker', worker_id: 'w1' }, by: 'w1', call: 'memory.store', error: { code: 'E_TIMEOUT', detail: { embedder: true } } });
  await failing.settled();
  assert.deepStrictEqual(failing.events()[0].pause, { ok: false, error: 'no orchestrator' });
});
