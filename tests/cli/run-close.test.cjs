'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// run-close.test.cjs — ADR 0029 decisions 1, 3 and 4 through the built CLI: `belay run` waits for the
// orchestrator's adapter to be gone, stops a worker still alive by its exact pid, and ends the run with the
// workers' rows closed. S8's shape: a worker row left `stopping` over a dead pid with its adapter gone and
// nobody having written the exit. The adapter and the worker are stand-in processes the test spawned and
// writes rows for through a core, as tests/cli/run.test.cjs does; the real adapter's cut-off shutdown is
// the S8 receipt, not this file. Every store is under the OS temp dir.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const H = require('./stop-helpers.cjs');
const P = require('../../src/run/process.cjs');

const { ROOT, sleep, sandbox, cleanup, waitUntil, waitForFileLine, waitForExit, makeSpec, runCli, receiptOf, connectOrchestratorCore, readStoreCopy, releaseCore, currentRunRow } = H;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const SHA_RE = /^[0-9a-f]{40,64}$/;

function gitInit(dir) {
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(git('init', '-q').status, 0);
  assert.strictEqual(git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--allow-empty', '-q', '-m', 'x').status, 0);
  const head = git('rev-parse', 'HEAD').stdout.trim();
  assert.match(head, SHA_RE);
  return head;
}

function sleeper(ms) {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { windowsHide: true, stdio: 'ignore' });
  const exitAt = new Promise((r) => child.once('exit', () => r(Date.now())));
  return { child, pid: child.pid, exitAt };
}

function workerRow(dataDir, id) {
  return readStoreCopy(dataDir, (db) => db.prepare('SELECT * FROM worker WHERE id = ? ORDER BY seq DESC LIMIT 1').get(id) || null);
}

function runRowCount(dataDir, runId) {
  return readStoreCopy(dataDir, (db) => db.prepare('SELECT COUNT(*) AS n FROM run WHERE id = ?').get(runId).n);
}

function workerRowCount(dataDir, id) {
  return readStoreCopy(dataDir, (db) => db.prepare('SELECT COUNT(*) AS n FROM worker WHERE id = ?').get(id).n);
}

const killIfAlive = (handle) => { if (handle) require('../crash.cjs').crash(handle); }; // ADR 0039: the live handle, never a bare pid

