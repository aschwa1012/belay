'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// worker.test.cjs — build step 6b, done item 1. Drives the
// built CLI as subprocesses, in the scaffolding of tests/cli/stop-helpers.cjs and
// tests/cli/intervene.test.cjs: a test core plants worker rows directly (kill needs no adapter to be
// live at all), and a `belay run` with a FAKE_HANG=1 orchestrator plus a real RunManager in this
// process stands in for a live adapter when the detector's own dead row matters.

const { readCreated } = require('../helpers/created.cjs');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const P = require('../../src/run/process.cjs');
const {
  sandbox, cleanup, waitUntil, makeSpec, runCli, listRecursive, readStoreCopy, releaseCore,
} = require('./stop-helpers.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { endOwnerProcess } = require('./run-teardown.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const USER_SETTINGS = `${ROOT}/tests/run/fixtures/user-settings.json`;

// A pid that is certainly dead by the time it is used: a child that has already exited, never a
// made-up number (pids are recycled and a guess can be alive).
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
  return r.pid;
}

// A pid that is certainly alive until killed and is not this test process's own.
function hungChild() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
}

async function killHung(child) {
  if (!child || child.exitCode !== null) return;
  try { await P.killTree(child); } catch { /* best effort: the test's own kill may already have reaped it */ }
}

// A snapshot's PowerShell is one of this process's children, so the count waits for the gate to be idle first (ADR 0048).
async function ownChildCount() {
  await require('../../src/core/proc-identity.cjs').gate.whenIdle();
  return (await P.childPids(process.pid)).length;
}

function cliSync(args, dataDir, extraEnv) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--data', dataDir, '--json'], {
    cwd: ROOT, windowsHide: true, encoding: 'utf8', env: { ...process.env, ...(extraEnv || {}) },
  });
  let receipt = null;
  try { receipt = JSON.parse(r.status === 0 ? r.stdout : r.stderr); } catch { /* left null */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, receipt };
}

// A non-blocking CLI invocation, needed only when a live RunManager's own poll and exit-event
// handlers run in THIS process: spawnSync would freeze this process's whole event loop for the
// kill's own 2,000 ms wait, starving the very detector the test is watching for.
function cliAsync(args, dataDir, extraEnv) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args, '--data', dataDir, '--json'], {
      cwd: ROOT, windowsHide: true, env: { ...process.env, ...(extraEnv || {}) },
    });
    let stdout = ''; proc.stdout.on('data', (d) => { stdout += d; });
    let stderr = ''; proc.stderr.on('data', (d) => { stderr += d; });
    proc.once('exit', (status) => {
      let receipt = null;
      try { receipt = JSON.parse(status === 0 ? stdout : stderr); } catch { /* left null */ }
      resolve({ status, stdout, stderr, receipt });
    });
  });
}

function countWorkerRows(dataDir) {
  return readStoreCopy(dataDir, (db) => db.prepare('SELECT COUNT(*) AS n FROM worker').get().n);
}

async function connectOrchestrator(dataDir, runId) {
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
  const row = await waitUntil(async () => (await core.run.get()).run || null, 10000, 100);
  assert.ok(row, "the CLI's run row never appeared within 10,000 ms");
  return core;
}

async function waitForWorkerPid(core, workerId, timeoutMs) {
  return waitUntil(async () => {
    try {
      const w = await core.worker.get({ worker_id: workerId });
      return w && w.pid && w.pid_created ? w : null; // ADR 0039: a kill needs the creation time the manager restates a moment after spawn
    } catch { return null; }
  }, timeoutMs, 50);
}

function workerWorktree(dir, id) {
  const wt = `${dir}/${id}-wt`;
  fs.mkdirSync(wt, { recursive: true });
  return wt;
}

// ================================================================ worker kill, no adapter alive

