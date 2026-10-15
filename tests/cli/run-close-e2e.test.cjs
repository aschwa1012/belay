'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// run-close-e2e.test.cjs — ADR 0029 and its amendment 1 against the REAL belay-mcp orchestrator adapter.
// A fake orchestrator (tests/cli/fakes/fake-orch-adapter.cjs) spawns the adapter detached and spawns a
// worker through its worker_spawn tool. Kill mode terminates the adapter 350 ms after the orchestrator
// exits, as Claude Code does (measured): the adapter's own `stopping` row is then closed by run.end, with
// the worker's head. Graceful mode lets the adapter finish its shutdown: no kill, and no row lands after
// run.end. Every process is stopped by exact pid in a finally. Stores are under the OS temp dir.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const H = require('./stop-helpers.cjs');
const P = require('../../src/run/process.cjs');

const { ROOT, sandbox, cleanup, makeSpec, runCli, receiptOf, waitForExit, readStoreCopy } = H;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const FAKE_ORCH = `${ROOT}/tests/cli/fakes/fake-orch-adapter.cjs`;

async function driveReal(mode, closeGraceMs) {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, wt } = makeSpec(dir, { close_grace_ms: closeGraceMs });
  const git = (...a) => spawnSync('git', a, { cwd: wt, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(git('init', '-q').status, 0);
  assert.strictEqual(git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--allow-empty', '-q', '-m', 'x').status, 0);
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const out = `${dir}/e2e.jsonl`;
  const run = runCli(specPath, dataDir, {
    BELAY_CLAUDE_EXE: FAKE_ORCH, E2E_FAKE_CLAUDE: FAKE_CLAUDE, E2E_OUT: out, E2E_WT: wt,
    E2E_KILL_ADAPTER: mode === 'kill' ? '1' : '', E2E_WORKER_IGNORE_END: '1', FAKE_ANSWER_DELAY_MS: '4000',
    // ADR 0048 decision 8 (b): this test asserts a product budget that includes a kill snapshot by definition (the adapter's
    // stop: 10,000 ms of grace for the worker, then the kill, inside the 15,000 ms the run waits). An injected stall would
    // test the stall, so these processes run with the seam off even when the suite runs with it on.
    BELAY_TEST_SNAPSHOT_STALL_MS: '',
  });
  const pids = new Set([run.proc.pid]);
  const created = new Map(); // pid -> the creation time its own store row recorded (ADR 0039); none, no signal
  const sweep = () => {
    const lines = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    for (const l of lines) if (l.adapter_pid) pids.add(l.adapter_pid);
    try {
      const rows = readStoreCopy(dataDir, (db) => db.prepare('SELECT pid, pid_created FROM worker').all());
      for (const r of rows || []) if (r.pid) { pids.add(r.pid); if (r.pid_created) created.set(r.pid, r.pid_created); }
      const runs = readStoreCopy(dataDir, (db) => db.prepare('SELECT adapter_pid, adapter_pid_created FROM run').all());
      for (const r of runs || []) if (r.adapter_pid_created) created.set(r.adapter_pid, r.adapter_pid_created);
    } catch { /* no store yet */ }
    return lines;
  };
  return { dir, dataDir, run, head, out, pids, created, sweep };
}

async function finish(ctx) {
  ctx.sweep();
  require('../crash.cjs').crash(ctx.run.proc); // the live handle
  for (const pid of ctx.pids) if (pid !== ctx.run.proc.pid) require('../crash.cjs').crash(pid, ctx.created.get(pid)); // a row's own creation time, or no signal
  cleanup(ctx.dir);
}

const workerRows = (dataDir) => readStoreCopy(dataDir, (db) => db.prepare('SELECT seq, state, pid, written_by, written_at, exited_at, head_sha, death_established_by FROM worker WHERE id = ? ORDER BY seq').all('w-real'));
const runRows = (dataDir) => readStoreCopy(dataDir, (db) => db.prepare('SELECT seq, adapter_pid, ended_at FROM run ORDER BY seq').all());

test('run close e2e: the real adapter terminated 350 ms after the orchestrator exits leaves stopping, and run.end closes it with the head', async () => {
  const ctx = await driveReal('kill', 15000);
  try {
    const exited = await waitForExit(ctx.run.proc, 90000);
    assert.ok(exited, `belay run did not exit; stderr: ${ctx.run.stderr.slice(-1500)}`);
    const lines = ctx.sweep();
    const receipt = receiptOf(ctx.run, exited.code);
    assert.strictEqual(exited.code, 0, `exit ${exited.code}; ended_by: ${receipt.ended_by}`);
    const adapterPid = lines.find((l) => l.ev === 'adapter-spawned').adapter_pid;
    const rows = workerRows(ctx.dataDir);
    const last = rows[rows.length - 1];
    const prior = rows[rows.length - 2];
    assert.strictEqual(prior.state, 'stopping', 'the adapter wrote stopping and was terminated before the exit row');
    assert.strictEqual(prior.written_by, 'orchestrator');
    assert.strictEqual(last.state, 'dead');
    assert.strictEqual(last.written_by, 'operator', 'the closing row is belay run\'s, not the adapter\'s');
    assert.strictEqual(last.death_established_by, `run.end: pid ${last.pid} not alive when the run ended; no adapter wrote its exit (ADR 0029)`);
    assert.strictEqual(last.head_sha, ctx.head);
    assert.ok(Number.isInteger(last.exited_at));
    const wc = receipt.workers_closed;
    assert.strictEqual(wc.adapter_pid, adapterPid);
    assert.strictEqual(wc.adapter_gone, true);
    assert.strictEqual(wc.adapter_wait_bound_ms, 15000);
    // The worker dies with the adapter through the host's ambient job binding when the machine is quiet
    // (killed: []), and survives it under load, in which case decision 4 kills it by its exact pid. Both
    // happened in review runs; either way the row ends marked by run.end.
    assert.ok(wc.killed.length <= 1, JSON.stringify(wc.killed));
    for (const k of wc.killed) assert.deepStrictEqual({ worker_id: k.worker_id, pid: k.pid, gone: k.gone }, { worker_id: 'w-real', pid: last.pid, gone: true }); // ADR 0039: a kill also names its identity
    assert.strictEqual(wc.marked_dead.length, 1);
    assert.strictEqual(wc.marked_dead[0].worker_id, 'w-real');
    assert.strictEqual(wc.marked_dead[0].from_state, 'stopping');
    assert.strictEqual(wc.marked_dead[0].head_sha, ctx.head);
    assert.ok(!P.pidAlive(adapterPid) && !P.pidAlive(last.pid), 'no adapter or worker process survives the run');
    const rr = runRows(ctx.dataDir);
    assert.ok(rr[rr.length - 1].ended_at != null);
  } finally { await finish(ctx); }
});

test('run close e2e: a graceful adapter at the default close_grace_ms is waited for, nothing is killed and nothing is written after run.end', async () => {
  const ctx = await driveReal('graceful', 10000);
  try {
    const exited = await waitForExit(ctx.run.proc, 120000);
    assert.ok(exited, `belay run did not exit; stderr: ${ctx.run.stderr.slice(-1500)}`);
    ctx.sweep();
    const receipt = receiptOf(ctx.run, exited.code);
    assert.strictEqual(exited.code, 0, `exit ${exited.code}; ended_by: ${receipt.ended_by}`);
    const wc = receipt.workers_closed;
    assert.strictEqual(wc.adapter_gone, true, 'the adapter finished its own shutdown inside the bound');
    assert.strictEqual(wc.adapter_wait_bound_ms, 15000, 'one live worker: 1 x 10,000 + 5,000 beats the 10,000 default');
    assert.deepStrictEqual(wc.killed, []);
    assert.deepStrictEqual(wc.marked_dead, []);
    const rows = workerRows(ctx.dataDir);
    // ADR 0029 amendment 2 item 4: the adapter's graceful shutdown lands its own head follow-up, so the
    // last row is the adapter's stopped row carrying the worktree head and run.end filled nothing.
    const last = rows[rows.length - 1];
    assert.strictEqual(last.state, 'stopped', 'the adapter\'s own exit row is the last row');
    assert.strictEqual(last.written_by, 'orchestrator');
    assert.strictEqual(last.head_sha, ctx.head, 'the adapter wrote the head itself');
    // Amendment 2 item 3: the adapter's shutdown does not stop belay run's owner, so run.end ran once:
    // belay run's attach, the adapter's epoch, and exactly one ended row.
    const rr = runRows(ctx.dataDir);
    assert.strictEqual(rr.length, 3, JSON.stringify(rr));
    assert.strictEqual(rr.filter((r) => r.ended_at != null).length, 1, 'a single ended run row');
    const ended = receipt.store.ended.ended_at;
    assert.ok(last.written_at <= ended + 250, 'the adapter\'s row landed before run.end, not after (two processes, a quarter second of slack)');
    assert.ok(!rows.some((r) => r.death_established_by && /^run\.end/.test(r.death_established_by)), 'run.end closed nothing');
    assert.ok(![...ctx.pids].some((p) => p !== ctx.run.proc.pid && P.pidAlive(p)), 'no adapter or worker process survives the run');
  } finally { await finish(ctx); }
});
