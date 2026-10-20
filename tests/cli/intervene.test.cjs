'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// intervene.test.cjs — build step 6a-2, done item 1.
// Drives the built CLI as subprocesses, in the scaffolding of tests/cli/stop.test.cjs and
// tests/cli/stop-helpers.cjs: a `belay run` with a FAKE_HANG=1 orchestrator is the live owner (the 5c
// shape), a test core connected as orchestrator over the pipe plants rows, and every core that elects
// is declared with `let` before the `try` and shut down in a `finally`; every spawned process killed by
// exact pid in a `finally`.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const P = require('../../src/run/process.cjs');
const {
  sandbox, cleanup, waitUntil, makeSpec, runCli, listRecursive, runStopSync, releaseCore,
} = require('./stop-helpers.cjs');
const { openCore } = require('../../src/core/index.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;

// A pid that is certainly dead by the time it is used: a child that has already exited, never a
// made-up number (pids are recycled and a guess can be alive).
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
  return r.pid;
}

// A pid that is certainly alive until killed and is not this test process's own: 6a-2's dead-pid
// refusal means a row a test wants actually assignable needs one. Killed by exact pid in the `finally`.
function hungChild() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
}

async function killHung(child) {
  if (!child || child.exitCode !== null) return;
  try { await P.killTree(child); } catch { /* best effort: belay stop may already have reaped it */ }
}

// Descendants of this test process, from the OS (src/run/process.cjs's childPids, the same query
// killTree verifies a subtree by). `cliSync` is synchronous, so a no-owner path that spawned and leaked
// a child would still be this process's own descendant when the count is taken right after the call
// returns. Scoped to this process's own subtree, unlike a system-wide node.exe count, so it stays
// truthful when other test files are spawning and killing node processes of their own at the same time.
// A snapshot's PowerShell is one of this process's children, so the count waits for the gate to be idle first (ADR 0048).
const { ownChildCount } = require('../helpers/own-children.cjs'); // children created at or after this process (a reused pid's orphans are not its own)

function cliSync(args, dataDir, extraEnv) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--data', dataDir, '--json'], {
    cwd: ROOT, windowsHide: true, encoding: 'utf8', env: { ...process.env, ...(extraEnv || {}) },
  });
  let receipt = null;
  try { receipt = JSON.parse(r.status === 0 ? r.stdout : r.stderr); } catch { /* left null */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, receipt };
}

// A test core connected as orchestrator over the pipe, to plant rows against the live belay-run owner
// (tests/cli/stop-helpers.cjs's connectOrchestratorCore waits for the run row; this is the same shape,
// kept local so no CLI-test file needs to reach into tests/core/helpers.cjs).
async function connectOrchestrator(dataDir, runId) {
  const core = await require('../helpers/bound-orchestrator.cjs').connectBoundOrchestrator(dataDir, runId, { waitMs: 15000 });
  const row = await waitUntil(async () => (await core.run.get()).run || null, 10000, 100);
  assert.ok(row, "the CLI's run row never appeared within 10,000 ms");
  return core;
}

// ================================================================ take-control, against a live owner

