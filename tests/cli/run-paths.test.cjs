'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// run-paths.test.cjs — build step 5a-2: the five named
// tests of its "Done, executable" §2, closing review 2's findings on `belay run`. Driven as a
// subprocess exactly as tests/cli/run.test.cjs drives every case, with BELAY_CLAUDE_EXE standing in
// for the orchestrator. Every assertion is about a derived fact, never about what the fake said.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const { openCore } = require('../../src/core/index.cjs');
const P = require('../../src/run/process.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;

// ---------------------------------------------------------------- scaffolding (as run.test.cjs)

const fwd = (p) => String(p).split(path.sep).join('/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sandbox() { return fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-paths-'))); }

function cleanup(dir) {
  for (let i = 0; i < 5; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { process.emitWarning(`sandbox left behind at ${dir}: ${e.code || e.message}`); }
}

async function waitUntil(fn, timeoutMs, stepMs = 100) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 >= timeoutMs) return null;
    await sleep(stepMs);
  }
}

function waitForFileLine(filePath, needle, timeoutMs) {
  return waitUntil(() => {
    let text = '';
    try { text = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
    return text.includes(needle) ? true : null;
  }, timeoutMs, 100);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

// Copy `memory.db` and its sidecars, then read the copy (invariant 6): never a read-only open of the
// live file.
function readCurrentRunRow(dataDir, runId) {
  const src = `${dataDir}/memory.db`;
  if (!fs.existsSync(src)) return null;
  const tmp = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-paths-copy-')));
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(src + suffix)) fs.copyFileSync(src + suffix, `${tmp}/memory.db${suffix}`);
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(`${tmp}/memory.db`);
    try {
      const rows = db.prepare('SELECT * FROM run WHERE id = ? ORDER BY seq DESC LIMIT 1').all(runId);
      return rows[0] || null;
    } finally { db.close(); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// makeSpec, runCli and receiptOf are stop-helpers.cjs's own (same shapes; the spec names on_embedder_failure: 'continue').
const { makeSpec, runCli, receiptOf } = require('./stop-helpers.cjs');

// ================================================================ the tests

test('run: a second run on a data dir another run owns is refused before any write, and the first run\'s row stays open', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId, orchestratorDir } = makeSpec(dir);
  const envA = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_DELAY_MS: '8000', FAKE_SESSION_ID: 'fake-session-paths-a' };

  const runA = runCli(specPath, dataDir, envA);
  let testCore = null;
  let runB = null;
  try {
    testCore = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
    const row = await waitUntil(async () => {
      const got = await testCore.run.get();
      return got.run || null;
    }, 10000, 100);
    assert.ok(row, "run A's row never appeared within 10,000 ms");
    assert.strictEqual(row.adapter_pid, runA.proc.pid, "run A's adapter_pid must be its own CLI pid");

    // Run B: the same spec file, the same --data, started while A still owns the data dir.
    const tB0 = Date.now();
    runB = runCli(specPath, dataDir, envA);
    const exitedB = await waitForExit(runB.proc, 5000);
    assert.ok(exitedB, 'run B did not exit within 5,000 ms');
    assert.strictEqual(exitedB.code, 1, `run B exited ${exitedB.code}, stdout: ${runB.stdout}, stderr: ${runB.stderr}`);
    assert.ok(Date.now() - tB0 < 5000, 'run B took too long to exit');

    const receiptB = receiptOf(runB, 1);
    assert.strictEqual(receiptB.store.attach, null, 'a refused run must not have opened an epoch');
    assert.strictEqual(receiptB.store.ended, null, 'a refused run must not have closed anything');
    assert.strictEqual(receiptB.store.owner_pid, runA.proc.pid, "the refusal must name A's pid as the owner");
    assert.match(receiptB.ended_by, /owner/);
    assert.strictEqual(receiptB.orchestrator.pid, null, 'a refused run never spawned anything');
    assert.ok(!fs.existsSync(`${orchestratorDir}/run.json`), 'a refused run must not have written a receipt file');

    // Through the read-only core: A's row is unaffected, and status.get's run-alive rung still holds.
    const stillOpen = await testCore.run.get();
    assert.strictEqual(stillOpen.run.ended_at, null, "A's row must still be open after B's refusal");
    assert.strictEqual(stillOpen.run.adapter_pid, runA.proc.pid);
    const status = await testCore.status.get();
    const runAlive = status.rungs.find((r) => r.rung === 'run-alive');
    assert.ok(runAlive && runAlive.established, `run-alive rung not established: ${JSON.stringify(runAlive)}`);

    const exitedA = await waitForExit(runA.proc, 15000);
    assert.ok(exitedA, "run A did not exit within 15,000 ms of B's refusal");
    assert.strictEqual(exitedA.code, 0, `run A exited ${exitedA.code}, stderr: ${runA.stderr.slice(-2000)}`);
    assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'owner.lock is still present after A exited');
  } finally {
    await require('./stop-helpers.cjs').releaseCore(testCore);
    // 5a-3 item 6: a failing assertion between B's spawn and here must not leave B (or the orchestrator
    // it never got to spawn) alive — kill both by exact pid, tree first, when either is still alive.
    if (runA.proc.exitCode === null) { try { await P.killTree(runA.proc); } catch { /* best effort */ } }
    if (runB && runB.proc.exitCode === null) { try { await P.killTree(runB.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});

test('run: two turn ends in one chunk start one poll chain, holds are moments, and polls are counted', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, wt, runId, orchestratorDir } = makeSpec(dir, { poll_ms: 300 });
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_DELAY_MS: '6000', FAKE_EXTRA_INIT: '1' };

  const runCliProc = runCli(specPath, dataDir, env);
  let testCore = null;
  let fakeWorker = null;
  try {
    testCore = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
    await waitUntil(async () => (await testCore.run.get()).run || null, 10000, 100);

    fakeWorker = spawn(process.execPath, [FAKE_CLAUDE], {
      cwd: wt, env: { ...process.env, FAKE_HANG: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    await testCore.worker.write({
      id: 'w-hold', run_id: runId, substrate: 'claude-code', pid: fakeWorker.pid, pid_image: 'node.exe',
      state: 'running', turns: 0, started_at: Date.now(),
    });

    const streamPath = `${orchestratorDir}/stream.jsonl`;
    const gotResult = await waitForFileLine(streamPath, '"type":"result"', 15000);
    assert.ok(gotResult, `stream.jsonl at ${streamPath} never held a result line within 15,000 ms`);

    await sleep(1500);
    require('../crash.cjs').crash(fakeWorker);

    const exited = await waitForExit(runCliProc.proc, 10000);
    assert.ok(exited, 'the CLI did not exit within 10,000 ms of the fake worker being killed');
    assert.strictEqual(exited.code, 0, `the CLI exited ${exited.code}, stderr: ${runCliProc.stderr.slice(-2000)}`);

    const receipt = receiptOf(runCliProc, 0);
    assert.strictEqual(receipt.orchestrator.turns, 2, 'two result lines must count as two turns');
    assert.strictEqual(receipt.orchestrator.externally_triggered_turns, 1, 'exactly one turn was never written to stdin by this run');
    // 5b-4: killing the pid with no detector row ever landing for it is now a second, distinct hold
    // moment (the pending death, cleared only once DEATH_GRACE_MS elapses) — still moments, not ticks.
    assert.strictEqual(receipt.holds.length, 2, `holds must record two moments: ${JSON.stringify(receipt.holds)}`);
    assert.strictEqual(receipt.holds[0].turn, 1, "the hold must name the turn whose end caused it, not turn 2's chunk-mate");
    assert.deepStrictEqual(receipt.holds[0].busy, ['w-hold']);
    assert.deepStrictEqual(receipt.holds[1].busy, []);
    assert.deepStrictEqual(receipt.holds[1].pending_deaths, ['w-hold']);
    assert.strictEqual(receipt.holds[1].established_by, "worker.list; pid dead, awaiting the detector's row");
    assert.ok(Number.isInteger(receipt.polls) && receipt.polls >= 15 && receipt.polls <= 45, `polls out of [15,45] (build step 6h item 7: init now arrives at once, so polls run the fake's own 6,000 ms answer delay at poll_ms 300, not the old delayed burst; measured 31-32): ${receipt.polls}`);
  } finally {
    await require('./stop-helpers.cjs').releaseCore(testCore);
    if (fakeWorker && P.pidAlive(fakeWorker.pid)) require('../crash.cjs').crash(fakeWorker);
    if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});

test('run: the orchestrator that ignores a closed stdin is killed after close_grace_ms, and the run says so', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, orchestratorDir } = makeSpec(dir, { close_grace_ms: 1500 });
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_IGNORE_STDIN_END: '1' };

  const t0 = Date.now();
  const runCliProc = runCli(specPath, dataDir, env);
  try {
    const streamPath = `${orchestratorDir}/stream.jsonl`;
    const gotResult = await waitForFileLine(streamPath, '"type":"result"', 10000);
    assert.ok(gotResult, `stream.jsonl at ${streamPath} never held a result line within 10,000 ms`);
    const turnEndAt = Date.now();

    const exited = await waitForExit(runCliProc.proc, 9000);
    assert.ok(exited, 'the CLI did not exit within 9,000 ms');
    const totalMs = Date.now() - t0;
    const sinceTurnEnd = Date.now() - turnEndAt;
    assert.ok(totalMs < 9000, `total run time ${totalMs} ms was not under 9,000 ms`);
    assert.ok(sinceTurnEnd >= 1400 && sinceTurnEnd <= 6000, `time since the turn end (${sinceTurnEnd} ms) was not within [1,500, 6,000] ms of close_grace_ms 1,500`);

    assert.strictEqual(exited.code, 1, `expected exit 1, stdout: ${runCliProc.stdout}, stderr: ${runCliProc.stderr}`);
    const receipt = receiptOf(runCliProc, 1);
    assert.match(receipt.ended_by, /stdin closed/);
    assert.strictEqual(receipt.orchestrator.killed_after_close, true);
    assert.notStrictEqual(receipt.orchestrator.exit_code, 0, 'a killed orchestrator must not report a clean exit code');
    assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'owner.lock is still present after the kill');
    assert.ok(Number.isInteger(receipt.store.ended.ended_at), 'the run row has no ended_at');
  } finally {
    if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});

test('run: a spawn error, a startup timeout and a failed ready check each end the run with exit 1, a receipt naming which, and no owner left', async () => {
  // Case 1: the exe does not exist at all — a stale BELAY_CLAUDE_EXE, spawned directly (ENOENT).
  {
    const dir = sandbox();
    const dataDir = `${dir}/.belay`;
    const { specPath } = makeSpec(dir);
    const exe = `${dir}/no-such-claude.exe`;
    const runCliProc = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: exe });
    try {
      const exited = await waitForExit(runCliProc.proc, 15000);
      assert.ok(exited, 'spawn-error case did not exit within 15,000 ms');
      assert.strictEqual(exited.code, 1, `stdout: ${runCliProc.stdout}, stderr: ${runCliProc.stderr}`);
      const receipt = receiptOf(runCliProc, 1);
      assert.match(receipt.ended_by, /could not be spawned/);
      assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'owner.lock is still present after a spawn error');
      assert.strictEqual(receipt.store.ended, null, 'a spawn error opened no row to end');
      assert.notStrictEqual(receipt.store.shutdown, null, 'becomeOwner made this process the owner, so it must still shut down');
      // 5a-3 item 2 of the design (orchestrator.cjs): `pid` must be a present key, not dropped by
      // JSON.stringify because `child.pid` was `undefined` on a spawn that never happened.
      assert.ok('pid' in receipt.orchestrator, "receipt.orchestrator is missing the 'pid' key entirely");
      assert.strictEqual(receipt.orchestrator.pid, null, 'a child that never spawned must report pid: null');
    } finally {
      if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
      cleanup(dir);
    }
  }

  // Case 2: the exe hangs — no ready event ever arrives inside startup_timeout_ms.
  {
    const dir = sandbox();
    const dataDir = `${dir}/.belay`;
    const { specPath, runId } = makeSpec(dir, { startup_timeout_ms: 1500 });
    const runCliProc = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_HANG: '1' });
    try {
      const exited = await waitForExit(runCliProc.proc, 15000);
      assert.ok(exited, 'startup-timeout case did not exit within 15,000 ms');
      assert.strictEqual(exited.code, 1, `stdout: ${runCliProc.stdout}, stderr: ${runCliProc.stderr}`);
      const receipt = receiptOf(runCliProc, 1);
      assert.match(receipt.ended_by, /startup_timeout_ms/);
      assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'owner.lock is still present after a startup timeout');
      const storeRow = readCurrentRunRow(dataDir, runId);
      assert.ok(storeRow && storeRow.ended_at, "the store's current run row has no ended_at");
      assert.strictEqual(storeRow.exit_reason, receipt.ended_by);
    } finally {
      if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
      cleanup(dir);
    }
  }

  // Case 3: the exe answers, but its ready event never lists belay as connected.
  {
    const dir = sandbox();
    const dataDir = `${dir}/.belay`;
    const { specPath, runId } = makeSpec(dir);
    const runCliProc = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_MCP: 'failed' });
    try {
      const exited = await waitForExit(runCliProc.proc, 15000);
      assert.ok(exited, 'failed-ready case did not exit within 15,000 ms');
      assert.strictEqual(exited.code, 1, `stdout: ${runCliProc.stdout}, stderr: ${runCliProc.stderr}`);
      const receipt = receiptOf(runCliProc, 1);
      // Fix round 3: tightened from /ADR 0001 §8|connected/, which a surface refusal also matches.
      assert.match(receipt.ended_by, /mcp_servers.*status connected/);
      assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'owner.lock is still present after a failed ready check');
      const storeRow = readCurrentRunRow(dataDir, runId);
      assert.ok(storeRow && storeRow.ended_at, "the store's current run row has no ended_at");
      assert.strictEqual(storeRow.exit_reason, receipt.ended_by);
    } finally {
      if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
      cleanup(dir);
    }
  }

  // Case 4 (5a-4 Done item 2): the election itself fails — memory.db pre-created as a directory —
  // before any write, any orchestrator dir, or any process is spawned.
  {
    const dir = sandbox();
    const dataDir = `${dir}/.belay`;
    const { specPath, orchestratorDir } = makeSpec(dir);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(`${dataDir}/memory.db`, { recursive: true });
    const runCliProc = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE });
    try {
      const exited = await waitForExit(runCliProc.proc, 15000);
      assert.ok(exited, 'election-failure case did not exit within 15,000 ms');
      assert.strictEqual(exited.code, 1, `stdout: ${runCliProc.stdout}, stderr: ${runCliProc.stderr}`);
      const receipt = receiptOf(runCliProc, 1);
      assert.match(receipt.ended_by, /election failed/);
      assert.match(receipt.store.established_by, /election failed/);
      assert.strictEqual(receipt.receipt_path, null, 'an election failure never writes a receipt file');
      assert.ok(!fs.existsSync(orchestratorDir), 'an election failure must not create the orchestrator dir');
      assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'owner.lock is still present after an election failure');
    } finally {
      if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
      cleanup(dir);
    }
  }
});

