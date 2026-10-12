'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// run-pause-3.test.cjs — build step 6i, design items 2, 3
// and 4: (h2) a park whose stopping row lands before the orchestrator's own turn ends still holds the
// idle close, over a real `belay run` (tests/cli/stop-helpers.cjs's scaffolding, the shape of
// run-pause-2.test.cjs's own (s12)). (h3) and (h4) drive `createRunPauseControl` directly against fake
// collaborators, as the reviews' own probes (probe-pidreuse, probe-repause-unit) did — no process, no
// store, deterministic.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const {
  ROOT, CLI, sleep, sandbox, cleanup, makeSpec, runCli, connectOrchestratorCore, waitUntil,
} = require('./stop-helpers.cjs');
const { createRunManager, createWorkerControl } = require('../../src/run/index.cjs');
const { createRunPauseControl } = require('../../src/run/run-pause.cjs');
const { renderRunResumeText } = require('../../src/cli/cmd-pause.cjs');
const P = require('../../src/run/process.cjs');
const { spawn } = require('node:child_process');

const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const USER_SETTINGS = `${ROOT}/tests/run/fixtures/user-settings.json`;

function workerWorktree(dir, id) {
  const wt = `${dir}/${id}-wt`;
  fs.mkdirSync(wt, { recursive: true });
  return wt;
}
function cliAsync(args, dataDir) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true });
    let stdout = ''; proc.stdout.on('data', (d) => { stdout += d; });
    let stderr = ''; proc.stderr.on('data', (d) => { stderr += d; });
    proc.once('exit', (status) => {
      let receipt = null;
      try { receipt = JSON.parse(status === 0 ? stdout : stderr); } catch { /* left null */ }
      resolve({ status, stdout, stderr, receipt });
    });
  });
}
async function startRun(dir, overrides, env) {
  const dataDir = `${dir}/.belay`;
  const { specPath, runId, orchestratorDir } = makeSpec(dir, { poll_ms: 300, ...overrides });
  const cliProc = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE, ...env });
  const core = await connectOrchestratorCore(dataDir, runId);
  const m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE_CLAUDE, userSettings: USER_SETTINGS } });
  const control = createWorkerControl({ dataDir, manager: m, pid: cliProc.proc.pid });
  await control.listen();
  return { dataDir, runId, orchestratorDir, cliProc, core, m, control };
}
async function teardown({ m, core, control, cliProc, spawnedPids, dir, dataDir, runId }) {
  delete process.env.FAKE_ANSWER_DELAY_MS;
  delete process.env.FAKE_IGNORE_STDIN_END;
  if (cliProc && cliProc.proc.exitCode === null && runId && dataDir) { try { await cliAsync(['stop', runId], dataDir); } catch { /* best effort */ } }
  if (control) { try { await control.close(); } catch { /* best effort */ } }
  if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
  for (const p of spawnedPids || []) require('../crash.cjs').crash(p.pid, p.created); // the row's own creation time, or no signal (ADR 0039)
  if (core) { try { await core.close(); } catch { /* best effort */ } }
  if (cliProc && cliProc.proc.exitCode === null) { try { await P.killTree(cliProc.proc); } catch { /* best effort */ } }
  cleanup(dir);
}