test('take-control: against a live owner, takes the lease of an assigned task from its worker, writes the operator\'s lease and a coherent task row, names both leases and the run; w1 has no adapter pipe of its own (nothing here ever created a RunManager for it), so the pause attempt fails at rung 4 and the lease still moves', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId } = makeSpec(dir, { startup_timeout_ms: 120000, close_grace_ms: 5000 });
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_HANG: '1' };
  const runCliProc = runCli(specPath, dataDir, env);
  let core = null;
  let w1 = null;
  try {
    core = await connectOrchestrator(dataDir, runId);
    // `starting` is live for task.assign (LIVE_WORKER_STATES), and 6a-2 also refuses a live-claiming row
    // over a dead pid — so this row needs a genuinely live pid, not this test process's own (`belay
    // stop`'s finally kills by exact pid any row still claiming a live state past the bound).
    w1 = hungChild();
    await core.worker.write({ id: 'w1', substrate: 'claude-code', pid: w1.pid, pid_image: 'node.exe', state: 'starting', turns: 0, started_at: Date.now() });
    const t = await core.task.create({ spec: 'a task assigned to w1, then taken over by the operator' });
    const assign = await core.task.assign({ task_id: t.id, worker_id: 'w1' });

    const r1 = cliSync(['take-control', t.id], dataDir);
    assert.strictEqual(r1.status, 1, `take-control: ${r1.stdout} / ${r1.stderr}`);
    const rc1 = r1.receipt;
    assert.ok(rc1, 'take-control produced no parseable receipt');
    assert.strictEqual(rc1.taken, true, 'the lease moves even though the pause failed');
    assert.strictEqual(rc1.task_id, t.id);
    // 6a-2, design item 1: the run named is the task's own run_id, read from the task row through
    // core.control, never an argument or a run.list "first alive run" guess.
    assert.strictEqual(rc1.run_id, t.run_id);
    assert.strictEqual(rc1.run_id_source, 'task row');
    assert.strictEqual(rc1.new_lease.run_id, t.run_id, 'the lease belongs to the task\'s run, never the CLI\'s own');
    assert.strictEqual(rc1.old_lease.id, assign.new_lease.id, 'the old lease named must be the worker\'s own lease');
    assert.strictEqual(rc1.new_lease.holder, 'operator');
    assert.strictEqual(rc1.new_lease.holder_role, 'operator');
    // ADR 0023 decision 9: w1 was never spawned by a RunManager whose adapter pipe listens anywhere in
    // this test, so the pause attempt's own ladder fails to connect (rung 4).
    assert.strictEqual(rc1.paused_worker.paused, false);
    assert.strictEqual(rc1.paused_worker.worker_id, 'w1');
    assert.strictEqual(rc1.paused_worker.ladder[3].rung, 4);
    assert.strictEqual(rc1.paused_worker.ladder[3].ok, false);
    assert.strictEqual(rc1.task.state, 'assigned');
    assert.match(rc1.established_by, /lease\.takeControl over the owner pipe answered in \d+ ms/);

    const after1 = await core.task.get({ task_id: t.id });
    assert.strictEqual(after1.lease.holder_role, 'operator');
    assert.strictEqual(after1.lease.id, rc1.new_lease.id);

    // Fix-round regression for the blocking finding: the displaced worker's own renew of its now-
    // superseded lease fails E_LEASE_EXPIRED, never E_NOT_HOLDER (methods-task.cjs's requireCurrentLease
    // runs before the holder check), matching what the note and the command table row now say.
    let displaced = null;
    try {
      // the run's owner serves bound callers (ADR 0045): w1 is a worker the way a launched one is, through a bind the run's orchestrator asks for
      const opened = await core.bindOpen({ role: 'worker', run_id: runId, worker_id: 'w1' });
      const claimed = await require('../../src/core/bind.cjs').claimBind(opened.pipe, { timeoutMs: 5000 });
      displaced = await openCore({ dataDir, caller: { ...claimed.caller, pid: process.pid }, key: claimed.key });
      await assert.rejects(
        displaced.lease.renew({ lease_id: assign.new_lease.id }),
        (e) => { assert.strictEqual(e.code, 'E_LEASE_EXPIRED', `the displaced worker's renew must be E_LEASE_EXPIRED, got ${e.code}`); return true; },
      );
    } finally {
      await releaseCore(displaced);
    }

    // A second take-control on the same task supersedes the operator's own lease (the core allows it)
    // and names it.
    const r2 = cliSync(['take-control', t.id], dataDir);
    assert.strictEqual(r2.status, 0, `second take-control: ${r2.stdout} / ${r2.stderr}`);
    assert.strictEqual(r2.receipt.taken, true);
    assert.strictEqual(r2.receipt.run_id_source, 'task row');
    assert.strictEqual(r2.receipt.old_lease.id, rc1.new_lease.id, 'the second call must name the first operator lease as superseded');
    assert.strictEqual(r2.receipt.new_lease.holder_role, 'operator');
    assert.notStrictEqual(r2.receipt.new_lease.id, rc1.new_lease.id);
  } finally {
    const stop = runStopSync(dataDir, runId);
    if (stop.status !== 0) process.emitWarning(`cleanup stop failed: ${stop.stdout} / ${stop.stderr}`);
    await releaseCore(core);
    if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
    await killHung(w1);
    cleanup(dir);
  }
});

