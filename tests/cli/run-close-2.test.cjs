'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// run-close-2.test.cjs — ADR 0029 amendment 1 items 2 to 4: the adapter wait bound, a pid still alive after
// its kill, a close that could not look, and the spec's mcp_tool_timeout_ms. The kill mechanics are injected
// into closeRunWorkers for the still-alive path; the exit-1 chaining is driven through the real CLI.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const H = require('./stop-helpers.cjs');
const P = require('../../src/run/process.cjs');
const { closeRunWorkers } = require('../../src/cli/run-close.cjs');

const { ROOT, CLI, sandbox, cleanup, makeSpec, runCli, receiptOf, waitForExit, listRecursive } = H;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const FAKE_CORE_GET_REJECTS = `${ROOT}/tests/cli/fakes/core-get-rejects.cjs`;

const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
const stub = (adapterPid, workers) => ({
  run: { get: async () => ({ run: { adapter_pid: adapterPid } }) },
  worker: { list: async () => ({ workers }) },
});
const row = (id, pid, extra = {}) => ({ id, run_id: 'r1', substrate: 'claude-code', state: 'running', pid, ...extra });

test('run close: a pid still alive after its kill is named in still_alive (kill mechanics injected)', async () => {
  const w = sleeper();
  try {
    const calls = [];
    const deps = {
      killProcess: async (target) => { calls.push(['proc', target.pid, target.created, target.image]); return { tree: { killed: [w.pid], terminated: 1 }, pidKill: { signalled: false, error: 'ESRCH' }, identity: null, refused: null }; }, // a tree kill ends the root, so the root's own pidKill is ESRCH
      waitPidGone: async () => null,
    };
    const out = await closeRunWorkers({ core: stub(process.pid, [row('w1', w.pid)]), runId: 'r1', graceMs: 100, deps });
    assert.strictEqual(out.killed[0].signalled, true, 'the tree kill signalled the root');
    assert.deepStrictEqual(out.still_alive.map((x) => ({ worker_id: x.worker_id, pid: x.pid, outcome: x.outcome })), [{ worker_id: 'w1', pid: w.pid, outcome: 'signalled_still_alive' }]);
    assert.match(out.still_alive[0].manual, /belay worker kill w1/);
    assert.strictEqual(out.killed[0].gone, false);
    assert.deepStrictEqual(calls, [['proc', w.pid, null, ['claude.exe']]], 'killed through the row identity (ADR 0039): its pid, no creation time recorded, the substrate images');
  } finally { if (P.pidAlive(w.pid)) require('../crash.cjs').crash(w); }
});

test('run close: the adapter wait bound is the larger of close_grace_ms and N x (10 s + T) + (5 s + T), T the snapshot timeout, and is recorded', async () => {
  const T = require('../../src/core/proc-identity.cjs').SNAPSHOT_TIMEOUT_MS;
  const adapter = sleeper();
  const a = sleeper();
  const b = sleeper();
  const idleCodex = sleeper();
  try {
    const seen = [];
    const deps = { waitPidGone: async (pid, o) => { if (pid === adapter.pid) { seen.push(o.timeoutMs); return null; } return 1; }, killProcess: async () => ({ tree: null, pidKill: { signalled: false } }) };
    const workers = [row('w1', a.pid), row('w2', b.pid), row('cx', idleCodex.pid, { substrate: 'codex', state: 'idle' }), row('w-dead', 999999999), row('w-stopped', a.pid, { state: 'stopped' })];
    let out = await closeRunWorkers({ core: stub(adapter.pid, workers), runId: 'r1', graceMs: 10000, deps });
    assert.strictEqual(out.adapter_wait_bound_ms, Math.max(10000, 2 * (10000 + T) + 5000 + T), 'two live Claude Code rows; the Codex idle row and the stopped row do not count');
    assert.strictEqual(out.adapter_gone, false);
    out = await closeRunWorkers({ core: stub(adapter.pid, workers), runId: 'r1', graceMs: 60000, deps });
    assert.strictEqual(out.adapter_wait_bound_ms, Math.max(60000, 2 * (10000 + T) + 5000 + T));
    out = await closeRunWorkers({ core: stub(adapter.pid, []), runId: 'r1', graceMs: 1000, deps });
    assert.strictEqual(out.adapter_wait_bound_ms, Math.max(1000, 5000 + T), 'no live worker: the 5,000 ms slack plus one snapshot');
    assert.deepStrictEqual(seen, [Math.max(10000, 2 * (10000 + T) + 5000 + T), Math.max(60000, 2 * (10000 + T) + 5000 + T), Math.max(1000, 5000 + T)], 'the wait itself used the recorded bound');
  } finally { for (const c of [adapter, a, b, idleCodex]) if (P.pidAlive(c.pid)) require('../crash.cjs').crash(c); }
});

