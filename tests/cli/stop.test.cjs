'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// stop.test.cjs — build step 5c, Done item 2, plus 5c-2's
// two additions. Drives the built CLI as subprocesses with tests/run/fakes/fake-claude.cjs as the
// orchestrator, with the scaffolding of tests/cli/run-wake.test.cjs (sandbox, makeSpec, runCli,
// receiptOf, waitForExit, connectOrchestratorCore, the store copy readers) — split into
// tests/cli/stop-helpers.cjs (5c-2) so this file stays under 500 lines — and every spawned or planted
// process killed by exact pid in a finally.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const P = require('../../src/run/process.cjs');
const { openCore } = require('../../src/core/index.cjs');
const {
  sleep, sandbox, cleanup, waitUntil, waitForFileLine, waitForExit, makeSpec, runCli, receiptOf,
  connectOrchestratorCore, currentRunRow, listRecursive, runStopSync, spawnStopAsync, releaseCore,
} = require('./stop-helpers.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;

// ================================================================ the tests

test('stop: a live run is stopped from a second process, the orchestrator exits gracefully, and the run closes its own row and its owner', { timeout: 180000 }, async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId } = makeSpec(dir, { startup_timeout_ms: 120000, close_grace_ms: 5000 });
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_HANG: '1' };
  const spawnedAt = Date.now();
  const runCliProc = runCli(specPath, dataDir, env);
  try {
    const row = await waitUntil(() => currentRunRow(dataDir, runId), 60000, 100);
    assert.ok(row, 'the run row never appeared');
    // Held well past close_grace_ms (5,000 ms) before the stop is even issued — deliberately, so this
    // assertion actually distinguishes "the stop's own close-then-kill took under 5,000 ms" from "the
    // run process happened to be under 5,000 ms old" (should-fix, reviewer round 1: with the prior bug,
    // ms_to_exit was facts.ms, the orchestrator's whole lifetime, so a hold this long alone reproduced
    // ms_to_exit ~6,000+ and turned the very assertion below red against otherwise-correct code).
    // This sleep is load-bearing, not a wait for an event: it is what makes the run older than the stop call, which the ms_to_exit check
    // below needs to tell the stop's own close time from the run's age. The check says so, loudly, when the stop call outlasted that age.
    await sleep(6000);

    const stopT0 = Date.now();
    const runAgeAtStop = stopT0 - spawnedAt;
    const stop = runStopSync(dataDir, runId);
    const stopCallMs = Date.now() - stopT0;
    assert.strictEqual(stop.status, 0, `stop: ${stop.stdout} / ${stop.stderr}`);
    const sr = stop.receipt;
    assert.ok(sr, 'stop produced no parseable receipt');
    assert.strictEqual(sr.stopped, true);
    assert.strictEqual(sr.run_id, runId);
    assert.strictEqual(sr.caller_pid, stop.pid);
    assert.deepStrictEqual(sr.workers, []);
    assert.strictEqual(sr.orchestrator.exit_code, 0);
    assert.strictEqual(sr.orchestrator.graceful, true);
    // A fact, not a clock: the stop's own close time cannot exceed the call that waited for it. A value that was the run's age instead
    // would be over the call's length only while the call was quicker than the run is old, so a slower call makes this check blind: fail loudly.
    assert.ok(stopCallMs < runAgeAtStop, `the stop call took ${stopCallMs} ms and the run was ${runAgeAtStop} ms old: the ms_to_exit check cannot tell the stop's close time from the run's age on this host right now; re-run (the exit speed itself is gated in tests/budgets/run-budgets.test.cjs)`);
    assert.ok(sr.orchestrator.ms_to_exit <= stopCallMs, `ms_to_exit ${sr.orchestrator.ms_to_exit} was over the ${stopCallMs} ms the stop call took: it is the stop's own close time, never the run's age`);
    assert.match(sr.established_by, /run\.stop over the owner pipe answered in \d+ ms/);

    const exited = await waitForExit(runCliProc.proc, 90000);
    assert.ok(exited, 'the CLI run did not exit within 90,000 ms of the stop');
    assert.strictEqual(exited.code, 0);
    const runReceipt = receiptOf(runCliProc, 0);
    assert.match(runReceipt.ended_by, /^stopped by belay stop \(caller pid \d+\); stdin closed$/);
    assert.strictEqual(sr.orchestrator.pid, runReceipt.orchestrator.pid);
    assert.strictEqual(runReceipt.stop.orchestrator.pid, runReceipt.orchestrator.pid);
    assert.match(runReceipt.store.ended.exit_reason, /stopped by belay stop/);

    const finalRow = currentRunRow(dataDir, runId);
    assert.ok(finalRow && finalRow.ended_at != null, 'the run row lacks ended_at');
    assert.match(finalRow.exit_reason, /stopped by belay stop/);
    assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'owner.lock is still present');
    assert.strictEqual(P.pidAlive(sr.orchestrator.pid), false, 'the orchestrator pid is still alive');
    assert.strictEqual(P.pidAlive(runCliProc.proc.pid), false, 'the run process pid is still alive');
  } finally {
    if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});