// ================================================================ take-control, no live owner / unknown task

test('take-control: with no live owner exits 1 with E_NO_OWNER naming which fact was missing, creates nothing and starts nothing; an unknown task is E_NOT_FOUND', async () => {
  // (a) no owner.lock at all.
  {
    const dir = sandbox();
    const dataDir = `${dir}/.belay`;
    fs.mkdirSync(dataDir, { recursive: true });
    const before = listRecursive(dataDir);
    const nodesBefore = await ownChildCount();
    const r = cliSync(['take-control', 't1'], dataDir);
    assert.strictEqual(r.status, 1, `${r.stdout} / ${r.stderr}`);
    assert.strictEqual(r.receipt.taken, false);
    assert.strictEqual(r.receipt.error.code, 'E_NO_OWNER');
    assert.match(r.receipt.reason, /no live run/);
    // 6a-2 fix round: the receipt names an establisher that actually fired — 'none', never a leftover
    // 'argument' when no argument was ever the cause — and carries `last`, even if there is none to name.
    assert.strictEqual(r.receipt.run_id_source, 'none');
    assert.strictEqual(r.receipt.run_id, null);
    assert.strictEqual(r.receipt.last, null, 'an empty data dir has no run row to name as last');
    assert.deepStrictEqual(listRecursive(dataDir), before, 'take-control changed the data dir listing');
    assert.strictEqual(await ownChildCount(), nodesBefore, 'take-control left a node process behind');
    // spawnSync above is synchronous: the CLI process, and anything it might have spawned, has already
    // exited by the time it returns — the listing and node-count brackets are what actually show
    // nothing was created and no child was left running.
    cleanup(dir);
  }

  // (b) a lock naming a dead pid.
  {
    const dir = sandbox();
    const dataDir = `${dir}/.belay`;
    fs.mkdirSync(`${dataDir}/owner.lock`, { recursive: true });
    fs.writeFileSync(`${dataDir}/owner.lock/owner.json`, JSON.stringify({ pid: deadPid(), pipe: 'x', listening: true, acquired_at: Date.now() }));
    const before = listRecursive(dataDir);
    const nodesBefore = await ownChildCount();
    const r = cliSync(['task', 'assign', 't1', 'w1'], dataDir);
    assert.strictEqual(r.status, 1, `${r.stdout} / ${r.stderr}`);
    assert.strictEqual(r.receipt.error.code, 'E_NO_OWNER');
    assert.match(r.receipt.error.message, /is dead/);
    // Should-fix finding: task assign's own refusal receipt named no `reason` field on E_NO_OWNER,
    // unlike take-control's; reasonFor() was defined and never wired up. Now it is.
    assert.match(r.receipt.reason, /no live run/, 'task assign must name "no live run" on E_NO_OWNER, as take-control does');
    assert.strictEqual(r.receipt.run_id_source, 'none');
    assert.strictEqual(r.receipt.run_id, null);
    assert.strictEqual(r.receipt.last, null, 'no memory.db exists yet, so there is no run row to name as last');
    assert.deepStrictEqual(listRecursive(dataDir), before, 'task assign changed the data dir listing');
    assert.strictEqual(await ownChildCount(), nodesBefore, 'task assign left a node process behind');
    cleanup(dir);
  }

  // (c) a lock saying listening: false.
  {
    const dir = sandbox();
    const dataDir = `${dir}/.belay`;
    fs.mkdirSync(`${dataDir}/owner.lock`, { recursive: true });
    fs.writeFileSync(`${dataDir}/owner.lock/owner.json`, JSON.stringify({ pid: process.pid, pipe: 'x', listening: false, acquired_at: Date.now() }));
    const before = listRecursive(dataDir);
    const nodesBefore = await ownChildCount();
    const r = cliSync(['take-control', 't1'], dataDir);
    assert.strictEqual(r.status, 1, `${r.stdout} / ${r.stderr}`);
    assert.strictEqual(r.receipt.error.code, 'E_NO_OWNER');
    assert.match(r.receipt.error.message, /not listening yet/);
    assert.strictEqual(r.receipt.run_id_source, 'none');
    assert.ok('last' in r.receipt, 'the no-owner receipt must carry a last field, even if null');
    assert.deepStrictEqual(listRecursive(dataDir), before, 'take-control changed the data dir listing');
    assert.strictEqual(await ownChildCount(), nodesBefore, 'take-control left a node process behind');
    cleanup(dir);
  }

  // (d) an unknown task against a live owner is E_NOT_FOUND, not E_NO_OWNER.
  {
    const dir = sandbox();
    const dataDir = `${dir}/.belay`;
    const { specPath, runId } = makeSpec(dir, { startup_timeout_ms: 120000 });
    const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_HANG: '1' };
    const runCliProc = runCli(specPath, dataDir, env);
    let core = null;
    try {
      core = await connectOrchestrator(dataDir, runId);
      const before = listRecursive(dataDir);
      const r = cliSync(['take-control', 'no-such-task'], dataDir);
      assert.strictEqual(r.status, 1, `${r.stdout} / ${r.stderr}`);
      assert.strictEqual(r.receipt.taken, false);
      assert.strictEqual(r.receipt.error.code, 'E_NOT_FOUND');
      assert.match(r.receipt.error.message, /no-such-task/);
      assert.strictEqual(r.receipt.run_id, null, 'the task was never found, so no run was ever named');
      assert.strictEqual(r.receipt.run_id_source, 'none');
      assert.deepStrictEqual(listRecursive(dataDir).filter((p) => !p.startsWith('owner.lock')), before.filter((p) => !p.startsWith('owner.lock')),
        'an E_NOT_FOUND refusal must not touch anything beyond the already-live owner.lock');
    } finally {
      const stop = runStopSync(dataDir, runId);
      if (stop.status !== 0) process.emitWarning(`cleanup stop failed: ${stop.stdout} / ${stop.stderr}`);
      await releaseCore(core);
      if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
      cleanup(dir);
    }
  }
});