// ================================================================ (h2)
// C3 (src/run/pause.cjs:147): step 1b's fix had no test that could fail (blocking review: plant P2
// rarely turned it red both ways, and the plant's own effect on the run-stays-open assertion was never
// shown, because the fake's own interrupt round trip is fast enough that doStop's own default `stopping`
// write (manager.cjs:344, unconditional whenever step 1b's own write did not already land) usually beats
// the poll anyway). FAKE_IGNORE_INTERRUPT=1 makes sendInterrupt's own bound (`interrupt_timeout_ms`) the
// one deterministic gap between step 1b's write (at acceptance) and doStop's own (only once the
// interrupt/stop_task/descendant-snapshot work ahead of it, in doPause, has all resolved): a scratch
// probe against this fix round's own head read `stopping` inside 160-320 ms and the run outlived the
// whole interrupt bound every time; with step 1b's write removed the row read `running` the entire bound
// and the run closed under the idle rule partway through it (exitCode 0 at ~490 ms of a 1,200 ms bound).
// Polling `w.turns >= 1 && w.mid_turn === 0` before pausing (rather than a fixed sleep) waits out the
// real subprocess's own spawn-to-ready-to-first-turn latency, which this host took 900-1,050 ms to clear.
test('run: a park whose stopping row lands before the orchestrator\'s turn ends holds the idle close until the row reads paused, and belay resume succeeds after', async () => {
  const dir = sandbox();
  const spawnedPids = [];
  let ctx;
  try {
    // The orchestrator's prompt turn is held until w1's stopping row has landed, then released, so the turn ends
    // with that row in place by construction. A fixed 300 ms answer let a fast host idle both before the park
    // began, and the idle rule (correctly) closed the run.
    const gate = `${dir}/orchestrator-gate`;
    ctx = await startRun(dir, {}, { FAKE_ANSWER_GATE_FILE: gate });
    process.env.FAKE_IGNORE_STDIN_END = '1';
    process.env.FAKE_IGNORE_INTERRUPT = '1';
    const row = await ctx.m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' });
    spawnedPids.push({ pid: row.pid, created: row.pid_created });
    delete process.env.FAKE_IGNORE_STDIN_END;
    delete process.env.FAKE_IGNORE_INTERRUPT;

    // Past w1's own first turn, genuinely (not a fixed sleep): idle (not mid-turn) before the park, so
    // only step 1b's own `stopping` row — never `isMidTurn` — can be what holds the idle-close below.
    let ready = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(50);
      ready = await ctx.core.worker.get({ worker_id: 'w1' });
      if (ready.turns >= 1 && ready.mid_turn === 0) break;
    }
    assert.strictEqual(ready.turns >= 1 && ready.mid_turn === 0, true, `w1 never reached an idle turn: ${JSON.stringify(ready)}`);

    const INTERRUPT_TIMEOUT_MS = 1200; // FAKE_IGNORE_INTERRUPT never answers it: sendInterrupt holds this whole bound.
    const pauseAt = Date.now();
    const pauseP = ctx.m.pause({ worker_id: 'w1', by: 'operator:1', interrupt_timeout_ms: INTERRUPT_TIMEOUT_MS, exit_timeout_ms: 5000 });

    // Step 1b's write must land at the park's acceptance, well inside the interrupt bound doStop's own
    // default write is gated behind (plant P2: this reads `running` the whole bound instead).
    let rowSoon = null;
    for (const waitMs of [150, 150, 150]) {
      await sleep(waitMs);
      rowSoon = await ctx.core.worker.get({ worker_id: 'w1' });
      if (rowSoon.state === 'stopping') break;
    }
    assert.strictEqual(rowSoon.state, 'stopping', `step 1b's write must land well before doStop's own (row read ${rowSoon.state} within 450 ms of a ${INTERRUPT_TIMEOUT_MS} ms bound)`);
    assert.strictEqual(rowSoon.pid_alive, true);

    // The load-bearing assertion: nothing but this `stopping` row (a live pid, not yet paused, not
    // mid-turn) holds the idle-close open here (plant P2: the run closes partway through this same
    // bound instead, since w1's row reads plain `running` — not mid-turn, not stopping, not parked).
    fs.writeFileSync(gate, ''); // the orchestrator now ends its turn, with w1's row reading stopping
    const idle = await waitUntil(() => {
      try { return /"type":"result"/.test(fs.readFileSync(`${ctx.orchestratorDir}/stream.jsonl`, 'utf8')); } catch { return false; }
    }, 4000, 25);
    assert.ok(idle, "the orchestrator's turn never ended once the gate opened");
    await sleep(Math.max(0, pauseAt + INTERRUPT_TIMEOUT_MS - 300 - Date.now())); // polls of an idle orchestrator, still inside the bound
    assert.strictEqual(ctx.cliProc.proc.exitCode, null, 'the run must stay open through the park, not end under a worker with no held wake');

    const paused = await pauseP;
    assert.strictEqual(paused.paused, true);
    const rowAfterPause = await ctx.core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(rowAfterPause.state, 'paused');

    const resumed = await cliAsync(['resume', 'w1'], ctx.dataDir);
    assert.strictEqual(resumed.status, 0, `${resumed.stdout} / ${resumed.stderr}`);
    assert.strictEqual(resumed.receipt.resumed, true);
  } finally { delete process.env.FAKE_IGNORE_STDIN_END; delete process.env.FAKE_IGNORE_INTERRUPT; await teardown({ ...ctx, spawnedPids, dir }); }
});