// 5c-2 Done item 1, first bullet (FINDINGS.json should-fix): stop.settled() at cmd-run.cjs:252 is
// load-bearing at the DEFAULT close_grace_ms (10,000 ms) — the one live-worker test above uses
// close_grace_ms 2000, which fits inside Owner.stop()'s own 5,000 ms drain, so a worker phase that
// actually outlasts that drain was never exercised. No close_grace_ms is passed here at all, so
// cmd-run.cjs's own default (10,000 ms, cmd-run.cjs's ARGS table) is what the stop and the run wait on.
test("stop: the run waits for the stop's worker phase before it ends the run, at the default grace", { timeout: 180000 }, async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId, orchestratorDir } = makeSpec(dir, { poll_ms: 300 });
  const holdsFile = `${dir}/holds.jsonl`;
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_GATE_FILE: `${dir}/answer.gate`, BELAY_TEST_HOLDS_FILE: holdsFile };
  const runCliProc = runCli(specPath, dataDir, env);
  let core = null;
  let plantedProc = null;
  try {
    core = await connectOrchestratorCore(dataDir, runId, runCliProc);

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
    fs.writeFileSync(`${dir}/answer.gate`, 'go'); // the orchestrator's first turn may end now: its worker is mid-turn, so the run stays open

    const streamPath = `${orchestratorDir}/stream.jsonl`;
    const gotResult = await waitForFileLine(streamPath, '"type":"result"', 60000);
    assert.ok(gotResult, "the orchestrator's own first turn never ended");
    assert.ok(await waitForFileLine(holdsFile, '"busy":["w1"]', 60000), 'the run never recorded w1 as busy');

    const stop = runStopSync(dataDir, runId);
    assert.strictEqual(stop.status, 0, `stop: ${stop.stdout} / ${stop.stderr}`);
    const sr = stop.receipt;
    assert.ok(sr, 'stop produced no parseable receipt');
    assert.strictEqual(sr.stopped, true);
    assert.strictEqual(sr.workers.length, 1, JSON.stringify(sr.workers));
    const w = sr.workers[0];
    assert.strictEqual(w.id, 'w1');
    assert.ok(w.killed, 'w1 was not reported killed');
    assert.strictEqual(w.killed.pid_alive_after, false);
    assert.ok(sr.worker_phase_ms >= 10000, `worker_phase_ms ${sr.worker_phase_ms} was not >= 10,000 (the default close_grace_ms)`);
    assert.strictEqual(P.pidAlive(plantedPid), false, 'the planted worker pid is still alive');

    const exited = await waitForExit(runCliProc.proc, 90000);
    assert.ok(exited, 'the CLI run did not exit within 90,000 ms of the stop');
    assert.strictEqual(exited.code, 0, `run exit ${exited.code}: ${runCliProc.stderr}`);
    const runReceipt = receiptOf(runCliProc, 0);
    assert.strictEqual(runReceipt.stop.workers[0].id, 'w1');
    assert.match(runReceipt.store.ended.exit_reason, /stopped by belay stop/);
    assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'owner.lock is still present');
  } finally {
    if (plantedProc && P.pidAlive(plantedProc.pid)) { try { require('../crash.cjs').crash(plantedProc); } catch { /* best effort */ } }
    await releaseCore(core);
    if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});