// ================================================================ task assign, against a live owner

test('task assign: as the operator, assigns an open task to a live worker over the pipe and returns the rows; a task whose dependency is open is refused E_DEPENDENCY_OPEN naming the blocker; a worker whose pid is dead is refused E_WORKER_NOT_LIVE; a task the operator holds is refused E_OPERATOR_HOLDS until released', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId } = makeSpec(dir, { startup_timeout_ms: 120000 });
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_HANG: '1' };
  const runCliProc = runCli(specPath, dataDir, env);
  let core = null;
  let w1 = null;
  try {
    core = await connectOrchestrator(dataDir, runId);
    // 6a-2, design item 1: task.assign now refuses a live-claiming row over a dead pid, so the row this
    // test wants actually assigned needs a genuinely live pid — not this test process's own, because the
    // `belay stop` in the finally kills by exact pid any row still claiming a live state past the bound.
    w1 = hungChild();
    await core.worker.write({ id: 'w1', substrate: 'claude-code', pid: w1.pid, pid_image: 'node.exe', state: 'starting', turns: 0, started_at: Date.now() });
    await core.worker.write({ id: 'w-dead', substrate: 'claude-code', pid: deadPid(), pid_created: 1, state: 'dead', turns: 0, started_at: Date.now() });
    // The dead-pid refusal itself: a row still claiming a live state word (`starting`) whose pid has
    // already exited. LIVE_WORKER_STATES alone would call this assignable; pidAlive must not.
    await core.worker.write({ id: 'w-ghost', substrate: 'claude-code', pid: deadPid(), pid_created: 1, state: 'starting', turns: 0, started_at: Date.now() });

    const t1 = await core.task.create({ spec: 'assigned to the live worker w1' });
    const a1 = cliSync(['task', 'assign', t1.id, 'w1'], dataDir);
    assert.strictEqual(a1.status, 0, `${a1.stdout} / ${a1.stderr}`);
    assert.strictEqual(a1.receipt.assigned, true);
    assert.strictEqual(a1.receipt.task.id, t1.id);
    assert.strictEqual(a1.receipt.task.state, 'assigned');
    assert.strictEqual(a1.receipt.new_lease.holder, 'w1');
    assert.strictEqual(a1.receipt.new_lease.holder_role, 'worker');
    assert.strictEqual(a1.receipt.old_lease, null);
    assert.strictEqual(a1.receipt.paused_worker, null);
    // 6a-2, design item 1: the run named, and the lease's own run_id, are the task's, never the CLI's.
    assert.strictEqual(a1.receipt.run_id, t1.run_id);
    assert.strictEqual(a1.receipt.run_id_source, 'task row');
    assert.strictEqual(a1.receipt.new_lease.run_id, t1.run_id);
    assert.strictEqual((await core.task.get({ task_id: t1.id })).written_by, 'operator');

    const t2 = await core.task.create({ spec: 'depends on t1, which is assigned, not done', depends_on: [t1.id] });
    const a2 = cliSync(['task', 'assign', t2.id, 'w1'], dataDir);
    assert.strictEqual(a2.status, 1, `${a2.stdout} / ${a2.stderr}`);
    assert.strictEqual(a2.receipt.assigned, false);
    assert.strictEqual(a2.receipt.error.code, 'E_DEPENDENCY_OPEN');
    assert.strictEqual(a2.receipt.error.detail.blocked_by, t1.id);

    const t3 = await core.task.create({ spec: 'assigned to a worker whose row claims dead' });
    const a3 = cliSync(['task', 'assign', t3.id, 'w-dead'], dataDir);
    assert.strictEqual(a3.status, 1, `${a3.stdout} / ${a3.stderr}`);
    assert.strictEqual(a3.receipt.error.code, 'E_WORKER_NOT_LIVE');

    // The FINDINGS.json note this closes: a `starting` row over a dead pid decided assignable from the
    // state word alone. Liveness is derived, never self-reported (invariant 4).
    const t3b = await core.task.create({ spec: 'assigned to a worker whose row claims starting but whose pid is dead' });
    const a3b = cliSync(['task', 'assign', t3b.id, 'w-ghost'], dataDir);
    assert.strictEqual(a3b.status, 1, `${a3b.stdout} / ${a3b.stderr}`);
    assert.strictEqual(a3b.receipt.error.code, 'E_WORKER_NOT_LIVE');
    assert.strictEqual(a3b.receipt.error.detail.pid_alive, false, 'the refusal must name pid_alive false, not just the state word');
    assert.strictEqual(a3b.receipt.error.detail.worker_id, 'w-ghost');
    assert.strictEqual((await core.task.get({ task_id: t3b.id })).state, 'open', 'a refused assign must not have written the task row');

    const t4 = await core.task.create({ spec: 'the operator takes this one before anyone is assigned' });
    const took = cliSync(['take-control', t4.id], dataDir);
    assert.strictEqual(took.status, 0, `take-control: ${took.stdout} / ${took.stderr}`);
    assert.strictEqual(took.receipt.new_lease.holder_role, 'operator');
    const a4 = cliSync(['task', 'assign', t4.id, 'w1'], dataDir);
    assert.strictEqual(a4.status, 1, `${a4.stdout} / ${a4.stderr}`);
    assert.strictEqual(a4.receipt.error.code, 'E_OPERATOR_HOLDS');
    assert.strictEqual(a4.receipt.error.detail.task_id, t4.id);

    // usage: a bare `task` and an unknown subcommand are usage errors before anything is opened.
    const usageNone = cliSync(['task'], dataDir);
    assert.strictEqual(usageNone.status, 2);
    const usageBad = cliSync(['task', 'frobnicate', t4.id, 'w1'], dataDir);
    assert.strictEqual(usageBad.status, 2);
    assert.match(usageBad.stderr, /assign/);
    // --run is no longer a recognised option on either verb (6a-2, design item 2).
    const usageRun = cliSync(['take-control', t4.id, '--run', 'anything'], dataDir);
    assert.strictEqual(usageRun.status, 2);
    assert.match(usageRun.stderr, /unknown option --run/);
  } finally {
    const stop = runStopSync(dataDir, runId);
    if (stop.status !== 0) process.emitWarning(`cleanup stop failed: ${stop.stdout} / ${stop.stderr}`);
    await releaseCore(core);
    if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
    await killHung(w1);
    cleanup(dir);
  }
});

