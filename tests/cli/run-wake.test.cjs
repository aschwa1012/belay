'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// run-wake.test.cjs — build step 5b, Done item 3. Drives
// the built CLI as a subprocess with tests/run/fakes/fake-claude.cjs standing in for the orchestrator,
// exactly as tests/cli/run-paths.test.cjs drives every case, and a real RunManager in THIS process
// standing in for the orchestrator's own adapter spawning workers: a core opened as
// { role: 'orchestrator', run_id, pid } on the same data dir connects to the CLI's already-elected
// owner over the pipe, and createRunManager wraps it exactly as an attached orchestrator would. Every
// assertion is about the receipt or the store; a `stream.jsonl` match on the orchestrator's own
// output is the arrival of a wake (the fake echoes what reached its stdin), never its intent.
//
// Run this file with --test-timeout=120000 (`node --test --test-timeout=120000
// tests/cli/run-wake.test.cjs`): several tests spawn a real CLI subprocess and a real store owner, and
// a lone run has no other bound on a stuck one. 5b-3 (FINDINGS.json note, tests/cli/run-wake.test.cjs
// line 146): every `waitUntil` below bounds the read it wraps with its own 5,000 ms race, so a hung
// store read fails the assertion that used it rather than the suite itself hanging — see the
// scaffolding test near the end of this file.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { openCore } = require('../../src/core/index.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { wakeText } = require('../../src/run/wake.cjs');
const P = require('../../src/run/process.cjs');
const { cleanupRun } = require('./run-teardown.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const USER_SETTINGS = `${ROOT}/tests/run/fixtures/user-settings.json`;

// ---------------------------------------------------------------- scaffolding (as run-paths.test.cjs)

const fwd = (p) => String(p).split(path.sep).join('/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sandbox() { return fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-wake-'))); }

function cleanup(dir) {
  for (let i = 0; i < 5; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { process.emitWarning(`sandbox left behind at ${dir}: ${e.code || e.message}`); }
}

// A3: the read `fn` wraps (a store read, a file read) is raced against this bound. A read that has
// not settled after READ_BOUND_MS is a hung read, not a slow one, and ends the wait with `null` at
// once instead of being retried — a caller whose own assertion depended on a real value then fails on
// that assertion, rather than the whole suite hanging on a read that will never come back.
const READ_BOUND_MS = 5000;

function boundedRead(fn) {
  return () => new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ hung: true });
    }, READ_BOUND_MS);
    Promise.resolve().then(fn).then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ hung: false, value: v }); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve({ hung: false, value: null }); } }
    );
  });
}