// The second call is made in this process, once the first stop is observably in flight (the orchestrator saw its stdin close), not
// by a second CLI process started on a timer: under load that process can reach the owner after the first stop has finished, which
// is the designed E_NOT_FOUND `ended` answer (the next test) and not an in-flight join. Exit codes and the orchestrator block are
// compared, not the two calls' wall clocks, which differ by whatever delay the second caller had.
test('stop: a second stop while the first is in flight gets the same receipt', { timeout: 180000 }, async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const stdinEnd = `${dir}/stdin-end.txt`;
  // The orchestrator ignores its stdin closing, so the first stop stays in flight for the whole close_grace_ms; that is far longer than the
  // one pipe round trip the second call needs (its operator core is opened before the first stop starts).
  const { specPath, runId } = makeSpec(dir, { close_grace_ms: 20000 });
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_IGNORE_STDIN_END: '1', FAKE_STDIN_END_FILE: stdinEnd };
  const runCliProc = runCli(specPath, dataDir, env);
  let op = null;
  try {
    const row = await waitUntil(() => currentRunRow(dataDir, runId), 60000, 100);
    assert.ok(row, 'the run row never appeared');
    await sleep(500); // no event shows the run's stop hook is installed (the fake hangs and writes nothing); the hook goes in once the spawn is confirmed, after the row
    op = await openCore({ dataDir, caller: { role: 'operator', run_id: runId, pid: process.pid } });

    const c1 = spawnStopAsync(dataDir, runId);
    assert.ok(await waitUntil(() => (fs.existsSync(stdinEnd) ? true : null), 30000, 20), 'the first stop never closed the orchestrator stdin');
    const second = await op.control('run.stop', { run_id: runId }, { timeoutMs: 60000 });
    const r1 = await c1;

    assert.strictEqual(r1.status, 0, `stop 1: ${r1.stdout} / ${r1.stderr}`);
    assert.ok(r1.receipt && second, 'one of the two stop receipts is missing');
    assert.strictEqual(r1.receipt.orchestrator.pid, second.orchestrator.pid);
    assert.strictEqual(r1.receipt.orchestrator.graceful, false);
    assert.strictEqual(second.orchestrator.graceful, false);
    assert.strictEqual(r1.receipt.orchestrator.exit_code, second.orchestrator.exit_code);
    assert.strictEqual(r1.receipt.orchestrator.ms_to_exit, second.orchestrator.ms_to_exit, 'the second call got the first stop\'s receipt');

    const exited = await waitForExit(runCliProc.proc, 90000);
    assert.ok(exited, 'the CLI run did not exit');
    assert.strictEqual(exited.code, 1);
    const runReceipt = receiptOf(runCliProc, 1);
    assert.strictEqual(runReceipt.orchestrator.killed_after_close, true);
  } finally {
    await releaseCore(op);
    if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});