// ================================================================ a lease belongs to its task's run

test('take-control and task assign: the lease is stamped with the task\'s run, never the CLI\'s, and with no alive run row a take-control against a live owner still names the task\'s run', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId } = makeSpec(dir, { startup_timeout_ms: 120000 });
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_HANG: '1' };
  const runCliProc = runCli(specPath, dataDir, env);
  let core = null;
  try {
    core = await connectOrchestrator(dataDir, runId);
    const t = await core.task.create({ spec: 'belongs to a run row that will be marked ended while its owner process stays up' });
    // run.list's own `alive` flag goes false for this run (ended_at set), but the owner process behind
    // the pipe is untouched: take-control must still find the run from the task row itself, never from
    // "the first alive run" (the second review's blocking finding this closes).
    await core.run.end({ exit_reason: 'ended for this test; the belay run process itself keeps running' });

    const r = cliSync(['take-control', t.id], dataDir);
    assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
    const rc = r.receipt;
    assert.strictEqual(rc.taken, true);
    assert.strictEqual(rc.new_lease.run_id, t.run_id, 'the new lease must be stamped with the task\'s run, not caller.run_id (\'cli\')');
    assert.strictEqual(rc.run_id, t.run_id);
    assert.strictEqual(rc.run_id_source, 'task row');

    const diff = await core.store.diff({ since_ms: 0, run_id: t.run_id });
    const leaseIds = [...diff.tables.lease.added, ...diff.tables.lease.updated].map((l) => l.id);
    assert.ok(leaseIds.includes(rc.new_lease.id), `store.diff for run ${t.run_id} must list the new lease; got ${JSON.stringify(diff.tables.lease)}`);
  } finally {
    const stop = runStopSync(dataDir, runId);
    if (stop.status !== 0) process.emitWarning(`cleanup stop failed: ${stop.stdout} / ${stop.stderr}`);
    await releaseCore(core);
    if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});