test('run close: the adapter wait adds no review drain: the own bound on applying verdicts is in-process', async () => {
  const T = require('../../src/core/proc-identity.cjs').SNAPSHOT_TIMEOUT_MS;
  const adapter = sleeper();
  const a = sleeper();
  try {
    const seen = [];
    const deps = { waitPidGone: async (pid, o) => { if (pid === adapter.pid) { seen.push(o.timeoutMs); return null; } return 1; }, killProcess: async () => ({ tree: null, pidKill: { signalled: false } }) };
    const out = await closeRunWorkers({ core: stub(adapter.pid, [row('w1', a.pid)]), runId: 'r1', graceMs: 1000, deps, noteReview: true });
    assert.strictEqual(out.adapter_wait_bound_ms, 1 * (10000 + T) + 5000 + T, 'a stray noteReview argument adds nothing');
    assert.deepStrictEqual(seen, [out.adapter_wait_bound_ms]);
  } finally { for (const c of [adapter, a]) if (P.pidAlive(c.pid)) require('../crash.cjs').crash(c); }
});

// A fast-close stage kill (stage-job.cjs: manager.stop kill) sends a signal in this process. If it lands after the close's own
// SIGHUP snapshot started, that snapshot is stale for the worker close: it must re-take, or refuse, and never signal on it.
test('run close (fast): a signal that lands after the close snapshot started makes it re-take; one that keeps landing refuses, and nothing is signalled on a stale snapshot', async () => {
  const ID = require('../../src/core/proc-identity.cjs');
  const CP = require('../../src/core/process.cjs');
  const w = sleeper();
  try {
    const snapOf = (pid) => new Map([[pid, { ppid: 1, created: 5, image: 'node.exe' }]]);
    for (const keepLanding of [false, true]) {
      const sent = []; let takes = 0;
      const fast = {
        requested: () => false, leftMs: () => 60000,
        snapshot: async () => {
          takes++;
          const startSeq = ID.gate.stamp();
          if (keepLanding || takes === 1) ID.gate.signal(); // the stage kill's signal, after this snapshot started
          return { snap: snapOf(w.pid), startSeq, error: null };
        },
      };
      const deps = { killProcess: (t, o) => CP.killProcess(t, { ...o, kill: (pid) => { sent.push(pid); } }), waitPidGone: async () => 0 };
      const out = await closeRunWorkers({ core: stub(process.pid, [row('w1', w.pid, { pid_created: 5, pid_image: 'node.exe' })]), runId: 'r1', graceMs: 100, deps, fast });
      const e = out.killed[0];
      if (!keepLanding) {
        assert.strictEqual(takes, 2, 'the first snapshot was stale, so the close took one more');
        assert.deepStrictEqual(sent, [w.pid], 'signalled once, on the fresh snapshot');
        assert.strictEqual(e.refused, undefined, JSON.stringify(e));
      } else {
        assert.strictEqual(takes, 2, 'one re-take, then it gives up');
        assert.deepStrictEqual(sent, [], 'nothing signalled on a stale snapshot');
        assert.strictEqual(e.signalled, false);
        assert.strictEqual(e.kind, 'unverifiable', JSON.stringify(e));
        assert.strictEqual(e.outcome, 'refused_unverifiable');
        assert.match(e.detail, /signals in this process kept landing after each snapshot started/);
        assert.match(e.manual, /belay worker kill w1/);
      }
    }
  } finally { if (P.pidAlive(w.pid)) require('../crash.cjs').crash(w); }
});