// ================================================================ (h3) and (h4)
// Fake collaborators for createRunPauseControl, in the shape the reviews' own probes drove it: no
// process, no store, the run row and the worker rows kept in plain maps.
// Fix-up (a): the fake's own `setPaused`/`get` carry `pause_parks` on the fake run row, as the real store
// does, so the resume reads it from the row alone — never from an in-memory fallback (amendment 4).
function makeFakeRun(runId) {
  const workers = new Map();
  let run = { id: runId, paused_at: null, paused_by: null, pause_parks: null, ended_at: null };
  const core = {
    run: {
      async get() { return { run }; },
      async setPaused({ paused, at, by, parks }) {
        run = { ...run, paused_at: paused ? at : null, paused_by: paused ? by : null, pause_parks: paused ? (parks !== undefined ? parks : null) : null };
        return run;
      },
    },
    worker: { async list() { return { workers: [...workers.values()] }; } },
  };
  return { core, workers, setWorker: (id, row) => workers.set(id, { id, ...row }) };
}
function fakeHook() { // no isPaused: falls back to the row's own paused_at, as s4's own fake hook does
  return { exited: () => false, finishing: () => false, pause: async () => ({ interrupt: { sent: false }, timeout: null }), resume: async (by, line) => ({ held: [], line, timeout: null }) };
}
// item b: flattened, as callWorkerAdapter's own real receipts are (`{...result, success: true}`,
// src/cli/adapter-pipe.cjs:135, result carrying paused_at/paused_by, src/run/pause.cjs:188) — the old
// nested `{ success, receipt: { worker_id, paused } }` shape carried no paused_at for run-pause.cjs's
// own pairFor (now resume-set.cjs's buildParks) to read.
function fakePauseWorker(workers) {
  return async (id, caller) => {
    const w = workers.get(id);
    const paused_by = `${caller.role}:${caller.pid}`;
    const paused_at = Date.now();
    workers.set(id, { ...w, state: 'paused', paused_by, paused_at });
    return { success: true, worker_id: id, paused: true, already: false, paused_at, paused_by };
  };
}
function fakeResumeWorker(workers) {
  return async (id) => {
    const w = workers.get(id);
    workers.set(id, { ...w, state: 'running', paused_by: null, paused_at: null });
    return { success: true, receipt: { worker_id: id, resumed: true } };
  };
}