test('worker kill: kills the exact pid a planted starting row names, writes nothing, and with no adapter alive reports the row standing as it was', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const hung = hungChild();
  try {
    const plantCore = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-a', pid: process.pid } });
    let planted;
    try {
      const made = await readCreated(hung.pid); // ADR 0039: the identity a real spawn records
      planted = await plantCore.worker.write({ id: 'w1', substrate: 'claude-code', pid: hung.pid, pid_created: made.created, pid_image: 'node.exe', state: 'starting', turns: 0, started_at: Date.now() });
    } finally {
      await plantCore.shutdownOwner();
      await plantCore.close();
    }
    const before = countWorkerRows(dataDir);

    const r = cliSync(['worker', 'kill', 'w1'], dataDir);
    assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
    assert.ok(r.receipt, 'worker kill produced no parseable receipt');
    assert.strictEqual(r.receipt.killed, true);
    assert.strictEqual(r.receipt.pid, hung.pid);
    assert.strictEqual(r.receipt.pid_alive_after, false);
    assert.strictEqual(r.receipt.row_after.seq, planted.seq, 'no adapter is alive, so the row must stand exactly as planted');
    assert.match(r.receipt.row_after_established_by, /no terminal row landed within 2,000 ms/);
    // build step 6c item 8: a real kill never claims already_gone.
    assert.ok(r.receipt.already_gone === undefined || r.receipt.already_gone === false, JSON.stringify(r.receipt));

    assert.strictEqual(P.pidAlive(hung.pid), false, 'the hung child must actually be dead');
    assert.strictEqual(countWorkerRows(dataDir), before, 'kill with no adapter alive must write nothing to the store');
  } finally {
    await killHung(hung);
    cleanup(dir);
  }
});

// ================================================================ worker kill, a live run manager lands the dead row

test("worker kill: with a live run manager the adapter's detector lands the dead row and the receipt names what established it", async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId } = makeSpec(dir, { startup_timeout_ms: 120000 });
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_HANG: '1' };
  const runCliProc = runCli(specPath, dataDir, env);
  let core = null, m = null;
  try {
    core = await connectOrchestrator(dataDir, runId);
    m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE_CLAUDE, userSettings: USER_SETTINGS } });

    // FAKE_HANG=1: the fake produces no output at all, not even a ready event, so m.spawn never
    // resolves on its own; fired without an await, its eventual rejection is swallowed. The row still
    // lands: spawn writes `starting` with a live pid before it ever waits for readiness.
    process.env.FAKE_HANG = '1';
    m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' }).catch(() => {});
    const row = await waitForWorkerPid(core, 'w1', 10000);
    delete process.env.FAKE_HANG;
    assert.ok(row && row.pid, 'the planted worker never got a live pid in the store');

    // cliAsync, not cliSync: a blocking spawnSync here would freeze this process's own event loop —
    // where the manager's poll and exit-event handlers live — for the whole 2,000 ms wait, starving
    // the very detector this test is watching for.
    const r = await cliAsync(['worker', 'kill', 'w1'], dataDir);
    assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
    assert.strictEqual(r.receipt.killed, true);
    assert.strictEqual(r.receipt.row_after.state, 'dead', `the manager's own detector must have landed a dead row: ${JSON.stringify(r.receipt)}`);
    assert.match(r.receipt.row_after.death_established_by || '', /exit-event|pid-poll/);
    assert.match(r.receipt.row_after_established_by, /the adapter's detector wrote seq \d+ dead \(.+\) within \d+ ms/);
    // The command waits at most DEATH_LAND_MS (about 7.5 s) for the row, then one more read; 15 s covers a slow read.
    assert.ok(r.receipt.row_after_waited_ms < 15000, `row_after_waited_ms ${r.receipt.row_after_waited_ms} must be under the 15,000 ms bound`);
    assert.strictEqual(r.receipt.pid_alive_after, false);
    // build step 6c item 8: ms_to_dead is measured from before killTree, so it is never shorter than
    // the tree kill's own ms whenever the tree kill actually terminated something.
    if (r.receipt.tree && r.receipt.tree.terminated > 0) {
      assert.ok(r.receipt.ms_to_dead >= r.receipt.tree.ms, `ms_to_dead ${r.receipt.ms_to_dead} must be >= tree.ms ${r.receipt.tree.ms}`);
    }
  } finally {
    delete process.env.FAKE_HANG;
    // build step 6i-2 fix round (item 4/R5): run.stop over the run's own owner pipe, issued before
    // m.shutdown() — the record of which one actually ended it is the plant table's own check (Q13).
    const endedBy = await endOwnerProcess(runCliProc.proc, dataDir, runId);
    console.log(`[6i-2 item4] worker kill (live run manager) owner ended by: ${endedBy}`);
    if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
    await releaseCore(core);
    cleanup(dir);
  }
});

