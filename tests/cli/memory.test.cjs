'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// memory.test.cjs — build step 4b, amended by the
// orchestrator's Amendment section (B2, B3, B5). Drives the built CLI's `memory search` and
// `memory stats` as subprocesses, with the scaffolding of tests/cli/status.test.cjs and
// tests/cli/stop-helpers.cjs. `tasks`/`briefing` are tests/cli/observe.test.cjs's own file (B4).

const { test } = require('node:test');
const assert = require('node:assert');

const P = require('../../src/run/process.cjs');
const { openCore } = require('../../src/core/index.cjs');
const {
  ROOT, CLI, sandbox, cleanup, makeSpec, runCli, connectOrchestratorCore, listRecursive, runStopSync, waitForExit, releaseCore,
} = require('./stop-helpers.cjs');
const { spawn, spawnSync } = require('node:child_process');

const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;

const vec = (seed) => Array.from({ length: 384 }, (_, i) => (((i + seed) % 7) + 1) / 10);
const vec1024 = (seed) => Array.from({ length: 1024 }, (_, i) => (((i + seed) % 7) + 1) / 10);
const M = require('../../src/core/models.cjs');

function memorySearchText(args, dataDir) {
  return spawnSync(process.execPath, [CLI, 'memory', 'search', ...args, '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
}
function memoryStatsText(args, dataDir) {
  return spawnSync(process.execPath, [CLI, 'memory', 'stats', ...args, '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
}
function memorySearchJson(args, dataDir) {
  return spawnSync(process.execPath, [CLI, 'memory', 'search', ...args, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
}
function memoryStatsJson(args, dataDir) {
  return spawnSync(process.execPath, [CLI, 'memory', 'stats', ...args, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
}

// B3: reading never writes, asserted by the sorted NAME listing — the same comparison
// tests/cli/status.test.cjs's checkedStatusJson uses.
function checked(fn, dataDir, label) {
  const before = listRecursive(dataDir);
  const r = fn();
  assert.deepStrictEqual(listRecursive(dataDir), before, `${label}: changed the data dir listing`);
  return r;
}

test('memory: search against a store with no live owner is refused E_NO_EMBEDDER with exit 1 and creates nothing; stats reads through the copy and names no live owner', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  // Planted through a core opened as role orchestrator, B5's own recipe (run.attach, task.create, then
  // memory.store with a supplied vector), then shut down before any read below, so every belay memory
  // invocation in this test takes the copy path (invariant 6).
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-x', pid: process.pid } });
  try {
    await core.run.attach({ adapter_pid: process.pid });
    await core.task.create({ spec: 'planted per B5, so this file is sensitive to a task.create regression too' });
    await core.memory.store({ namespace: 'run/run-x', text: 'a stored row with a supplied vector', embedding: vec(1), embedding_model: 'fixture', dim: 384 });
  } finally {
    await core.shutdownOwner();
    await core.close();
  }

  const r = checked(() => memorySearchJson(['anything', 'run-x'], dataDir), dataDir, 'memory search (dead store)');
  assert.strictEqual(r.status, 1, `memory search: ${r.stdout} / ${r.stderr}`);
  const j = JSON.parse(r.stderr);
  assert.strictEqual(j.error.code, 'E_NO_EMBEDDER');
  assert.match(j.reason, /needs a live owner to embed the query/);

  // Text output names the reason too, not only --json (B3).
  const rText = checked(() => memorySearchText(['anything', 'run-x'], dataDir), dataDir, 'memory search (dead store, text)');
  assert.strictEqual(rText.status, 1);
  assert.match(rText.stderr, /needs a live owner to embed the query/);

  const rStats = checked(() => memoryStatsJson(['run-x'], dataDir), dataDir, 'memory stats (dead store)');
  assert.strictEqual(rStats.status, 0, `memory stats: ${rStats.stdout} / ${rStats.stderr}`);
  const jStats = JSON.parse(rStats.stdout);
  assert.strictEqual(jStats.owner.alive, false);
  assert.match(jStats.owner.established_by, /no owner\.lock in the data dir/);

  const rStatsText = checked(() => memoryStatsText(['run-x'], dataDir), dataDir, 'memory stats (dead store, text)');
  assert.strictEqual(rStatsText.status, 0);
  assert.match(rStatsText.stdout, /^owner: /m, 'the stats owner line must be present');
  assert.match(rStatsText.stdout, /alive=false/);

  cleanup(dir);
});

// A run process is the store owner; a planted mid-turn worker keeps the run open for the life of the
// body, as tests/run/run-wake.test.cjs does. `envExtra` chooses the owner's model cache. The body gets
// { core, dataDir, runId, runCliProc, dir }; the teardown stops the run gracefully, never by signal first.
async function withLiveOwner(envExtra, body) {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId } = makeSpec(dir, { poll_ms: 300, close_grace_ms: 2000 });
  const runCliProc = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_DELAY_MS: '500', ...envExtra(dir) });
  let core = null;
  let plantedProc = null;
  try {
    core = await connectOrchestratorCore(dataDir, runId);
    plantedProc = spawn(process.execPath, [FAKE_CLAUDE], {
      cwd: dir, env: { ...process.env, FAKE_HANG: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    await core.worker.write({ id: 'w1', substrate: 'claude-code', pid: plantedProc.pid, pid_image: 'node.exe', state: 'running', turns: 0, mid_turn: 1, started_at: Date.now() });
    await core.task.create({ spec: 'planted per B5, so this file is sensitive to a task.create regression too' });
    const afterExit = await body({ core, dataDir, runId, runCliProc, dir });

    const rs = checked(() => memoryStatsJson([runId], dataDir), dataDir, 'memory stats (live owner)');
    assert.strictEqual(rs.status, 0, `memory stats: ${rs.stdout} / ${rs.stderr}`);
    const js = JSON.parse(rs.stdout);
    assert.strictEqual(js.owner.alive, true, 'the live owner must report alive');
    assert.strictEqual(js.owner.pid, runCliProc.proc.pid, "the owner pid must be the belay run process's own pid");
    // 4b review 2, finding 1: the relabel in cmd-memory.cjs is pinned here.
    assert.strictEqual(js.owner.established_by, `owner pid ${runCliProc.proc.pid} answered this request over the pipe (this CLI process is not the owner)`, 'the owner block must name the pipe, not the owner\'s in-process wording');

    const stop = runStopSync(dataDir, runId);
    assert.strictEqual(stop.status, 0, `stop: ${stop.stdout} / ${stop.stderr}`);
    assert.ok(await waitForExit(runCliProc.proc, 15000), 'the CLI run did not exit after the stop');
    if (typeof afterExit === 'function') afterExit(dataDir);
  } finally {
    if (plantedProc && P.pidAlive(plantedProc.pid)) { try { require('../crash.cjs').crash(plantedProc); } catch { /* best effort */ } }
    if (core && runCliProc.proc.exitCode === null) { try { await core.shutdownOwner(); } catch { /* best effort */ } }
    await releaseCore(core);
    if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
}

test('memory: search against a live owner with no model in its cache is E_MODEL_ABSENT exactly, and stats names the owner by its lock and pid', async () => {
  await withLiveOwner((dir) => ({ BELAY_MODEL_CACHE: `${dir}/no-models` }), async ({ core, dataDir, runId, runCliProc }) => {
    await core.memory.store({ namespace: `run/${runId}`, text: 'a planted row', embedding: vec1024(1), embedding_model: M.DEFAULT_MODEL, dim: 1024 });
    // SF4: the listing is compared only after the run's process has exited (awaited by pid): while it
    // lives it may itself end and remove owner.lock and the WAL files during the search.
    const before = listRecursive(dataDir);
    // The core re-pings a live owner once with a 2,000 ms bound before calling it lost (build 12b E2), so a
    // healthy owner that stalled on a fork no longer needs a retry here.
    const r = memorySearchJson(['anything at all', '-k', '2', runId], dataDir);
    assert.strictEqual(r.status, 1, `memory search: ${r.stdout} / ${r.stderr}`);
    const j = JSON.parse(r.stderr);
    assert.strictEqual(j.error.code, 'E_MODEL_ABSENT', `unexpected refusal: ${JSON.stringify(j)}`);
    assert.ok(j.error.message.includes('belay embedder fetch'), j.error.message);
    return (dataDirAfterExit) => {
      const created = listRecursive(dataDirAfterExit).filter(p => !before.includes(p));
      assert.deepStrictEqual(created, [], 'memory search created a file');
    };
  });
});
