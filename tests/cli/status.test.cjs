'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// status.test.cjs — build step 4a, Done item 2. Drives
// the built CLI as subprocesses with the scaffolding of tests/cli/stop.test.cjs and
// tests/cli/stop-helpers.cjs (a fake run held by a planted worker; belay stop to end it), and every
// spawned or planted process killed by exact pid in a finally.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const P = require('../../src/run/process.cjs');
const {
  sandbox, cleanup, waitForFileLine, waitForExit, makeSpec, runCli,
  connectOrchestratorCore, listRecursive, runStopSync,
} = require('./stop-helpers.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;

function statusJson(args, dataDir) {
  return spawnSync(process.execPath, [CLI, 'status', ...args, '--data', dataDir, '--json'], {
    cwd: ROOT, windowsHide: true, encoding: 'utf8',
  });
}

function workersJson(args, dataDir) {
  return spawnSync(process.execPath, [CLI, 'workers', ...args, '--data', dataDir, '--json'], {
    cwd: ROOT, windowsHide: true, encoding: 'utf8',
  });
}

// Amendment A1: reading never writes
// (invariant 6) is asserted around every status/workers invocation below, in every test, including the
// cold-start timings and the reads taken after belay stop. Against a live owner the store's own
// heartbeat and WAL checkpoint change memory.db's byte count and mtime once a second regardless of
// whether anything reads it — the owner's own legitimate background write, not a read's — so the
// comparison that proves "this read created nothing and removed nothing" is the sorted list of
// relative NAMES, exactly what tests/acceptance/a12-observe.cjs's listNames() does; stop-helpers.cjs's
// listRecursive is already name-only in that same way (no size, no mtime), so it is immune to that
// churn and needs no separate byte-for-byte variant for the dead-owner case.
function checkedStatusJson(args, dataDir, label) {
  const before = listRecursive(dataDir);
  const r = statusJson(args, dataDir);
  assert.deepStrictEqual(listRecursive(dataDir), before, `${label}: status changed the data dir listing`);
  return r;
}

function checkedWorkersJson(args, dataDir, label) {
  const before = listRecursive(dataDir);
  const r = workersJson(args, dataDir);
  assert.deepStrictEqual(listRecursive(dataDir), before, `${label}: workers changed the data dir listing`);
  return r;
}

// ================================================================ the tests

test('status: a directory that is not a data dir, a data dir with no store, and a store with no run all read stopped naming the rung, exit 0, and create nothing', async () => {
  // (a) an absent directory: not even mkdir'd by the read.
  {
    const dir = sandbox();
    const dataDir = `${dir}/.belay-absent`;
    const before = listRecursive(dataDir);
    const r = statusJson([], dataDir);
    assert.strictEqual(r.status, 0, `status: ${r.stdout} / ${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.verdict, 'stopped');
    assert.strictEqual(j.rungs[0].rung, 'configured');
    assert.strictEqual(j.rungs[0].established, false);
    assert.ok(!fs.existsSync(dataDir), 'status created the data dir');
    assert.deepStrictEqual(listRecursive(dataDir), before, 'status changed the (absent) data dir listing');
    cleanup(dir);
  }

  // (b) a data dir that exists but holds no store.
  {
    const dir = sandbox();
    const dataDir = `${dir}/.belay`;
    fs.mkdirSync(dataDir, { recursive: true });
    const before = listRecursive(dataDir);
    const r = statusJson([], dataDir);
    assert.strictEqual(r.status, 0, `status: ${r.stdout} / ${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.verdict, 'stopped');
    assert.strictEqual(j.rungs.find((x) => x.rung === 'store-present').established, false);
    assert.deepStrictEqual(listRecursive(dataDir), before, 'status created a file in an empty data dir');
    cleanup(dir);
  }

  // (c) a store where a fake run already ran to completion and its owner is gone.
  {
    const dir = sandbox();
    const dataDir = `${dir}/.belay`;
    const { specPath, runId } = makeSpec(dir);
    const runCliProc = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE });
    try {
      const exited = await waitForExit(runCliProc.proc, 30000);
      assert.ok(exited, 'the plain fake run never exited');
      assert.strictEqual(exited.code, 0);

      const before = listRecursive(dataDir);
      const r = statusJson([runId], dataDir);
      assert.strictEqual(r.status, 0, `status: ${r.stdout} / ${r.stderr}`);
      const j = JSON.parse(r.stdout);
      assert.strictEqual(j.verdict, 'stopped');
      assert.ok(j.run && j.run.id === runId);
      assert.ok(j.run.ended_at != null, 'the run row lacks ended_at');
      assert.match(j.run.exit_reason, /stdin closed/);
      assert.strictEqual(j.rungs.find((x) => x.rung === 'run-alive').established, false);
      const ownerAlive = j.rungs.find((x) => x.rung === 'owner-alive');
      assert.strictEqual(ownerAlive.established, false);
      assert.match(ownerAlive.by, /no owner\.lock in the data dir/);
      assert.deepStrictEqual(listRecursive(dataDir), before, 'status created a file after the run ended');
    } finally {
      if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
      cleanup(dir);
    }
  }
});