// 5c-2 Done item 1, second bullet (FINDINGS.json finding 3): the inFlight/exited reorder made a second
// run.stop, arriving after the FIRST one had already completed, replay the first receipt (stopped:
// true, the first caller's caller_pid) instead of the E_NOT_FOUND phase 'ended' the design fixes. The
// planted live worker row stretches the whole stop (step (a)'s close_grace_ms bound plus the worker
// phase's own bound) to at least 3,000 + 3,000 ms, so the run process is still the owner when the
// second CLI call lands — though the exact instant it tears the owner down afterward is not itself
// bounded, so both outcomes the design permits are checked and the branch taken is logged.
test("stop: a stop after the run's stop completed is refused as ended, naming who stopped it", { timeout: 180000 }, async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId } = makeSpec(dir, { startup_timeout_ms: 120000, close_grace_ms: 3000 });
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_HANG: '1', FAKE_IGNORE_STDIN_END: '1' };
  const runCliProc = runCli(specPath, dataDir, env);
  let core = null;
  let plantedProc = null;
  try {
    const row = await waitUntil(() => currentRunRow(dataDir, runId), 60000, 100);
    assert.ok(row, 'the run row never appeared');

    core = await connectOrchestratorCore(dataDir, runId, runCliProc);
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

    const r1 = await spawnStopAsync(dataDir, runId);
    assert.strictEqual(r1.status, 0, `first stop: ${r1.stdout} / ${r1.stderr}`);
    assert.ok(r1.receipt && r1.receipt.stopped === true, `the first stop did not report stopped: true: ${JSON.stringify(r1.receipt)}`);

    const r2 = await spawnStopAsync(dataDir, runId); // not runStopSync: this process's connected client must keep serving while the second stop runs
    let branch;
    if (r2.status === 1 && r2.receipt && r2.receipt.error && r2.receipt.error.code === 'E_OWNER_LOST') {
      // The owner vouches for a stop caller by its process before it serves it (about a second, ADR 0045 decision 4), and the first
      // stop's teardown can land inside that window: the connection is closed with nothing served, and the run row says why.
      branch = 'the owner tore itself down while the second call was being vouched for';
      assert.strictEqual(typeof r2.receipt.error.detail.sent, 'boolean'); // sent or not, depending on whether the owner went away during the check or just before the call
      assert.ok(r2.receipt.last, 'the lost-owner branch carried no last row');
      assert.match(r2.receipt.last.exit_reason, /stopped by belay stop/);
    } else if (r2.status === 1 && r2.receipt && r2.receipt.error && r2.receipt.error.code === 'E_NOT_FOUND') {
      branch = 'the owner was still up: refused over the pipe';
      assert.strictEqual(r2.receipt.error.detail.phase, 'ended');
      assert.strictEqual(r2.receipt.error.detail.stopped_by.caller_pid, r1.pid);
    } else {
      // The owner was going away: whatever it was in the middle of (gone, or answering late, or a connection reset) is a refusal, and
      // the reason is the error's own, so the facts are the refusal and, when the run is already seen as ended, the row that says why.
      branch = `the owner was going away when the second call landed (${r2.receipt && r2.receipt.error ? r2.receipt.error.code : 'no error'})`;
      assert.strictEqual(r2.status, 1, `second stop: ${r2.stdout} / ${r2.stderr}`);
      // Only the codes of an owner going away are accepted here; any other code is a different failure and is named.
      const GOING_AWAY = ['E_NO_OWNER', 'E_TIMEOUT', 'ECONNRESET'];
      assert.ok(r2.receipt && r2.receipt.error && GOING_AWAY.includes(r2.receipt.error.code), `second stop failed with a code that is not an owner going away (${r2.receipt && r2.receipt.error ? r2.receipt.error.code : 'none'}): ${r2.stdout} / ${r2.stderr}`);
      if (/no live run/.test(r2.receipt.reason)) {
        assert.ok(r2.receipt.last, 'the no-live-run branch carried no last row');
        assert.match(r2.receipt.last.exit_reason, /stopped by belay stop/);
      }
    }
    console.log(`second-stop branch taken: ${branch}`);
    assert.notStrictEqual(r2.receipt && r2.receipt.stopped, true, 'the second stop replayed the first receipt as a success');

    const exited = await waitForExit(runCliProc.proc, 90000);
    assert.ok(exited, 'the CLI run did not exit');
  } finally {
    if (plantedProc && P.pidAlive(plantedProc.pid)) { try { require('../crash.cjs').crash(plantedProc); } catch { /* best effort */ } }
    await releaseCore(core);
    if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});

