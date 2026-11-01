'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm
// stop-tree-kill.test.cjs — a `belay stop` of a run whose orchestrator ignores its closed stdin. After close_grace_ms the run
// kills the orchestrator's whole tree, and a worker under it (the orchestrator adapter's child, here a plain child of the fake)
// dies in that kill before any exit handler runs. The stop receipt and the worker's row must say the tree kill ended it:
// not "nothing wrote its exit", and not the run-end time as the moment it exited. Driven through the built CLI with the fake
// executable: FAKE_IGNORE_STDIN_END keeps the orchestrator up, FAKE_SPAWN_SCRIPT starts the worker as its child.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const P = require('../../src/run/process.cjs');
const {
  sandbox, cleanup, waitUntil, waitForExit, makeSpec, runCli, receiptOf, connectOrchestratorCore,
  readStoreCopy, runStopSync, releaseCore,
} = require('./stop-helpers.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const SLEEPER = `${ROOT}/tests/run/fakes/helper-sleeper.cjs`;

test('stop: a worker ended by the orchestrator tree kill is attributed to it in the receipt and its row', { timeout: 180000 }, async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const pidFile = `${dir}/worker.pid`;
  const { specPath, runId } = makeSpec(dir, { startup_timeout_ms: 120000, close_grace_ms: 1500 });
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_HANG: '1', FAKE_IGNORE_STDIN_END: '1', FAKE_SPAWN_SCRIPT: SLEEPER, FAKE_HELPER_PIDFILE: pidFile };
  const runCliProc = runCli(specPath, dataDir, env);
  let core = null;
  let workerPid = null;
  try {
    core = await connectOrchestratorCore(dataDir, runId, runCliProc);
    workerPid = Number(await waitUntil(() => { try { return fs.readFileSync(pidFile, 'utf8') || null; } catch { return null; } }, 60000, 50));
    assert.ok(Number.isInteger(workerPid) && P.pidAlive(workerPid), 'the fake orchestrator never started its worker');
    const workerWt = `${dir}/w1-wt`;
    fs.mkdirSync(workerWt, { recursive: true });
    await core.worker.write({
      id: 'w1', substrate: 'claude-code', pid: workerPid, pid_image: 'node.exe', state: 'running',
      turns: 0, mid_turn: 1, started_at: Date.now(), worktree: workerWt,
    });

    const stop = runStopSync(dataDir, runId);
    assert.strictEqual(stop.status, 0, `stop: ${stop.stdout} / ${stop.stderr}`);
    const sr = stop.receipt;
    assert.strictEqual(sr.orchestrator.graceful, false, 'the orchestrator was expected to ignore its closed stdin and be killed');
    assert.strictEqual(sr.workers.length, 1, JSON.stringify(sr.workers));
    const w = sr.workers[0];
    assert.strictEqual(w.pid, workerPid);
    assert.strictEqual(w.pid_alive, false);
    assert.ok(w.killed && /orchestrator's tree kill/.test(w.killed.by), `the receipt does not attribute the death to the tree kill: ${JSON.stringify(w)}`);
    assert.strictEqual(w.killed.pid, workerPid);
    assert.doesNotMatch(w.note, /nothing wrote its exit$/, w.note);

    const exited = await waitForExit(runCliProc.proc, 90000);
    assert.ok(exited, 'the CLI run did not exit');
    assert.strictEqual(exited.code, 1);
    const kill = receiptOf(runCliProc, 1).orchestrator.kill;
    assert.ok(kill && Number.isSafeInteger(kill.signalled_at), `the run receipt carries no kill: ${JSON.stringify(kill)}`);
    assert.ok(kill.killed_processes.some((p) => p.pid === workerPid), `the kill's snapshot did not name the worker: ${JSON.stringify(kill)}`);
    assert.strictEqual(w.killed.signalled_at, kill.signalled_at);

    const row = readStoreCopy(dataDir, (db) => db.prepare('SELECT * FROM worker WHERE id = ? ORDER BY seq DESC LIMIT 1').get('w1'));
    assert.strictEqual(row.state, 'dead');
    assert.strictEqual(row.exited_at, kill.signalled_at, 'the row\'s exit time is not the tree kill\'s signal time');
    assert.match(row.death_established_by, /orchestrator's process tree that belay killed at/, row.death_established_by);
  } finally {
    await releaseCore(core);
    if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});