// C4, C5 (src/run/run-pause.cjs:130): matching on `paused_by` alone (the pre-fix rule) let a worker
// hand-paused before the run pause, under an identity a reused CLI pid happens to also produce, be
// relaunched by the resume. probe-pidreuse's own scenario: w1 paused by 'operator:24176' before the run
// pause, whose own caller pid is 24176 too (Windows reused it).
test('run resume: a worker hand-paused before the run pause by an identity that reuses the pausing pid stays parked', async () => {
  const { core, workers, setWorker } = makeFakeRun('run-h3');
  setWorker('w1', { run_id: 'run-h3', state: 'paused', paused_by: 'operator:24176', paused_at: 1000 });
  const control = createRunPauseControl({
    runId: 'run-h3', core, hook: fakeHook(),
    pauseWorker: fakePauseWorker(workers), resumeWorker: fakeResumeWorker(workers), stopInFlight: () => false,
  });

  const pauseResult = await control.pause({ run_id: 'run-h3', caller: { role: 'operator', pid: 24176 } });
  assert.deepStrictEqual(pauseResult.already_parked, ['w1']);
  assert.deepStrictEqual(pauseResult.workers, []);

  const resumeResult = await control.resume({ run_id: 'run-h3', caller: { role: 'operator', pid: 24176 } });
  assert.deepStrictEqual(resumeResult.workers_resumed, []);
  const w1Left = resumeResult.left_parked.find((w) => w.worker_id === 'w1');
  assert.ok(w1Left && w1Left.already_parked, `w1 must stay parked: ${JSON.stringify(resumeResult.left_parked)}`);
  assert.strictEqual(workers.get('w1').state, 'paused', 'w1 must never have been relaunched');

  // Should-fix (item 4): the rendered line, not only the receipt, names why w1 stayed parked.
  const text = renderRunResumeText({ run_id: 'run-h3', resumed: true, ...resumeResult });
  assert.match(text, /worker w1: left parked \(already parked before this pause\)/, text);
});

// C10 (src/run/run-pause.cjs:131): a worker this pause parked, then resumed and re-paused by hand (a
// different identity) inside the same run pause, must stay parked and be named `re_paused`, not
// `already_parked` (which would say, falsely, that it predates this pause). probe-repause-unit's shape.
test('run resume: a worker this pause parked, then resumed and re-paused by hand inside the pause, stays parked and is named re_paused', async () => {
  const { core, workers, setWorker } = makeFakeRun('run-h4');
  setWorker('w1', { run_id: 'run-h4', substrate: 'claude-code', state: 'running', pid_alive: true });
  setWorker('w2', { run_id: 'run-h4', substrate: 'claude-code', state: 'running', pid_alive: true });
  const control = createRunPauseControl({
    runId: 'run-h4', core, hook: fakeHook(),
    pauseWorker: fakePauseWorker(workers), resumeWorker: fakeResumeWorker(workers), stopInFlight: () => false,
  });

  const pauseResult = await control.pause({ run_id: 'run-h4', caller: { role: 'operator', pid: 1 } });
  assert.deepStrictEqual(pauseResult.workers.map((w) => w.worker_id).sort(), ['w1', 'w2']);

  // w1 hand-resumed, then hand-paused again by a different identity, entirely inside this one run pause.
  await fakeResumeWorker(workers)('w1', { role: 'operator', pid: 1 });
  await fakePauseWorker(workers)('w1', { role: 'operator', pid: 9999 });

  const resumeResult = await control.resume({ run_id: 'run-h4', caller: { role: 'operator', pid: 1 } });
  assert.deepStrictEqual(resumeResult.workers_resumed.map((w) => w.worker_id), ['w2']);
  const w1Left = resumeResult.left_parked.find((w) => w.worker_id === 'w1');
  assert.ok(w1Left && w1Left.re_paused === true, `w1 must be named re_paused: ${JSON.stringify(w1Left)}`);
  assert.strictEqual(workers.get('w1').state, 'paused');

  // Should-fix (item 4): re_paused's own wording, not just the receipt's boolean, is under test — a
  // planted revert of cmd-pause.cjs's rendering must turn this red even while the receipt stays right.
  const text = renderRunResumeText({ run_id: 'run-h4', resumed: true, ...resumeResult });
  assert.match(text, /worker w1: left parked \(paused again, by another identity, after this pause began\)/, text);
  assert.match(text, /worker w2: resumed/, text);
});