test('stop: with no live run it exits 1, names the last run\'s id and exit reason, creates nothing and starts nothing', { timeout: 180000 }, async () => {
  // (a) a data dir where a plain run already finished (exit 0).
  {
    const dir = sandbox();
    const dataDir = `${dir}/.belay`;
    const { specPath, runId } = makeSpec(dir);
    const runCliProc = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE });
    try {
      const exited = await waitForExit(runCliProc.proc, 90000);
      assert.ok(exited, 'the plain fake run never exited');
      assert.strictEqual(exited.code, 0);

      const before = listRecursive(dataDir);
      const t0 = Date.now();
      const r = runStopSync(dataDir, runId);
      const ms = Date.now() - t0;
      assert.strictEqual(r.status, 1, `stop: ${r.stdout} / ${r.stderr}`);
      assert.ok(r.receipt, 'stop produced no parseable receipt');
      assert.strictEqual(r.receipt.stopped, false);
      assert.match(r.receipt.reason, /no live run/);
      assert.ok(r.receipt.last, 'last is null');
      assert.strictEqual(r.receipt.last.id, runId);
      assert.ok(r.receipt.last.ended_at != null);
      assert.match(r.receipt.last.exit_reason, /stdin closed/);
      assert.deepStrictEqual(listRecursive(dataDir), before, 'stop changed the data dir');
      assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'owner.lock appeared');
      assert.ok(ms < 20000, `stop took ${ms} ms`); // a read; this only rules out a hang. An owner election is caught by the owner.lock and data-dir asserts above
    } finally {
      // 5c-2 fix (round-2 review, note): the exit wait above can fail (a loaded host past 15,000 ms)
      // and leave this run process, its orchestrator child and its owner.lock behind — every spawned
      // process is killed by exact pid in a finally, as the other tests here already do.
      if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
      cleanup(dir);
    }
  }

  // (b) a data dir that does not exist at all.
  {
    const dir = sandbox();
    const dataDir = `${dir}/.belay-absent`;
    const r = runStopSync(dataDir, 'no-such-run');
    assert.strictEqual(r.status, 1, `stop: ${r.stdout} / ${r.stderr}`);
    assert.ok(r.receipt, 'stop produced no parseable receipt');
    assert.strictEqual(r.receipt.stopped, false);
    assert.match(r.receipt.reason, /does not exist/);
    assert.strictEqual(r.receipt.last, null);
    assert.ok(!fs.existsSync(dataDir), 'the data dir was created');
    cleanup(dir);
  }

  // (c) no argument, and two arguments.
  {
    const dir = sandbox();
    const dataDir = `${dir}/.belay`;
    const r0 = spawnSync(process.execPath, [CLI, 'stop', '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    assert.strictEqual(r0.status, 2, `no-args: ${r0.stdout} / ${r0.stderr}`);
    assert.ok(!fs.existsSync(dataDir), 'a no-argument stop created a data dir');
    const r2 = spawnSync(process.execPath, [CLI, 'stop', 'a', 'b', '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    assert.strictEqual(r2.status, 2, `two-args: ${r2.stdout} / ${r2.stderr}`);
    assert.ok(!fs.existsSync(dataDir), 'a two-argument stop created a data dir');
    cleanup(dir);
  }
});

test('stop: a run stopped for a different run id is refused and stays alive', { timeout: 180000 }, async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId } = makeSpec(dir, { startup_timeout_ms: 120000, close_grace_ms: 5000 });
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_HANG: '1' };
  const runCliProc = runCli(specPath, dataDir, env);
  try {
    const row = await waitUntil(() => currentRunRow(dataDir, runId), 60000, 100);
    assert.ok(row, 'the run row never appeared');
    await sleep(500); // as above: no event shows the stop hook is installed; this stop is refused for its run id whatever the answer's timing, the sleep only keeps it off the before-spawn window

    const r = runStopSync(dataDir, 'a-different-run-id');
    assert.strictEqual(r.status, 1, `stop: ${r.stdout} / ${r.stderr}`);
    assert.ok(r.receipt, 'stop produced no parseable receipt');
    assert.strictEqual(r.receipt.error.code, 'E_NOT_FOUND');
    assert.ok(r.receipt.error.message.includes(runId), `error.message does not name the live run: ${r.receipt.error.message}`);
    if (r.receipt.last) assert.notStrictEqual(r.receipt.last.id, 'a-different-run-id');
    else assert.strictEqual(r.receipt.last, null);

    assert.ok(fs.existsSync(`${dataDir}/owner.lock`), 'owner.lock disappeared after a refused stop');
    const stillRow = currentRunRow(dataDir, runId);
    assert.strictEqual(stillRow.ended_at, null, 'the live run ended after a stop for a different id');
    assert.strictEqual(P.pidAlive(row.orchestrator_pid), true, 'the orchestrator died after a stop for a different id');

    const cleanupStop = runStopSync(dataDir, runId);
    assert.strictEqual(cleanupStop.status, 0, `cleanup stop: ${cleanupStop.stdout} / ${cleanupStop.stderr}`);
    const exited = await waitForExit(runCliProc.proc, 90000);
    assert.ok(exited, 'the CLI run did not exit after the cleanup stop');
  } finally {
    if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});