// ================================================================ worker kill, four refusals

test('worker kill: refuses an unknown id, a dead row, a live-state row over a dead pid, and a row with no pid, each naming the fact, creating nothing', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const plantCore = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-c', pid: process.pid } });
  try {
    await plantCore.worker.write({ id: 'w-dead', substrate: 'claude-code', pid: deadPid(), pid_created: 1, state: 'dead', turns: 0, started_at: Date.now() });
    await plantCore.worker.write({ id: 'w-ghost', substrate: 'claude-code', pid: deadPid(), pid_created: 1, state: 'starting', turns: 0, started_at: Date.now() });
    await plantCore.worker.write({ id: 'w-nopid', substrate: 'codex', pid: null, state: 'idle', turns: 0, started_at: Date.now() });
  } finally {
    await plantCore.shutdownOwner();
    await plantCore.close();
  }

  const before = listRecursive(dataDir);
  const nodesBefore = await ownChildCount();

  const r1 = cliSync(['worker', 'kill', 'no-such-worker'], dataDir);
  assert.strictEqual(r1.status, 1, `${r1.stdout} / ${r1.stderr}`);
  assert.strictEqual(r1.receipt.killed, false);
  assert.match(r1.receipt.reason, /no worker row exists for no-such-worker/);

  const r2 = cliSync(['worker', 'kill', 'w-dead'], dataDir);
  assert.strictEqual(r2.status, 1, `${r2.stdout} / ${r2.stderr}`);
  assert.strictEqual(r2.receipt.killed, false);
  assert.match(r2.receipt.reason, /is dead; nothing to kill/);

  const r3 = cliSync(['worker', 'kill', 'w-ghost'], dataDir);
  assert.strictEqual(r3.status, 1, `${r3.stdout} / ${r3.stderr}`);
  assert.strictEqual(r3.receipt.killed, false);
  assert.match(r3.receipt.reason, /claims starting but pid \d+ is dead; nothing to kill; the next run\.attach supersedes it/);

  const r4 = cliSync(['worker', 'kill', 'w-nopid'], dataDir);
  assert.strictEqual(r4.status, 1, `${r4.stdout} / ${r4.stderr}`);
  assert.strictEqual(r4.receipt.killed, false);
  assert.match(r4.receipt.reason, /carries no pid: a codex worker between turns has no process to kill/);

  assert.deepStrictEqual(listRecursive(dataDir), before, 'kill refusals must create nothing');
  assert.strictEqual(await ownChildCount(), nodesBefore, 'kill refusals must leave no process behind');
  cleanup(dir);
});

// ================================================================ worker rm, supersedes as forgotten