// ================================================================ neither loads the embedder

test('take-control and task assign: no CLI path to either loads the embedder', () => {
  const probe = `
    require(${JSON.stringify(CLI)});
    require(${JSON.stringify(`${ROOT}/src/cli/cmd-take-control.cjs`)});
    require(${JSON.stringify(`${ROOT}/src/cli/cmd-task.cjs`)});
    const hit = Object.keys(require.cache).filter(k => /src[\\\\/]core[\\\\/]embedder\\.cjs$/i.test(k));
    process.stdout.write(JSON.stringify(hit));
  `;
  const rProbe = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(rProbe.status, 0, `probe failed: ${rProbe.stderr}`);
  assert.deepStrictEqual(JSON.parse(rProbe.stdout), [], 'requiring the command modules reached the embedder');

  const dir = sandbox();
  const dataDir = `${dir}/.belay-cold`; // never created: both commands fail E_NO_OWNER against it
  const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-intervene-dump-'));
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
    for (const args of [['take-control', 't1'], ['task', 'assign', 't1', 'w1']]) {
      const dumpFile = path.join(dumpDir, `${args.join('-')}.json`);
      const beforeListing = listRecursive(dataDir);
      const r = spawnSync(process.execPath, [CLI, ...args, '--data', dataDir, '--json'], {
        cwd: ROOT, windowsHide: true, encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: `--require ${dumper}`, BELAY_CACHE_DUMP: dumpFile },
      });
      assert.strictEqual(r.status, 1, `${args.join(' ')}: ${r.stdout} / ${r.stderr}`);
      assert.deepStrictEqual(listRecursive(dataDir), beforeListing, `${args.join(' ')} changed the data dir listing`);
      const cache = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
      const bad = cache.filter((k) => /embedder\.cjs$/i.test(k) || /@huggingface/i.test(k));
      assert.deepStrictEqual(bad, [], `${args.join(' ')} reached the embedder: ${bad.join(', ')}`);
    }
  } finally {
    fs.rmSync(dumpDir, { recursive: true, force: true });
    cleanup(dir);
  }
});