test('run: a throw between election and shutdown still exits, releases owner.lock, and returns a receipt', async () => {
  // Review 2's blocking finding (cmd-run.cjs): once becomeOwner() returns owner: true, a throw
  // anywhere before shutdownOwner() used to leave owner.lock held, the pipe server listening, and
  // the process never exiting (belay.cjs never calls process.exit). orchestrator_dir pointed at an
  // existing regular file reproduces the reviewer's proven trigger: writeOrchestratorFiles's mkdir
  // throws synchronously inside runOrchestrator, after election.
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const orchestratorDir = `${dir}/orch-is-a-file`;
  fs.writeFileSync(orchestratorDir, 'not a directory');
  const { specPath } = makeSpec(dir, { orchestrator_dir: orchestratorDir });

  const t0 = Date.now();
  const runCliProc = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE });
  try {
    const exited = await waitForExit(runCliProc.proc, 10000);
    assert.ok(exited, `the CLI never exited within 10,000 ms; a throw after election must not hang the process forever (stdout: ${runCliProc.stdout}, stderr: ${runCliProc.stderr})`);
    assert.ok(Date.now() - t0 < 10000, 'the run took too long to exit after the election');
    assert.strictEqual(exited.code, 1, `stdout: ${runCliProc.stdout}, stderr: ${runCliProc.stderr}`);
    const receipt = receiptOf(runCliProc, 1);
    assert.ok(receipt.ended_by, 'a crash in the protected span must still return a receipt naming why');
    assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'owner.lock must not survive a throw after election');
    assert.strictEqual(receipt.store.attach, null, 'no worker was ever attached before the crash');
    assert.notStrictEqual(receipt.store.shutdown, null, 'shutdownOwner() must still have run after the throw');
  } finally {
    if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});