test('worker rm: supersedes a dead worker\'s rows as forgotten, hides them from worker.list and status.get, keeps worker.get and the disk, and names the leases it left', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const hung = hungChild();
  let leaseId;
  try {
    const plantCore = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-d', pid: process.pid } });
    try {
      await plantCore.worker.write({ id: 'w-dead2', substrate: 'claude-code', pid: hung.pid, state: 'starting', turns: 0, started_at: Date.now() });
      const t = await plantCore.task.create({ spec: 'left behind by a worker that will be forgotten' });
      const assign = await plantCore.task.assign({ task_id: t.id, worker_id: 'w-dead2' });
      leaseId = assign.new_lease.id;
      await killHung(hung);
      await plantCore.worker.write({ id: 'w-dead2', state: 'dead', exit_code: 0, exited_at: Date.now() });
    } finally {
      await plantCore.shutdownOwner();
      await plantCore.close();
    }

    const workerDir = `${dataDir}/workers/w-dead2`;
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(`${workerDir}/stream.jsonl`, '{"line":1}\n');

    const r = cliSync(['worker', 'rm', 'w-dead2'], dataDir);
    assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
    const rc = r.receipt;
    assert.strictEqual(rc.forgotten, true);
    assert.strictEqual(rc.row_after.state, 'forgotten');
    assert.strictEqual(rc.row_before.state, 'dead');
    assert.ok(rc.left.leases_unreleased.includes(leaseId), `left.leases_unreleased must name lease ${leaseId}: ${JSON.stringify(rc.left)}`);
    assert.strictEqual(rc.left.on_disk.exists, true);
    assert.ok(rc.left.on_disk.bytes > 0, 'the disk usage must be a real recursive size');
    assert.strictEqual(fs.existsSync(`${dataDir}/owner.lock`), false, 'rm must leave no owner.lock behind once it elected and finished');

    const checkCore = await openCore({ dataDir, caller: { role: 'operator', run_id: 'cli', pid: process.pid } });
    try {
      const listed = await checkCore.worker.list({});
      assert.ok(!listed.workers.some((w) => w.id === 'w-dead2'), 'worker.list must hide the forgotten row by default');
      const listedForgotten = await checkCore.worker.list({ states: ['forgotten'] });
      assert.ok(listedForgotten.workers.some((w) => w.id === 'w-dead2'), 'worker.list must show it once forgotten is named');
      const st = await checkCore.status.get({});
      assert.ok(!st.workers.some((w) => w.id === 'w-dead2'), 'status.get must hide the forgotten row too');
      const got = await checkCore.worker.get({ worker_id: 'w-dead2' });
      assert.strictEqual(got.state, 'forgotten', 'worker.get must still return the row');
    } finally {
      await checkCore.close();
    }
    assert.strictEqual(fs.existsSync(workerDir), true, 'rm must never remove workers/<id> from disk');
  } finally {
    await killHung(hung);
    cleanup(dir);
  }
});

// ================================================================ worker rm, refusals

test('worker rm: refuses a live pid, an unknown id and an already forgotten row', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const hung = hungChild();
  try {
    const plantCore = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-e', pid: process.pid } });
    try {
      await plantCore.worker.write({ id: 'w-live', substrate: 'claude-code', pid: hung.pid, state: 'starting', turns: 0, started_at: Date.now() });
      await plantCore.worker.write({ id: 'w-gone', substrate: 'claude-code', pid: deadPid(), pid_created: 1, state: 'dead', turns: 0, started_at: Date.now() });
    } finally {
      await plantCore.shutdownOwner();
      await plantCore.close();
    }

    const r1 = cliSync(['worker', 'rm', 'w-live'], dataDir);
    assert.strictEqual(r1.status, 1, `${r1.stdout} / ${r1.stderr}`);
    assert.strictEqual(r1.receipt.forgotten, false);
    assert.strictEqual(r1.receipt.error.code, 'E_WORKER_LIVE');
    assert.strictEqual(r1.receipt.error.detail.pid_alive, true);
    assert.match(r1.receipt.reason, /kill it first/);

    const r2 = cliSync(['worker', 'rm', 'no-such-worker'], dataDir);
    assert.strictEqual(r2.status, 1, `${r2.stdout} / ${r2.stderr}`);
    assert.strictEqual(r2.receipt.forgotten, false);
    assert.strictEqual(r2.receipt.error.code, 'E_NOT_FOUND');

    const r3 = cliSync(['worker', 'rm', 'w-gone'], dataDir);
    assert.strictEqual(r3.status, 0, `first rm of w-gone: ${r3.stdout} / ${r3.stderr}`);
    assert.strictEqual(r3.receipt.row_after.state, 'forgotten');

    const r4 = cliSync(['worker', 'rm', 'w-gone'], dataDir);
    assert.strictEqual(r4.status, 1, `second rm of w-gone must be refused: ${r4.stdout} / ${r4.stderr}`);
    assert.strictEqual(r4.receipt.forgotten, false);
    assert.strictEqual(r4.receipt.error.code, 'E_ARGS');
    assert.match(r4.receipt.error.message, /already forgotten/);
  } finally {
    await killHung(hung);
    cleanup(dir);
  }
});