test('status: a live run reads alive, established by a bounded ping and pid checks, and names the planted worker mid-turn', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId, orchestratorDir } = makeSpec(dir, { poll_ms: 300, close_grace_ms: 2000 });
  // The orchestrator answers late: the run's owner vouches for this test as the operator by its process before it binds the test as an
  // orchestrator (about a second), and the planted worker has to land before the orchestrator's turn ends the run.
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_DELAY_MS: '5000' };
  const runCliProc = runCli(specPath, dataDir, env);
  let core = null;
  let plantedProc = null;
  try {
    core = await connectOrchestratorCore(dataDir, runId);
    plantedProc = spawn(process.execPath, [FAKE_CLAUDE], {
      cwd: dir, env: { ...process.env, FAKE_HANG: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const plantedPid = plantedProc.pid;
    const workerWt = `${dir}/w1-wt`;
    fs.mkdirSync(workerWt, { recursive: true });
    await core.worker.write({
      id: 'w1', substrate: 'claude-code', pid: plantedPid, pid_image: 'node.exe', state: 'running',
      turns: 0, mid_turn: 1, started_at: Date.now(), worktree: workerWt,
    });
    // A fresh stream.jsonl makes w1 responsive too, so the ladder's sixth rung holds and the verdict
    // is `alive`, not merely `degraded` on a live but silent worker.
    const w1StreamDir = `${dataDir}/workers/w1`;
    fs.mkdirSync(w1StreamDir, { recursive: true });
    fs.writeFileSync(`${w1StreamDir}/stream.jsonl`, '{"type":"assistant"}\n');

    const streamPath = `${orchestratorDir}/stream.jsonl`;
    const gotResult = await waitForFileLine(streamPath, '"type":"result"', 15000);
    assert.ok(gotResult, "the orchestrator's own first turn never ended");

    // No argument: resolved through run.list.
    let r = checkedStatusJson([], dataDir, 'no-argument read');
    assert.strictEqual(r.status, 0, `status: ${r.stdout} / ${r.stderr}`);
    let j = JSON.parse(r.stdout);
    assert.strictEqual(j.run_id_source, 'run.list');
    assert.strictEqual(j.verdict, 'alive');
    const ownerAlive = j.rungs.find((x) => x.rung === 'owner-alive');
    // Amendment A3: this CLI read reached a live owner over the pipe (it is a different process, with
    // its own pid, from the belay run process that holds the lock), so the rung must tell this caller
    // the truth rather than relay the owner's own in-process wording. The literal shape, not "either":
    assert.strictEqual(ownerAlive.established, true);
    assert.strictEqual(ownerAlive.detail.answered, true);
    assert.strictEqual(ownerAlive.detail.established_by, 'answered over the pipe');
    assert.strictEqual(ownerAlive.detail.pid, runCliProc.proc.pid, "detail.pid must be the belay run process's own pid");
    assert.ok(Number.isFinite(ownerAlive.detail.caller_pid), `detail.caller_pid must be a finite number: ${JSON.stringify(ownerAlive.detail)}`);
    assert.notStrictEqual(ownerAlive.detail.caller_pid, ownerAlive.detail.pid, 'the caller is not the owner');
    assert.strictEqual(ownerAlive.detail.caller_pid, r.pid, "detail.caller_pid must be this belay status subprocess's own pid");
    assert.strictEqual(j.rungs.find((x) => x.rung === 'run-alive').established, true);
    const workerAlive = j.rungs.find((x) => x.rung === 'worker-alive');
    assert.strictEqual(workerAlive.established, true);
    assert.ok(workerAlive.detail.workers.some((w) => w.id === 'w1' && w.pid === plantedPid));
    const w1 = j.workers.find((w) => w.id === 'w1');
    assert.ok(w1, 'w1 missing from the workers projection');
    assert.strictEqual(w1.mid_turn, 1);

    // With the run id given explicitly.
    r = checkedStatusJson([runId], dataDir, 'explicit run id read');
    assert.strictEqual(r.status, 0, `status <id>: ${r.stdout} / ${r.stderr}`);
    j = JSON.parse(r.stdout);
    assert.strictEqual(j.run_id_source, 'argument');
    assert.strictEqual(j.verdict, 'alive');

    // An id naming no run at all.
    r = checkedStatusJson(['no-such-run'], dataDir, 'unknown run id read');
    assert.strictEqual(r.status, 0, `status no-such-run: ${r.stdout} / ${r.stderr}`);
    j = JSON.parse(r.stdout);
    assert.strictEqual(j.verdict, 'stopped');
    assert.match(j.rungs.find((x) => x.rung === 'run-alive').by, /no run row for no-such-run/);

    // Stop the run, then read status again.
    const stop = runStopSync(dataDir, runId);
    assert.strictEqual(stop.status, 0, `stop: ${stop.stdout} / ${stop.stderr}`);
    const exited = await waitForExit(runCliProc.proc, 30000);
    assert.ok(exited, 'the CLI run did not exit after the stop');

    r = checkedStatusJson([runId], dataDir, 'read after belay stop');
    assert.strictEqual(r.status, 0, `status after stop: ${r.stdout} / ${r.stderr}`);
    j = JSON.parse(r.stdout);
    assert.strictEqual(j.verdict, 'stopped');
    assert.ok(j.run.ended_at != null, 'run.ended_at is null after the stop');
    assert.match(j.run.exit_reason, /stopped by belay stop/);
    const ownerAliveAfter = j.rungs.find((x) => x.rung === 'owner-alive');
    assert.strictEqual(ownerAliveAfter.established, false);
    assert.match(ownerAliveAfter.by, /no owner\.lock in the data dir/);
    const w1After = j.workers.find((w) => w.id === 'w1');
    assert.ok(w1After, 'w1 missing from the workers projection after the stop');
    assert.strictEqual(w1After.pid_alive, false);
  } finally {
    if (plantedProc && P.pidAlive(plantedProc.pid)) { try { require('../crash.cjs').crash(plantedProc); } catch { /* best effort */ } }
    if (core) { try { await core.close(); } catch { /* best effort */ } }
    if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});

test('status and workers: the default-run selection prefers a run that is still alive over a newer one that has ended', async () => {
  // Fix round (should-fix): the two-run fixture existed only in the workers test, so a mutation that
  // makes cmd-status.cjs pick the OLDEST run, or that drops the alive-preference filter entirely, was
  // invisible to this file. run.list orders by the row most recently WRITTEN, so a run-old-live row
  // never ended must still be chosen over a run-new-dead row written after it, for both commands.
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { openCore } = require('../../src/core/index.cjs');
  let liveAdapter = null;
  // Round-2 should-fix: both cores must be declared before the try and closed in the finally, not left
  // as `const` inside it — otherwise a throw between opening either core and its own shutdownOwner()
  // call (a regression in run.attach/run.end/openCore, which are all owned files of this step) leaves
  // the elected owner alive: pipe server listening, owner.lock held, sqlite handle open, and
  // `node --test` never exits instead of turning red.
  let oldCore = null;
  let newCore = null;
  try {
    liveAdapter = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve) => liveAdapter.once('spawn', resolve));

    oldCore = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-old-live', pid: process.pid } });
    await oldCore.run.attach({ adapter_pid: liveAdapter.pid });
    await oldCore.shutdownOwner();
    await oldCore.close();

    newCore = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-new-dead', pid: process.pid } });
    await newCore.run.attach({ adapter_pid: process.pid });
    await newCore.run.end({ exit_reason: 'test finished' });
    await newCore.shutdownOwner();
    await newCore.close();

    // Neither core is the owner any more (both shut down above, so the read below takes the copy
    // path), which forces the owner-alive rung false and the overall verdict to `stopped` regardless
    // of the run itself — the fact under test is which run got named and that run's own `alive`.
    const r = checkedStatusJson([], dataDir, 'status default selection, mixed store');
    assert.strictEqual(r.status, 0, `status: ${r.stdout} / ${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.run_id_source, 'run.list');
    assert.strictEqual(j.run.id, 'run-old-live', 'status named the newest WRITTEN run instead of the live one');
    assert.strictEqual(j.run.alive, true, "run-old-live's own row is alive: never ended, adapter pid still alive");

    const rw = checkedWorkersJson([], dataDir, 'workers default selection, mixed store');
    assert.strictEqual(rw.status, 0, `workers: ${rw.stdout} / ${rw.stderr}`);
    const jw = JSON.parse(rw.stdout);
    assert.strictEqual(jw.run_id, 'run-old-live', 'workers named the newest WRITTEN run instead of the live one');
  } finally {
    // shutdownOwner() then close(), each guarded: whichever core actually won the in-process election
    // stops it directly, and the other's shutdownOwner() finds no live lock and no-ops (the same
    // pattern tests/core/status.test.cjs's own two-core test uses).
    if (oldCore) { try { await oldCore.shutdownOwner(); } catch { /* best effort */ } try { await oldCore.close(); } catch { /* best effort */ } }
    if (newCore) { try { await newCore.shutdownOwner(); } catch { /* best effort */ } try { await newCore.close(); } catch { /* best effort */ } }
    if (liveAdapter && P.pidAlive(liveAdapter.pid)) { try { require('../crash.cjs').crash(liveAdapter); } catch { /* best effort */ } }
    cleanup(dir);
  }
});

test("workers: lists the run's worker rows with the two columns, filters to the run, and --all lists every run", async () => {
  // Part 1: a live run's planted worker, carrying the two harness-derived columns.
  {
    const dir = sandbox();
    const dataDir = `${dir}/.belay`;
    const { specPath, runId, orchestratorDir } = makeSpec(dir, { poll_ms: 300, close_grace_ms: 2000 });
    const gate = `${dir}/answer.gate`; // the turn ends when the planted worker is written, not after a timer
    const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_GATE_FILE: gate };
    const runCliProc = runCli(specPath, dataDir, env);
    let core = null;
    let plantedProc = null;
    try {
      core = await connectOrchestratorCore(dataDir, runId);
      plantedProc = spawn(process.execPath, [FAKE_CLAUDE], {
        cwd: dir, env: { ...process.env, FAKE_HANG: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      const plantedPid = plantedProc.pid;
      const workerWt = `${dir}/w1-wt`;
      fs.mkdirSync(workerWt, { recursive: true });
      await core.worker.write({
        id: 'w1', substrate: 'claude-code', pid: plantedPid, pid_image: 'node.exe', state: 'running',
        turns: 0, mid_turn: 1, started_at: Date.now(), worktree: workerWt,
      });
      fs.writeFileSync(gate, 'go');

      const streamPath = `${orchestratorDir}/stream.jsonl`;
      const gotResult = await waitForFileLine(streamPath, '"type":"result"', 15000);
      assert.ok(gotResult, "the orchestrator's own first turn never ended");

      const r = checkedWorkersJson([], dataDir, 'live run workers read');
      assert.strictEqual(r.status, 0, `workers: ${r.stdout} / ${r.stderr}`);
      const j = JSON.parse(r.stdout);
      assert.strictEqual(j.run_id_source, 'run.list');
      const w1 = j.workers.find((w) => w.id === 'w1');
      assert.ok(w1, 'w1 missing from belay workers');
      assert.strictEqual(w1.mid_turn, 1);
      assert.strictEqual(w1.pid_alive, true);
      assert.strictEqual(w1.death_established_by, null);

      const stop = runStopSync(dataDir, runId);
      assert.strictEqual(stop.status, 0, `stop: ${stop.stdout} / ${stop.stderr}`);
      const exited = await waitForExit(runCliProc.proc, 30000);
      assert.ok(exited, 'the CLI run did not exit after the stop');
    } finally {
      if (plantedProc && P.pidAlive(plantedProc.pid)) { try { require('../crash.cjs').crash(plantedProc); } catch { /* best effort */ } }
      if (core) { try { await core.close(); } catch { /* best effort */ } }
      if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
      cleanup(dir);
    }
  }

  // Part 2: two finished runs sharing a store — the default filter, --all, and an explicit older id.
  {
    const dir = sandbox();
    const dataDir = `${dir}/.belay`;
    const { openCore } = require('../../src/core/index.cjs');

    async function plantFinishedWorker(runId, idSuffix) {
      // A fixture over a finished run: an ended run takes no orchestrator write, so the run process (operator) reopens it for the
      // write and ends it again.
      const op = await openCore({ dataDir, caller: { role: 'operator', run_id: runId, pid: process.pid } });
      const c = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
      try {
        await op.run.attach({ adapter_pid: process.pid });
        await c.worker.write({ id: `w-${idSuffix}`, substrate: 'claude-code', pid: process.pid, pid_image: 'node.exe', state: 'stopped', turns: 1 });
        await op.run.end({ exit_reason: 'fixture' });
      } finally {
        await c.close();
        await op.shutdownOwner();
        await op.close();
      }
    }

    // Round-2 note: both belay run children are killed by exact pid tree in the finally below if they
    // are still alive, so a waitForExit that times out never leaves a store owner behind and never
    // skips cleanup(dir).
    let runA = null;
    let runB = null;
    try {
      const first = makeSpec(dir, { orchestrator_dir: `${dir}/orch-a` });
      runA = runCli(first.specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE });
      const exitedA = await waitForExit(runA.proc, 30000);
      assert.ok(exitedA, 'the first plain fake run never exited');
      await plantFinishedWorker(first.runId, 'a');

      const second = makeSpec(dir, { orchestrator_dir: `${dir}/orch-b` });
      runB = runCli(second.specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE });
      const exitedB = await waitForExit(runB.proc, 30000);
      assert.ok(exitedB, 'the second plain fake run never exited');
      await plantFinishedWorker(second.runId, 'b');

      let r = checkedWorkersJson([], dataDir, 'default-filter read');
      assert.strictEqual(r.status, 0, `workers (default): ${r.stdout} / ${r.stderr}`);
      let j = JSON.parse(r.stdout);
      assert.strictEqual(j.run_id, second.runId, 'the default filter must name the newest run');
      assert.strictEqual(j.workers.length, 1);
      assert.strictEqual(j.workers[0].id, 'w-b');

      r = checkedWorkersJson(['--all'], dataDir, '--all read');
      assert.strictEqual(r.status, 0, `workers --all: ${r.stdout} / ${r.stderr}`);
      j = JSON.parse(r.stdout);
      assert.deepStrictEqual(j.workers.map((w) => w.id).sort(), ['w-a', 'w-b']);

      r = checkedWorkersJson([first.runId], dataDir, 'explicit older run id read');
      assert.strictEqual(r.status, 0, `workers <older>: ${r.stdout} / ${r.stderr}`);
      j = JSON.parse(r.stdout);
      assert.strictEqual(j.workers.length, 1);
      assert.strictEqual(j.workers[0].id, 'w-a');
    } finally {
      if (runA && runA.proc.exitCode === null) { try { await P.killTree(runA.proc); } catch { /* best effort */ } }
      if (runB && runB.proc.exitCode === null) { try { await P.killTree(runB.proc); } catch { /* best effort */ } }
      cleanup(dir);
    }
  }

  // Part 3: a store with no runs at all.
  {
    const dir = sandbox();
    const dataDir = `${dir}/.belay-empty`;
    const r = checkedWorkersJson([], dataDir, 'no-runs-at-all read');
    assert.strictEqual(r.status, 0, `workers (empty): ${r.stdout} / ${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assert.deepStrictEqual(j.workers, []);
    cleanup(dir);
  }
});

test('status and workers: no CLI path to either loads the embedder or the store module until a read needs it', () => {
  // Requiring the dispatcher and each command module must not reach the embedder.
  const probe = `
    require(${JSON.stringify(CLI)});
    require(${JSON.stringify(`${ROOT}/src/cli/cmd-status.cjs`)});
    require(${JSON.stringify(`${ROOT}/src/cli/cmd-workers.cjs`)});
    const hit = Object.keys(require.cache).filter(k => /src[\\\\/]core[\\\\/]embedder\\.cjs$/i.test(k));
    process.stdout.write(JSON.stringify(hit));
  `;
  const rProbe = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(rProbe.status, 0, `probe failed: ${rProbe.stderr}`);
  assert.deepStrictEqual(JSON.parse(rProbe.stdout), [], 'requiring the command modules reached the embedder');

  const dir = sandbox();
  const dataDir = `${dir}/.belay-cold`;
  const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-status-dump-'));
  const dumper = path.join(dumpDir, 'dump-cache.cjs');
  fs.writeFileSync(dumper, [
    "process.on('exit', () => {",
    '  try {',
    "    require('fs').writeFileSync(process.env.BELAY_CACHE_DUMP, JSON.stringify(Object.keys(require.cache)));",
    '  } catch (e) { /* best effort */ }',
    '});',
    '',
  ].join('\n'));
  try {
    for (const args of [['status'], ['workers']]) {
      const dumpFile = path.join(dumpDir, `${args[0]}.json`);
      const beforeListing = listRecursive(dataDir);
      const r = spawnSync(process.execPath, [CLI, ...args, '--data', dataDir, '--json'], {
        cwd: ROOT, windowsHide: true, encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: `--require ${dumper}`, BELAY_CACHE_DUMP: dumpFile },
      });
      assert.strictEqual(r.status, 0, `${args[0]}: ${r.stdout} / ${r.stderr}`);
      // Amendment A1: the cold-start timings and cache-dump reads are bracketed exactly like every
      // other status/workers invocation in this file, by name only (see the comment above
      // checkedStatusJson/checkedWorkersJson).
      assert.deepStrictEqual(listRecursive(dataDir), beforeListing, `${args[0]} (cache-dump run) changed the data dir listing`);
      const cache = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
      const bad = cache.filter((k) => /embedder\.cjs$/i.test(k) || /@huggingface/i.test(k));
      assert.deepStrictEqual(bad, [], `${args[0]} reached the embedder: ${bad.join(', ')}`);
    }
  } finally {
    fs.rmSync(dumpDir, { recursive: true, force: true });
    cleanup(dir);
  }
});