test('run close: a Codex idle row with a live pid is never killed', async () => {
  const c = sleeper();
  try {
    const out = await closeRunWorkers({ core: stub(process.pid, [row('cx', c.pid, { substrate: 'codex', state: 'idle' })]), runId: 'r1', graceMs: 100 });
    assert.deepStrictEqual(out.killed, []);
    assert.ok(P.pidAlive(c.pid));
  } finally { if (P.pidAlive(c.pid)) require('../crash.cjs').crash(c); }
});

test('run close: a read that fails is named in errors and nothing is killed', async () => {
  const w = sleeper();
  try {
    const bad = { run: { get: async () => { throw new Error('boom-run'); } }, worker: { list: async () => { throw new Error('boom-list'); } } };
    const out = await closeRunWorkers({ core: bad, runId: 'r1', graceMs: 100 });
    assert.strictEqual(out.errors.length, 3, 'run.get once and worker.list twice');
    assert.match(out.errors.join(' '), /run\.get: boom-run/);
    assert.match(out.errors.join(' '), /worker\.list: boom-list/);
    assert.deepStrictEqual(out.killed, []);
  } finally { if (P.pidAlive(w.pid)) require('../crash.cjs').crash(w); }
});

test('run close: belay run exits 1 and names it when the close could not read the run', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath } = makeSpec(dir);
  const run = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE, BELAY_FAKE_CORE: FAKE_CORE_GET_REJECTS });
  try {
    const exited = await waitForExit(run.proc, 30000);
    assert.ok(exited, 'the CLI did not exit');
    assert.strictEqual(exited.code, 1, `stdout: ${run.stdout}, stderr: ${run.stderr}`);
    const receipt = receiptOf(run, 1);
    assert.match(receipt.ended_by, /stdin closed; then worker close: could not look at the run's workers/);
    assert.match(receipt.ended_by, /run\.get: .*PROBE/);
    assert.ok(receipt.workers_closed.errors.length >= 1);
    assert.ok(receipt.store.ended, 'the run still ended');
  } finally {
    if (run.proc.exitCode === null) { try { await P.killTree(run.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});

test('run: mcp_tool_timeout_ms must be a positive integer, refused at spec validation with no process and no file', () => {
  for (const bad of [1.5, 0, 120000.5, '12e3x']) {
    const dir = sandbox();
    try {
      fs.mkdirSync(`${dir}/wt`);
      fs.writeFileSync(`${dir}/prompt.txt`, 'hi\n');
      const specPath = `${dir}/spec.json`;
      fs.writeFileSync(specPath, JSON.stringify({ worktree: `${dir}/wt`, prompt_file: `${dir}/prompt.txt`, mcp_tool_timeout_ms: bad }));
      const before = listRecursive(dir);
      const r = spawnSync(process.execPath, [CLI, 'run', specPath], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 20000 });
      assert.strictEqual(r.status, 2, `${JSON.stringify(bad)}: expected exit 2, got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /^belay run: mcp_tool_timeout_ms must be (a positive integer|a non-negative number)/);
      assert.deepStrictEqual(listRecursive(dir), before, 'a usage error left files behind');
    } finally { cleanup(dir); }
  }
  const dir = sandbox();
  try { // a positive integer is accepted past validation (the spec then fails later only for its missing store, not for the key)
    fs.mkdirSync(`${dir}/wt`);
    fs.writeFileSync(`${dir}/prompt.txt`, 'hi\n');
    const specPath = `${dir}/spec.json`;
    fs.writeFileSync(specPath, JSON.stringify({ on_embedder_failure: 'continue', worktree: `${dir}/wt`, prompt_file: `${dir}/prompt.txt`, mcp_tool_timeout_ms: 30000, startup_timeout_ms: 1000, orchestrator_dir: `${dir}/orch` }));
    const r = spawnSync(process.execPath, [CLI, 'run', specPath, '--data', `${dir}/.belay`], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, BELAY_CLAUDE_EXE: `${ROOT}/tests/run/fakes/fake-claude-noready.cjs` } });
    assert.doesNotMatch(r.stderr, /mcp_tool_timeout_ms/);
  } finally { cleanup(dir); }
});