// ================================================================ usage, and neither loads the embedder

test('worker kill and rm: usage errors list exactly kill and rm, and no CLI path to either loads the embedder', () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    const bare = cliSync(['worker'], dataDir);
    assert.strictEqual(bare.status, 2);
    assert.match(bare.stderr, /kill/);
    assert.match(bare.stderr, /rm/);
    // build step 6c, design item 5: the usage text now lists stop and restart too (owned by this
    // step, not 6b) — the two 6b-era negative assertions this replaced are superseded, not silently
    // dropped: tests/cli/worker-control.test.cjs's own usage test covers stop/restart's own presence.
    assert.match(bare.stderr, /\bstop\b/);
    assert.match(bare.stderr, /restart/);

    const badSub = cliSync(['worker', 'frobnicate', 'w1'], dataDir);
    assert.strictEqual(badSub.status, 2);
    assert.match(badSub.stderr, /kill/);
    assert.match(badSub.stderr, /rm/);

    const missingId = cliSync(['worker', 'kill'], dataDir);
    assert.strictEqual(missingId.status, 2);

    const extraArg = cliSync(['worker', 'kill', 'w1', 'w2'], dataDir);
    assert.strictEqual(extraArg.status, 2);
  } finally {
    cleanup(dir);
  }

  const probe = `
    require(${JSON.stringify(CLI)});
    require(${JSON.stringify(`${ROOT}/src/cli/cmd-worker.cjs`)});
    const hit = Object.keys(require.cache).filter(k => /src[\\\\/]core[\\\\/]embedder\\.cjs$/i.test(k));
    process.stdout.write(JSON.stringify(hit));
  `;
  const rProbe = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(rProbe.status, 0, `probe failed: ${rProbe.stderr}`);
  assert.deepStrictEqual(JSON.parse(rProbe.stdout), [], 'requiring the command module reached the embedder');

  const dir2 = sandbox();
  const dataDir2 = `${dir2}/.belay-cold`; // never created: both verbs fail before any core call needs it
  const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-worker-dump-'));
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
    for (const args of [['worker', 'kill', 'w1'], ['worker', 'rm', 'w1']]) {
      const dumpFile = path.join(dumpDir, `${args.join('-')}.json`);
      const before = listRecursive(dataDir2);
      const r = spawnSync(process.execPath, [CLI, ...args, '--data', dataDir2, '--json'], {
        cwd: ROOT, windowsHide: true, encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: `--require ${dumper}`, BELAY_CACHE_DUMP: dumpFile },
      });
      assert.strictEqual(r.status, 1, `${args.join(' ')}: ${r.stdout} / ${r.stderr}`);
      assert.deepStrictEqual(listRecursive(dataDir2), before, `${args.join(' ')} changed the data dir listing`);
      const cache = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
      const bad = cache.filter((k) => /embedder\.cjs$/i.test(k) || /@huggingface/i.test(k));
      assert.deepStrictEqual(bad, [], `${args.join(' ')} reached the embedder: ${bad.join(', ')}`);
    }
  } finally {
    fs.rmSync(dumpDir, { recursive: true, force: true });
    cleanup(dir2);
  }
});