test('stop: a worker row of this run that is nobody\'s child is reported from its row plus a pid check and killed by exact pid after the bound', { timeout: 180000 }, async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId, orchestratorDir } = makeSpec(dir, { poll_ms: 300, close_grace_ms: 2000 });
  const holdsFile = `${dir}/holds.jsonl`;
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_GATE_FILE: `${dir}/answer.gate`, BELAY_TEST_HOLDS_FILE: holdsFile };
  const runCliProc = runCli(specPath, dataDir, env);
  let core = null;
  let plantedProc = null;
  try {
    core = await connectOrchestratorCore(dataDir, runId, runCliProc);

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
    fs.writeFileSync(`${dir}/answer.gate`, 'go'); // the orchestrator's first turn may end now: its worker is mid-turn, so the run stays open

    const streamPath = `${orchestratorDir}/stream.jsonl`;
    const gotResult = await waitForFileLine(streamPath, '"type":"result"', 60000);
    assert.ok(gotResult, "the orchestrator's own first turn never ended");
    assert.ok(await waitForFileLine(holdsFile, '"busy":["w1"]', 60000), 'the run never recorded w1 as busy');

    const stop = runStopSync(dataDir, runId);
    assert.strictEqual(stop.status, 0, `stop: ${stop.stdout} / ${stop.stderr}`);
    const sr = stop.receipt;
    assert.ok(sr, 'stop produced no parseable receipt');
    assert.strictEqual(sr.orchestrator.graceful, true);
    assert.strictEqual(sr.workers.length, 1, JSON.stringify(sr.workers));
    const w = sr.workers[0];
    assert.strictEqual(w.id, 'w1');
    assert.strictEqual(w.pid, plantedPid);
    assert.strictEqual(w.state, 'running');
    assert.strictEqual(w.pid_alive, true, 'w1 was not alive when its row was read');
    assert.ok(w.killed, 'w1 was not reported killed');
    assert.strictEqual(w.killed.pid_alive_after, false);
    assert.match(w.note, /past the 2000 ms bound; killed by exact pid/);
    assert.match(w.established_by, /worker\.list row seq \d+ at \d+ ms/);
    assert.ok(sr.worker_phase_ms >= 2000, `worker_phase_ms ${sr.worker_phase_ms} was not >= 2,000`);
    assert.strictEqual(P.pidAlive(plantedPid), false, 'the planted worker pid is still alive');

    const exited = await waitForExit(runCliProc.proc, 90000);
    assert.ok(exited, 'the CLI run did not exit');
    assert.strictEqual(exited.code, 0);
    const runReceipt = receiptOf(runCliProc, 0);
    assert.ok(
      runReceipt.holds.some((h) => Array.isArray(h.busy) && h.busy.length === 1 && h.busy[0] === 'w1'),
      JSON.stringify(runReceipt.holds)
    );
    assert.strictEqual(runReceipt.stop.workers[0].id, 'w1');
    assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'owner.lock is still present');
  } finally {
    if (plantedProc && P.pidAlive(plantedProc.pid)) { try { require('../crash.cjs').crash(plantedProc); } catch { /* best effort */ } }
    await releaseCore(core);
    if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});