async function s8Scenario({ stallSetupMs = 0 }) { // checks run before the sandbox goes
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, wt, runId, orchestratorDir } = makeSpec(dir, { close_grace_ms: 60000 }); // never the factor: the adapter's death is what the run waits for
  const head = gitInit(wt);
  // The orchestrator's turn ends when the test says so (the gate file), never when a timer happens to fire: the
  // adapter must be attached and the rows written before the turn ends, and a slow setup must not change that.
  const gate = `${dir}/answer.gate`;
  const run = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_GATE_FILE: gate });
  let core = null;
  let adapter = null;
  let worker = null;
  try {
    core = await connectOrchestratorCore(dataDir, runId);
    if (stallSetupMs) await sleep(stallSetupMs); // fault injection: the setup calls arrive late, as on a saturated host
    // The orchestrator's adapter: a process whose pid is the run row's adapter_pid, alive for a while yet.
    adapter = sleeper(30000);
    await core.run.attach({ adapter_pid: adapter.pid });
    worker = sleeper(60000);
    const t = Date.now();
    await core.worker.write({ id: 'w-s8', run_id: runId, substrate: 'claude-code', pid: worker.pid, pid_image: 'node.exe', state: 'running', worktree: wt, turns: 0, started_at: t });
    await core.worker.write({ id: 'w-s8', state: 'stopping' });
    const seqBefore = workerRowCount(dataDir, 'w-s8');
    fs.writeFileSync(gate, 'go'); // setup is complete: now the orchestrator's turn may end

    assert.ok(await waitForFileLine(`${orchestratorDir}/stream.jsonl`, '"type":"result"', 120000), 'the orchestrator turn never ended');
    // The shutdown is cut off: the worker is gone, and no final row will be written.
    require('../crash.cjs').crash(worker.child);
    // When the adapter's kill was issued, taken in this process at the call. Its own 'exit' event is not
    // a death time: on a saturated host the event reached the test seconds after the pid was gone
    // (w2-flakes/exit-lag-32.txt), so comparing the run's clock with the event's flaked.
    let adapterKilledAt = null;
    setTimeout(() => { adapterKilledAt = Date.now(); require('../crash.cjs').crash(adapter.child); }, 2500).unref();

    const exited = await waitForExit(run.proc, 120000);
    assert.ok(exited, `belay run did not exit; stderr: ${run.stderr.slice(-1500)}`);
    let giveUp = null; // the losing timer of the race is cleared, or it keeps the test process alive 60 s past the scenario
    const adapterExitAt = await Promise.race([adapter.exitAt, new Promise((r) => { giveUp = setTimeout(() => r(null), 60000); })]);
    clearTimeout(giveUp);
    assert.ok(adapterExitAt && adapterKilledAt, 'the stand-in adapter was never killed');
    const receipt = receiptOf(run, exited.code);

    checkS8({ exited, receipt, adapter, worker, adapterKilledAt, head, seqBefore, dataDir, orchestratorDir });
  } finally {
    await releaseCore(core);
    killIfAlive(worker && worker.child); killIfAlive(adapter && adapter.child);
    if (run.proc.exitCode === null) { try { await P.killTree(run.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
}

function checkS8(r) {
  const { exited, receipt, adapter, worker, adapterKilledAt, head, seqBefore, dataDir, orchestratorDir } = r;
  assert.strictEqual(exited.code, 0, `exit ${exited.code}; ended_by: ${receipt.ended_by}`);
  const wc = receipt.workers_closed;
  assert.ok(wc, 'the receipt carries workers_closed');
  assert.strictEqual(wc.adapter_pid, adapter.pid);
  assert.strictEqual(wc.adapter_gone, true);
  assert.deepStrictEqual(wc.killed, []);
  assert.strictEqual(wc.marked_dead.length, 1);
  assert.strictEqual(wc.marked_dead[0].worker_id, 'w-s8');
  assert.strictEqual(wc.marked_dead[0].from_state, 'stopping');
  assert.strictEqual(wc.marked_dead[0].head_sha, head);
  // run.end waited for the adapter: the run closed no earlier than the kill that ended it was issued
  // (clocks of two processes, so a quarter second of slack). A run that did not wait ends before it.
  assert.ok(receipt.store.ended.ended_at >= adapterKilledAt - 250, `run.end ran ${adapterKilledAt - receipt.store.ended.ended_at} ms before the adapter was killed`);

  const w = workerRow(dataDir, 'w-s8');
  assert.strictEqual(w.state, 'dead');
  assert.strictEqual(w.death_established_by, `run.end: pid ${worker.pid} not alive when the run ended; no adapter wrote its exit (ADR 0029)`);
  assert.strictEqual(w.head_sha, head);
  assert.ok(Number.isInteger(w.exited_at));
  assert.strictEqual(w.exit_code, null);
  assert.strictEqual(workerRowCount(dataDir, 'w-s8'), seqBefore + 1, 'exactly one row was appended');
  assert.ok(!fs.existsSync(`${dataDir}/owner.lock`));
  assert.match(fs.readFileSync(`${orchestratorDir}/run.json`, 'utf8'), /"workers_closed"/);
}

test('run close: a worker row left stopping over a dead pid, its adapter gone, is closed by the run (S8 shape)', async () => {
  await s8Scenario({});
});

// The suspected race (ADR 0051): the S8 shape failed once under load. The cause is the test's setup racing the
// orchestrator's turn, not the product: a timer ended the turn 5 s after spawn, and a setup slower than that
// attached the adapter after the run had already read its row. Gated, the same stalled setup gives the S8 result.
test('run close: a setup stalled past any timer still gives the S8 result when the test gates the turn end', async () => {
  await s8Scenario({ stallSetupMs: 4000 });
});

// The interleaving itself, forced: the adapter's first core call (its attach) is in flight while the orchestrator's turn
// ends. The run closes at once, with no adapter registered: the product promises a wait only for the adapter the run row
// names when the close reads it. The late attach must then be refused (ADR 0029 amendment 4, proposed): before, it
// reopened the run as epoch 2 with ended_at null and made the late caller the store owner, so `status` reported a run
// that had ended as never ended. This is also what the old 5 s timer made possible on a saturated host, and why the
// turn end is gated above.
test('run close: a setup slower than the orchestrator turn finds the run closed, the adapter never waited for', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId } = makeSpec(dir, { close_grace_ms: 60000 });
  const run = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_DELAY_MS: '300' });
  let core = null;
  let adapter = null;
  try {
    core = await connectOrchestratorCore(dataDir, runId);
    adapter = sleeper(30000);
    const exited = await waitForExit(run.proc, 120000); // the stall: the run runs to its end before the setup's first call
    assert.ok(exited, `belay run did not exit; stderr: ${run.stderr.slice(-1500)}`);
    const endedBefore = currentRunRow(dataDir, runId);
    assert.ok(endedBefore && endedBefore.ended_at != null, 'the run row is ended before the late attach');
    const rowsBefore = runRowCount(dataDir, runId);
    await assert.rejects(core.run.attach({ adapter_pid: adapter.pid }), (e) => e.code === 'E_ARGS' && /already ended/.test(e.message), 'a late attach after run.end is refused');
    const after = currentRunRow(dataDir, runId);
    assert.strictEqual(after.seq, endedBefore.seq, 'the refused attach wrote no row');
    assert.strictEqual(runRowCount(dataDir, runId), rowsBefore);
    assert.notStrictEqual(after.ended_at, null, 'the run is still ended');
    assert.notStrictEqual(after.adapter_pid, adapter.pid);
    const receipt = receiptOf(run, exited.code);
    assert.strictEqual(exited.code, 0);
    assert.notStrictEqual(receipt.workers_closed.adapter_pid, adapter.pid);
    assert.ok(P.pidAlive(adapter.pid), 'the run touched a process it never owned');
  } finally {
    await releaseCore(core);
    killIfAlive(adapter && adapter.child);
    if (run.proc.exitCode === null) { try { await P.killTree(run.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});

test('run close: a worker pid still alive when the run ends is killed by its exact pid, then marked', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, wt, runId } = makeSpec(dir, { close_grace_ms: 3000 });
  const head = gitInit(wt);
  const run = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_DELAY_MS: '4000' });
  let core = null;
  let worker = null;
  let bystander = null;
  try {
    core = await connectOrchestratorCore(dataDir, runId);
    worker = sleeper(120000);
    bystander = sleeper(120000); // a live process of the test's own: nothing may touch it
    // A running worker with no turn owed does not hold the idle close (orchestrator.cjs), so the run ends
    // around it with its pid alive.
    await core.worker.write({ id: 'w-live', run_id: runId, substrate: 'claude-code', pid: worker.pid, pid_image: 'node.exe', state: 'running', worktree: wt, turns: 1, mid_turn: 0, started_at: Date.now() });

    const exited = await waitForExit(run.proc, 120000);
    assert.ok(exited, `belay run did not exit; stderr: ${run.stderr.slice(-1500)}`);
    const receipt = receiptOf(run, exited.code);
    assert.strictEqual(exited.code, 0, `exit ${exited.code}; ended_by: ${receipt.ended_by}`);
    assert.ok(!P.pidAlive(worker.pid), 'the surviving worker pid is still alive after the run');
    assert.ok(P.pidAlive(bystander.pid), 'a process the run never owned was killed');
    const wc = receipt.workers_closed;
    assert.strictEqual(wc.killed.length, 1);
    assert.strictEqual(wc.killed[0].worker_id, 'w-live');
    assert.strictEqual(wc.killed[0].pid, worker.pid);
    assert.strictEqual(wc.killed[0].gone, true);
    assert.strictEqual(wc.marked_dead.length, 1);
    assert.strictEqual(wc.marked_dead[0].from_state, 'running');
    assert.strictEqual(wc.marked_dead[0].head_sha, head);
    const w = workerRow(dataDir, 'w-live');
    assert.strictEqual(w.state, 'dead');
    assert.match(w.death_established_by, /^run\.end: pid \d+ not alive when the run ended/);
    assert.strictEqual(w.head_sha, head);
    assert.ok(await waitUntil(() => !P.pidAlive(run.proc.pid), 5000, 50));
  } finally {
    await releaseCore(core);
    killIfAlive(worker && worker.child); killIfAlive(bystander && bystander.child);
    if (run.proc.exitCode === null) { try { await P.killTree(run.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});