// 5b-4 A1/A3: shared by both death-wake tests below. Spawns a hung fake (FAKE_HANG=1: accepts input,
// never answers) as the planted worker's own process and plants its `starting` row (`mid_turn: 1`)
// over that live pid; the caller kills the pid and, for the second test, plants the `dead` row too.
async function plantHungWorker(testCore, wt, runId, workerId) {
  const proc = spawn(process.execPath, [FAKE_CLAUDE], {
    cwd: wt, env: { ...process.env, FAKE_HANG: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  await new Promise((res) => proc.once('spawn', res));
  await testCore.worker.write({
    id: workerId, run_id: runId, substrate: 'claude-code', pid: proc.pid, pid_image: 'node.exe',
    state: 'starting', mid_turn: 1, turns: 0, started_at: Date.now(),
  });
  return proc;
}

test("run: a starting row whose pid dies while the orchestrator is idle holds stdin for the detector grace, then the 5a rule closes it with no wake", async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, wt, orchestratorDir, runId } = makeSpec(dir, { poll_ms: 300 });
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_DELAY_MS: '4000' };

  const t0 = Date.now();
  const runCliProc = runCli(specPath, dataDir, env);
  let testCore = null;
  let planted = null;
  try {
    testCore = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
    await waitUntil(async () => (await testCore.run.get()).run || null, 10000, 100);

    planted = await plantHungWorker(testCore, wt, runId, 'w-dead-start');
    const streamPath = `${orchestratorDir}/stream.jsonl`;
    const gotResult = await waitForFileLine(streamPath, '"type":"result"', 10000);
    assert.ok(gotResult, "the orchestrator's own first turn never ended");
    await sleep(2 * 300);
    require('../crash.cjs').crash(planted);

    const exited = await waitForExit(runCliProc.proc, 15000 - (Date.now() - t0));
    assert.ok(exited, `the CLI did not exit within 15,000 ms of its own spawn (${Date.now() - t0} ms elapsed)`);
    assert.strictEqual(exited.code, 0, `stdout: ${runCliProc.stdout}, stderr: ${runCliProc.stderr}`);
    const receipt = receiptOf(runCliProc, 0);
    assert.deepStrictEqual(receipt.wakes, [], `a dead-pid row inside the grace with no detector row must produce no wake: ${JSON.stringify(receipt.wakes)}`);
    const busyMoment = receipt.holds.find((h) => Array.isArray(h.busy) && h.busy.length === 1 && h.busy[0] === 'w-dead-start');
    assert.ok(busyMoment, `no hold moment named w-dead-start as busy before the kill: ${JSON.stringify(receipt.holds)}`);
    const pending = receipt.holds.filter((h) => Array.isArray(h.pending_deaths) && h.pending_deaths.length === 1 && h.pending_deaths[0] === 'w-dead-start');
    assert.strictEqual(pending.length, 1, `expected exactly one pending-death hold moment: ${JSON.stringify(receipt.holds)}`);
    assert.deepStrictEqual(pending[0].busy, []);
    assert.strictEqual(pending[0].established_by, "worker.list; pid dead, awaiting the detector's row");
    assert.ok(pending[0].at_ms > busyMoment.at_ms, 'the pending-death moment must come after the busy moment');
    assert.ok(receipt.ms >= pending[0].at_ms + 1500, `receipt.ms ${receipt.ms} must be at least the pending moment's at_ms + 1500`);
  } finally {
    // shutdownOwner() then close(): if the CLI already exited first (the race this test exercises),
    // this process is the owner, and only shutdownOwner() releases it (status.test.cjs's pattern).
    if (testCore) { try { await testCore.shutdownOwner(); } catch { /* best effort */ } try { await testCore.close(); } catch { /* best effort */ } }
    if (planted && P.pidAlive(planted.pid)) require('../crash.cjs').crash(planted);
    if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});

test('run: a dead row landing inside the grace produces the death wake with the detector\'s establisher, written while the orchestrator was idle', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, wt, orchestratorDir, runId } = makeSpec(dir, { poll_ms: 300 });
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_DELAY_MS: '4000' };

  const t0 = Date.now();
  const runCliProc = runCli(specPath, dataDir, env);
  let testCore = null;
  let planted = null;
  try {
    testCore = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
    await waitUntil(async () => (await testCore.run.get()).run || null, 10000, 100);

    planted = await plantHungWorker(testCore, wt, runId, 'w-dead-detected');
    const streamPath = `${orchestratorDir}/stream.jsonl`;
    const gotResult = await waitForFileLine(streamPath, '"type":"result"', 10000);
    assert.ok(gotResult, "the orchestrator's own first turn never ended");
    await sleep(2 * 300);
    const plantedPid = planted.pid;
    require('../crash.cjs').crash(planted);
    await sleep(2 * 300);
    await testCore.worker.write({
      id: 'w-dead-detected', run_id: runId, substrate: 'claude-code', pid: plantedPid,
      state: 'dead', exit_code: null, exit_signal: 'SIGKILL',
      death_established_by: 'test-planted-detector', mid_turn: 0,
    });

    const exited = await waitForExit(runCliProc.proc, 20000 - (Date.now() - t0));
    assert.ok(exited, `the CLI did not exit within 20,000 ms of its own spawn (${Date.now() - t0} ms elapsed)`);
    assert.strictEqual(exited.code, 0, `stdout: ${runCliProc.stdout}, stderr: ${runCliProc.stderr}`);
    const receipt = receiptOf(runCliProc, 0);

    assert.strictEqual(receipt.wakes.length, 1, JSON.stringify(receipt.wakes));
    const w = receipt.wakes[0];
    assert.strictEqual(w.worker_id, 'w-dead-detected');
    assert.strictEqual(w.event, 'death');
    assert.strictEqual(w.death_established_by, 'test-planted-detector');
    assert.strictEqual(w.orchestrator_idle_at_write, true);
    const pendingMoment = receipt.holds.find((h) => Array.isArray(h.pending_deaths) && h.pending_deaths.includes('w-dead-detected'));
    assert.ok(pendingMoment, `no hold moment named the pending death: ${JSON.stringify(receipt.holds)}`);
    assert.ok(pendingMoment.at_ms < w.at_ms, "the pending-death hold must precede the wake's at_ms");
    const storedWorker = await testCore.worker.get({ worker_id: 'w-dead-detected' });
    assert.strictEqual(storedWorker.death_established_by, w.death_established_by);
  } finally {
    // shutdownOwner() then close() (the prior test's finally note applies here too).
    if (testCore) { try { await testCore.shutdownOwner(); } catch { /* best effort */ } try { await testCore.close(); } catch { /* best effort */ } }
    if (planted && P.pidAlive(planted.pid)) require('../crash.cjs').crash(planted);
    if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});