async function waitUntil(fn, timeoutMs, stepMs = 100) {
  const t0 = Date.now();
  const read = boundedRead(fn);
  for (;;) {
    const r = await read();
    if (r.hung) return null; // a hung read fails the wait at once; it is never retried
    if (r.value) return r.value;
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

function makeSpec(dir, overrides = {}) {
  const wt = `${dir}/wt`;
  fs.mkdirSync(wt, { recursive: true });
  const promptFile = `${dir}/prompt.txt`;
  fs.writeFileSync(promptFile, 'line one of the prompt\nline two of the prompt\n');
  const runId = overrides.run_id || `run-wake-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const orchestratorDir = overrides.orchestrator_dir || `${dir}/orch`;
  const spec = {
    worktree: wt, prompt_file: promptFile, run_id: runId, orchestrator_dir: orchestratorDir,
    startup_timeout_ms: 20000, on_embedder_failure: 'continue', ...overrides,
  };
  const specPath = `${dir}/spec.json`;
  fs.writeFileSync(specPath, JSON.stringify(spec));
  return { specPath, wt, promptFile, runId, orchestratorDir };
}

function runCli(specPath, dataDir, env) {
  const proc = spawn(process.execPath, [CLI, 'run', specPath, '--data', dataDir, '--json'], {
    cwd: ROOT, env: { ...process.env, ...env }, windowsHide: true,
  });
  let stdout = ''; proc.stdout.on('data', (d) => { stdout += d; });
  let stderr = ''; proc.stderr.on('data', (d) => { stderr += d; });
  return { proc, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

// The dispatcher writes a non-zero-code receipt to stderr, a zero-code one to stdout.
function receiptOf(run, exitCode) {
  return JSON.parse(exitCode === 0 ? run.stdout : run.stderr);
}

// -------------------------------------------------------- this file's own scaffolding

// The test's own RunManager stands in for the orchestrator's adapter: a core opened as role
// `orchestrator` on the CLI's data dir connects to the CLI's already-elected owner over the pipe
// (invariant 2: only a write elects, and the CLI elected first).
async function connectOrchestratorCore(dataDir, runId) {
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
  const row = await waitUntil(async () => (await core.run.get()).run || null, 10000, 100);
  assert.ok(row, "the CLI's run row never appeared within 10,000 ms");
  return core;
}

function workerWorktree(dir, id) {
  const wt = `${dir}/${id}-wt`;
  fs.mkdirSync(wt, { recursive: true });
  return wt;
}

// Polls the store (not the in-memory record) for a worker's row once it carries a pid — the fact the
// orchestrator's own poll reads. Used for a worker spawned with FAKE_HANG=1, whose `m.spawn` promise
// never resolves on its own (the fake produces no ready event at all) and is fired without an await.
async function waitForWorkerPid(core, workerId, timeoutMs) {
  return waitUntil(async () => {
    try {
      const w = await core.worker.get({ worker_id: workerId });
      return w && w.pid && w.pid_created ? w : null; // ADR 0039: the crash below needs the row's own creation time
    } catch { return null; }
  }, timeoutMs, 50);
}

// ================================================================ the tests

test("run: a worker's turn end reaches the orchestrator as a user message, recorded with its bytes, and the wake was written while the orchestrator was mid-turn", async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId, orchestratorDir } = makeSpec(dir, { poll_ms: 300 });
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_DELAY_MS: '8000' }; // 8,000 not 2,500: under npm test's parallel files the worker's first turn took longer than 2,500 ms once (orchestrator hygiene edit, 5b landing)
  const runCliProc = runCli(specPath, dataDir, env);
  let core = null; let m = null; const spawnedPids = [];
  try {
    core = await connectOrchestratorCore(dataDir, runId);
    m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE_CLAUDE, userSettings: USER_SETTINGS } });

    const row = await m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' });
    spawnedPids.push({ pid: row.pid, created: row.pid_created });

    const exited = await waitForExit(runCliProc.proc, 20000);
    assert.ok(exited, 'the CLI did not exit in time');
    assert.strictEqual(exited.code, 0, `stdout: ${runCliProc.stdout}, stderr: ${runCliProc.stderr}`);
    const receipt = receiptOf(runCliProc, 0);

    assert.strictEqual(receipt.wakes.length, 1, JSON.stringify(receipt.wakes));
    const w = receipt.wakes[0];
    assert.strictEqual(w.worker_id, 'w1');
    assert.strictEqual(w.event, 'turn_end');
    assert.strictEqual(w.turn, 1);
    const expectedText = wakeText({ worker_id: 'w1', event: 'turn_end', turn: 1 });
    assert.strictEqual(w.bytes, Buffer.byteLength(expectedText, 'utf8'));
    // Closed (build step 6h design item 7): this used to be a known, rare flake under a fully loaded
    // npm test run, because the fake wrote its system/init and result in the same synchronous burst,
    // 0-60 ms apart, racing the store read that decides `orchestrator_idle_at_write`. The fake now
    // emits its init at once, on receipt of the message, and the rest of the answer only after
    // FAKE_ANSWER_DELAY_MS (tests/run/fakes/fake-claude.cjs), as the real binary does: the orchestrator
    // reaches `turn_end` (which alone sets `state.idle = true`) only when that delayed result lands, so
    // for the whole 8,000 ms window before it, `state.idle` is deterministically false — there is no
    // longer a race to lose.
    assert.strictEqual(w.orchestrator_idle_at_write, false, "the orchestrator was still inside its first 8,000 ms answer");
    assert.match(w.established_by, /worker\.list row seq \d+/);
    // 5b-3 (FINDINGS.json note): the positive half of design item 2 — a matched wake's own record
    // stamped with when it was answered — had no assertion anywhere but A10's one real receipt.
    assert.ok(Number.isFinite(w.answered_at_ms), `answered_at_ms must be a finite number: ${JSON.stringify(w)}`);
    assert.ok(w.answered_at_ms > w.at_ms, `answered_at_ms ${w.answered_at_ms} must be after at_ms ${w.at_ms}`);

    const streamText = fs.readFileSync(`${orchestratorDir}/stream.jsonl`, 'utf8');
    assert.match(streamText, /worker w1 finished turn 1/);
    assert.strictEqual(receipt.orchestrator.turns, 2);
    assert.strictEqual(receipt.orchestrator.externally_triggered_turns, 0);
    assert.match(receipt.ended_by, /stdin closed/);
  } finally {
    await cleanupRun({ m, core, cliProc: runCliProc, spawnedPids, dir, runId, cleanup });
  }
});

test('run: a worker killed by exact pid produces a death wake within one poll, established by what the death detector recorded, written while the orchestrator was idle', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId, orchestratorDir } = makeSpec(dir, { poll_ms: 300 });
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_DELAY_MS: '1500' };
  const t0 = Date.now();
  const runCliProc = runCli(specPath, dataDir, env);
  let core = null; let m = null; const spawnedPids = [];
  try {
    core = await connectOrchestratorCore(dataDir, runId);
    m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE_CLAUDE, userSettings: USER_SETTINGS } });

    // FAKE_HANG=1 means the fake produces no output at all, not even a ready event, so `m.spawn`
    // never resolves on its own here: it is fired without an await, and its eventual E_NO_READY
    // rejection (once the kill below settles the worker) is swallowed. The row still lands — spawn
    // writes `starting` with a live pid before it ever waits for readiness.
    process.env.FAKE_HANG = '1';
    m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' }).catch(() => {});
    const row = await waitForWorkerPid(core, 'w1', 10000);
    delete process.env.FAKE_HANG;
    assert.ok(row && row.pid, 'the planted worker never got a live pid in the store');
    spawnedPids.push({ pid: row.pid, created: row.pid_created });
    assert.strictEqual(row.mid_turn, 1, "the worker's own starting row must carry mid_turn: 1");

    const streamPath = `${orchestratorDir}/stream.jsonl`;
    const gotResult = await waitForFileLine(streamPath, '"type":"result"', 15000);
    assert.ok(gotResult, "the orchestrator's own first turn never ended");
    await sleep(2 * 300);

    const killAt = Date.now() - t0;
    // Async: this process hosts the worker's manager, and a blocked loop lets its pid poll beat the exit event.
    assert.ok(await require('../crash.cjs').crashAsync(row.pid, row.pid_created), 'the planted worker was not killed');

    const exited = await waitForExit(runCliProc.proc, 20000);
    assert.ok(exited, 'the CLI did not exit in time');
    assert.strictEqual(exited.code, 0, `stdout: ${runCliProc.stdout}, stderr: ${runCliProc.stderr}`);
    const receipt = receiptOf(runCliProc, 0);

    assert.strictEqual(receipt.wakes.length, 1, JSON.stringify(receipt.wakes));
    const w = receipt.wakes[0];
    assert.strictEqual(w.event, 'death');
    assert.strictEqual(w.worker_id, 'w1');
    assert.strictEqual(w.turn, 0);
    assert.match(w.death_established_by, /exit-event|pid-poll/);
    assert.ok(
      Number.isInteger(w.exit_code) || typeof w.exit_signal === 'string',
      `neither an integer exit_code nor a string exit_signal: ${JSON.stringify({ exit_code: w.exit_code, exit_signal: w.exit_signal })}`
    );
    assert.strictEqual(w.orchestrator_idle_at_write, true);
    assert.ok(
      Math.abs(w.at_ms - killAt) <= 300 * 2 + 1500,
      `wake at_ms ${w.at_ms} too far from the kill measured at ${killAt}`
    );

    const streamText = fs.readFileSync(streamPath, 'utf8');
    assert.match(streamText, /worker w1 died during turn 0/);
    assert.strictEqual(receipt.orchestrator.turns, 2);
    assert.ok(
      receipt.holds.some((h) => Array.isArray(h.busy) && h.busy.length === 1 && h.busy[0] === 'w1'),
      JSON.stringify(receipt.holds)
    );
    // 5b-4: every hold moment that names a pending death names only this run's own worker.
    for (const h of receipt.holds) {
      if (Array.isArray(h.pending_deaths)) assert.deepStrictEqual(h.pending_deaths, ['w1'], JSON.stringify(h));
    }

    const stored = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(stored.state, 'dead');
    assert.strictEqual(stored.death_established_by, w.death_established_by);
  } finally {
    await cleanupRun({ m, core, cliProc: runCliProc, spawnedPids, dir, runId, cleanup });
  }
});

test("run: a worker given a second message holds stdin until its second turn ends, and both turn ends wake the orchestrator", async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId, orchestratorDir } = makeSpec(dir, { poll_ms: 300 });
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_DELAY_MS: '2000' };
  const runCliProc = runCli(specPath, dataDir, env);
  let core = null; let m = null; const spawnedPids = [];
  try {
    core = await connectOrchestratorCore(dataDir, runId);
    m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE_CLAUDE, userSettings: USER_SETTINGS } });

    // The worker's own turns (both of them) take 4,000 ms each: enough for the orchestrator's own
    // 2,000 ms answer to the first wake to land well before the worker's second turn ends.
    process.env.FAKE_ANSWER_DELAY_MS = '4000';
    let row;
    try { row = await m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1', startup_timeout_ms: 30000 }); }
    finally { delete process.env.FAKE_ANSWER_DELAY_MS; }
    spawnedPids.push({ pid: row.pid, created: row.pid_created });

    // Synchronize on the worker's own row reaching turns: 1 in the store, not on the orchestrator's
    // echo of the wake in its stream.jsonl: the echo text is part of the very same answer() call that
    // ends the orchestrator's own turn (both the assistant_text line carrying the echo and the
    // `result` line that ends the turn land in the same stdout chunk), so by the time the echo is
    // visible the poll that answers "is any worker still mid-turn, is any wake unanswered" has
    // already run and found both empty (measured: the CLI exits within about 100 ms of the echo
    // becoming visible, well inside the 500 ms this test waits before sending the second message,
    // so waiting on the echo loses the race it is meant to win). The worker's own turns: 1 lands in
    // the store a full poll cycle (poll_ms) and the orchestrator's 2,000 ms answer delay earlier than
    // its echo does, which is ample margin for the second message to be sent and its mid_turn: 1 row
    // to land before that first wake is answered.
    const turnedOnce = await waitUntil(async () => {
      const w = await core.worker.get({ worker_id: 'w1' });
      return w && w.turns === 1 ? w : null;
    }, 25000, 100);
    assert.ok(turnedOnce, "the worker's own first turn never landed in the store");
    await sleep(500);

    await m.message({ worker_id: 'w1', text: 'again' });

    const exited = await waitForExit(runCliProc.proc, 40000);
    assert.ok(exited, 'the CLI did not exit in time');
    assert.strictEqual(exited.code, 0, `stdout: ${runCliProc.stdout}, stderr: ${runCliProc.stderr}`);
    const receipt = receiptOf(runCliProc, 0);

    assert.strictEqual(receipt.wakes.length, 2, JSON.stringify(receipt.wakes));
    assert.deepStrictEqual(receipt.wakes.map((w) => w.turn).sort(), [1, 2]);
    assert.ok(receipt.wakes.every((w) => w.event === 'turn_end'), JSON.stringify(receipt.wakes));
    assert.strictEqual(receipt.orchestrator.turns, 3);
    assert.ok(
      receipt.holds.some((h) => h.turn === 2 && Array.isArray(h.busy) && h.busy.length === 1 && h.busy[0] === 'w1'),
      `no second-turn hold: ${JSON.stringify(receipt.holds)}`
    );
    assert.deepStrictEqual(receipt.wakes_suppressed, []);
  } finally {
    await cleanupRun({ m, core, cliProc: runCliProc, spawnedPids, dir, runId, cleanup });
  }
});

test('run: an unsolicited turn spanning a wake does not answer it; the wake expires, the run then closes, and the external turn is counted', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId } = makeSpec(dir, { poll_ms: 300, mcp_tool_timeout_ms: 8000 });
  const env = {
    BELAY_CLAUDE_EXE: FAKE_CLAUDE,
    FAKE_ANSWER_DELAY_MS: '500',
    FAKE_EXTRA_INIT: '1',
    FAKE_EXTRA_INIT_DELAY_MS: '4000',
    FAKE_HANG_AFTER: '1',
  };
  const runCliProc = runCli(specPath, dataDir, env);
  let core = null; let m = null; const spawnedPids = [];
  try {
    core = await connectOrchestratorCore(dataDir, runId);
    m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE_CLAUDE, userSettings: USER_SETTINGS } });

    // The test asserts a wake written INSIDE the unsolicited turn's 4,000 ms gap. It used to get there
    // only because a worker's turn end was slow (recordTurn awaited its memory write, an embed or a
    // library import), which a fast or empty cache changes. The worker's own turn now takes a stated
    // 2,000 ms (its fake's answer delay, set only around this spawn), so its turn end lands 1.5 to 3 s
    // into the gap wherever the spawn falls: the orchestrator's first turn ends 0.5 s after its prompt
    // and the spawn happens within about a second of that, whatever the model cache holds.
    const spawnStartedAt = Date.now();
    const keptDelay = process.env.FAKE_ANSWER_DELAY_MS;
    process.env.FAKE_ANSWER_DELAY_MS = '2000';
    let row;
    try { row = await spawnWorker(); } finally { if (keptDelay === undefined) delete process.env.FAKE_ANSWER_DELAY_MS; else process.env.FAKE_ANSWER_DELAY_MS = keptDelay; }

    async function spawnWorker() { return m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' }); }
    spawnedPids.push({ pid: row.pid, created: row.pid_created });

    const exited = await waitForExit(runCliProc.proc, 20000);
    assert.ok(exited, 'the CLI did not exit in time');
    assert.strictEqual(exited.code, 0, `stdout: ${runCliProc.stdout}, stderr: ${runCliProc.stderr}`);
    const receipt = receiptOf(runCliProc, 0);

    // PRECONDITION, asserted before the behaviour: the worker's turn end (which is what writes the wake)
    // landed inside its stated 2,000 ms turn window measured from the spawn call, i.e. the spawn was not
    // slow. A slow spawn or a slow host fails here, named as a precondition, not as a wake-handling bug.
    const turnEndAfterSpawnMs = m._worker('w1').lastTurnEndAt - spawnStartedAt;
    assert.ok(turnEndAfterSpawnMs >= 2000 && turnEndAfterSpawnMs <= 2000 + 2500,
      `precondition: the worker's turn ended ${turnEndAfterSpawnMs} ms after the spawn call, outside its stated 2,000 ms window (+2,500 ms of spawn slack); the wake could not have landed inside the unsolicited turn's gap`);

    assert.strictEqual(receipt.orchestrator.turns, 2, JSON.stringify(receipt.orchestrator));
    assert.strictEqual(receipt.orchestrator.externally_triggered_turns, 1, JSON.stringify(receipt.orchestrator));
    assert.strictEqual(receipt.wakes.length, 1, JSON.stringify(receipt.wakes));
    assert.strictEqual(receipt.wakes[0].expired, true);
    assert.strictEqual(receipt.wakes[0].answered_at_ms, undefined);
    assert.strictEqual(receipt.wakes_expired.length, 1, JSON.stringify(receipt.wakes_expired));
    assert.strictEqual(receipt.wakes_expired[0].worker_id, 'w1');
    assert.ok(receipt.wakes_expired[0].waited_ms >= 8000, JSON.stringify(receipt.wakes_expired));
    assert.ok(
      receipt.holds.some((h) =>
        Array.isArray(h.awaiting_wake) && h.awaiting_wake.length === 1 && h.awaiting_wake[0] === 'w1' && h.turn === 2),
      `no hold naming the still-awaited wake at turn 2: ${JSON.stringify(receipt.holds)}`
    );
    assert.match(receipt.ended_by, /stdin closed/);
    // 5b-3 (FINDINGS.json note): the run's own `ms`, not this test's wall clock, which was only ever
    // an upper bound on it.
    assert.ok(receipt.ms >= 9000, `receipt.ms too small: ${receipt.ms}`);
  } finally {
    await cleanupRun({ m, core, cliProc: runCliProc, spawnedPids, dir, runId, cleanup });
  }
});

test('run: an unanswered wake holds stdin open until the orchestrator answers it', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId, orchestratorDir } = makeSpec(dir, { poll_ms: 300 });
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_DELAY_MS: '3000' };
  const runCliProc = runCli(specPath, dataDir, env);
  let core = null; let m = null; const spawnedPids = [];
  try {
    core = await connectOrchestratorCore(dataDir, runId);
    m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE_CLAUDE, userSettings: USER_SETTINGS } });

    const row = await m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' });
    spawnedPids.push({ pid: row.pid, created: row.pid_created });

    const exited = await waitForExit(runCliProc.proc, 20000);
    assert.ok(exited, 'the CLI did not exit in time');
    assert.strictEqual(exited.code, 0, `stdout: ${runCliProc.stdout}, stderr: ${runCliProc.stderr}`);
    const receipt = receiptOf(runCliProc, 0);

    assert.strictEqual(receipt.wakes.length, 1, JSON.stringify(receipt.wakes));
    assert.strictEqual(receipt.orchestrator.turns, 2);
    assert.ok(
      receipt.holds.some((h) =>
        h.turn === 1 && Array.isArray(h.busy) && h.busy.length === 0 &&
        Array.isArray(h.awaiting_wake) && h.awaiting_wake.length === 1 && h.awaiting_wake[0] === 'w1'),
      `no hold naming the unanswered wake: ${JSON.stringify(receipt.holds)}`
    );
    assert.deepStrictEqual(receipt.wakes_suppressed, []);
  } finally {
    await cleanupRun({ m, core, cliProc: runCliProc, spawnedPids, dir, runId, cleanup });
  }
});

// ------------------------------------------------------------------------------ 5b-3: A3 scaffolding

test('run-wake scaffolding: a hung store read fails the wait instead of hanging the runner', async () => {
  const t0 = Date.now();
  const result = await waitUntil(() => new Promise(() => {}), 30000, 100);
  assert.strictEqual(result, null, 'a hung read must resolve the wait to null, not to a value');
  const took = Date.now() - t0;
  assert.ok(took < 6000, `waitUntil took ${took} ms to give up on a read that never settles`);
});

// The wake-correlation fix: two workers end
// together, the first wake starts a turn and the second is folded into it (FAKE_FOLD, as the real
// binary does). Before the fix the folded wake got no init of its own and held the idle run open
// until `mcp_tool_timeout_ms`; now the substrate's `command_lifecycle` completes it by its uuid.
test('run: two wakes answered by one orchestrator turn are both answered, one by init order and one by its command_lifecycle, and the run closes without waiting for the expiry', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId } = makeSpec(dir, { poll_ms: 300, mcp_tool_timeout_ms: 30000 });
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_DELAY_MS: '3000', FAKE_FOLD: '1' };
  const runCliProc = runCli(specPath, dataDir, env);
  let core = null; let m = null; const spawnedPids = [];
  try {
    core = await connectOrchestratorCore(dataDir, runId);
    m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE_CLAUDE, userSettings: USER_SETTINGS } });
    process.env.FAKE_ANSWER_DELAY_MS = '5000'; // the workers', inherited at spawn: both end after the orchestrator's first turn
    const rows = await Promise.all(['w1', 'w2'].map((id) =>
      m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, id), prompt: 'hello', worker_id: id })));
    for (const r of rows) spawnedPids.push({ pid: r.pid, created: r.pid_created });

    const exited = await waitForExit(runCliProc.proc, 25000);
    assert.ok(exited, 'the CLI did not exit in time: a stranded wake holds it until the 30,000 ms expiry');
    assert.strictEqual(exited.code, 0, `stdout: ${runCliProc.stdout}, stderr: ${runCliProc.stderr}`);
    const receipt = receiptOf(runCliProc, 0);
    assert.strictEqual(receipt.wakes.length, 2, JSON.stringify(receipt.wakes));
    assert.deepStrictEqual(receipt.wakes_expired, [], JSON.stringify(receipt.wakes_expired));
    for (const w of receipt.wakes) assert.ok(Number.isFinite(w.answered_at_ms) && !w.expired, JSON.stringify(w));
    assert.ok(receipt.wakes.some((w) => w.answered_by === 'command_lifecycle'), `no wake answered by its lifecycle: ${JSON.stringify(receipt.wakes)}`);
    assert.strictEqual(receipt.orchestrator.turns, 2, `the second wake was folded, not a turn of its own: ${JSON.stringify(receipt.orchestrator)}`);
    assert.ok(receipt.ms < 25000, `the run waited on something: ${receipt.ms} ms`);
  } finally {
    await cleanupRun({ m, core, cliProc: runCliProc, spawnedPids, dir, runId, cleanup });
  }
});
