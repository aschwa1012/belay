'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// run-pause.test.cjs — build step 6f, ADR 0023 amendment 3.
// Drives the built CLI as a subprocess with tests/run/fakes/fake-claude.cjs standing in for the
// orchestrator (tests/cli/run-wake.test.cjs's scaffolding, shared via tests/cli/stop-helpers.cjs), and,
// as tests/cli/pause.test.cjs does for the worker form, a real RunManager in this process attached as
// the run's own worker adapter: `belay run`'s own onAttached writes the row's adapter_pid as its own
// subprocess pid, so this test's worker adapter pipe binds to that pid (`createWorkerControl({ pid:
// cliProc.proc.pid })`) — where run-pause.cjs's own pauseWorker/resumeWorker dial. --test-timeout=300000.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
  ROOT, CLI, sleep, sandbox, cleanup, waitUntil, waitForExit, makeSpec, runCli, receiptOf, connectOrchestratorCore, currentRunRow, releaseCore,
} = require('./stop-helpers.cjs');
const { createRunManager, createWorkerControl } = require('../../src/run/index.cjs');
const { createRunPauseControl } = require('../../src/run/run-pause.cjs');
const { openCore } = require('../../src/core/index.cjs');
const P = require('../../src/run/process.cjs');

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

// This process becomes the worker adapter for a real `belay run` subprocess, bound to exactly the pid
// that subprocess's own `run.attach` named `adapter_pid` — its own.
async function startRun(dir, overrides, env) {
  const dataDir = `${dir}/.belay`;
  const { specPath, runId, orchestratorDir } = makeSpec(dir, { poll_ms: 300, ...overrides });
  const cliProc = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE, ...env });
  const core = await connectOrchestratorCore(dataDir, runId);
  const m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE_CLAUDE, userSettings: USER_SETTINGS } });
  const control = createWorkerControl({ redeem: null, dataDir, manager: m, pid: cliProc.proc.pid });
  await control.listen();
  return { dataDir, runId, orchestratorDir, cliProc, core, m, control };
}

async function teardown({ m, core, control, cliProc, spawnedPids, dir, dataDir, runId }) {
  delete process.env.FAKE_ANSWER_DELAY_MS;
  // CLAUDE.md: the owner's own shutdown call, never a signal — s1/s2/s6's normal teardown, before control/m close; the tree-kill below is only for a stop that never lands.
  if (cliProc && cliProc.proc.exitCode === null && runId && dataDir) { try { await cliAsync(['stop', runId], dataDir); } catch { /* best effort */ } await waitForExit(cliProc.proc, 8000); }
  if (control) { try { await control.close(); } catch { /* best effort */ } }
  if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
  for (const p of spawnedPids || []) require('../crash.cjs').crash(p.pid, p.created); // the row's own creation time, or no signal (ADR 0039)
  await releaseCore(core);
  if (cliProc && cliProc.proc.exitCode === null) { try { await P.killTree(cliProc.proc); } catch { /* best effort */ } }
  cleanup(dir);
}

// ================================================================ (s1)

test('run pause: the orchestrator is interrupted mid-turn, every live worker is parked over its adapter\'s pipe, and the run row carries paused_at and paused_by', async () => {
  const dir = sandbox();
  const spawnedPids = [];
  let ctx;
  try {
    ctx = await startRun(dir, {}, { FAKE_ANSWER_DELAY_MS: '25000' }); // fix round: 8000 flaked on this file's cold-JIT first test; the pause never waits the delay out
    const row = await ctx.m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' });
    spawnedPids.push({ pid: row.pid, created: row.pid_created });
    await sleep(400); // the worker's own starting row lands, well inside the 8,000 ms orchestrator answer

    const r = await cliAsync(['pause', ctx.runId], ctx.dataDir);
    assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
    assert.strictEqual(r.receipt.paused, true);
    assert.strictEqual(r.receipt.already, false);
    assert.strictEqual(r.receipt.interrupt.sent, true);
    assert.strictEqual(r.receipt.interrupt.turn_was_running, true, 'the orchestrator was still inside its 8,000 ms answer');
    assert.strictEqual(r.receipt.interrupt.response_subtype, 'success');
    assert.strictEqual(r.receipt.interrupt.turn_ended, true);
    assert.strictEqual(r.receipt.workers.length, 1, JSON.stringify(r.receipt));
    assert.strictEqual(r.receipt.workers[0].worker_id, 'w1');
    assert.strictEqual(r.receipt.workers[0].receipt.success, true);
    assert.deepStrictEqual(r.receipt.not_paused, []);
    assert.deepStrictEqual(r.receipt.already_parked, []);

    const runRow = currentRunRow(ctx.dataDir, ctx.runId);
    assert.ok(Number.isInteger(runRow.paused_at), `paused_at ${runRow.paused_at} must be an integer`);
    assert.ok(runRow.paused_by, 'paused_by must be set');

    const w1 = await ctx.core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(w1.state, 'paused');
  } finally { await teardown({ ...ctx, spawnedPids, dir }); }
});

// ================================================================ (s2)

test('run pause: a worker\'s turn ending while the run is paused is held, not written, and resume writes the resume line then the held wakes in order', async () => {
  const dir = sandbox();
  const spawnedPids = [];
  let ctx;
  try {
    // The orchestrator's prompt turn is held until the gate file exists, then it idles. A fixed 400 ms answer
    // raced the spawn on a slow runner: the orchestrator went idle before w1 existed, and the idle rule closed
    // the run before the pause. Later answers (the resume line's) take the 400 ms delay.
    const gate = `${dir}/orchestrator-gate`;
    ctx = await startRun(dir, {}, { FAKE_ANSWER_DELAY_MS: '400', FAKE_ANSWER_GATE_FILE: gate });
    // Build step E1 (finding F): the worker's own stated 5,000 ms turn, inherited at spawn, so the pause
    // lands mid-turn by construction. It used to land there only because the turn end waited on the turn
    // text's memory write, which no longer sits on the turn path.
    process.env.FAKE_ANSWER_DELAY_MS = '5000';
    const row = await ctx.m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' });
    process.env.FAKE_ANSWER_DELAY_MS = '400';
    spawnedPids.push({ pid: row.pid, created: row.pid_created });
    fs.writeFileSync(gate, ''); // w1 is mid-turn, so the orchestrator may now go idle without closing the run
    const idle = await waitUntil(() => {
      try { return /"type":"result"/.test(fs.readFileSync(`${ctx.orchestratorDir}/stream.jsonl`, 'utf8')); } catch { return false; }
    }, 4000, 25);
    assert.ok(idle, "the orchestrator's turn never ended once the gate opened");
    assert.strictEqual(ctx.m._worker('w1').turnEnded, false, 'precondition: w1 is mid-turn when the run is paused');

    const p = await cliAsync(['pause', ctx.runId], ctx.dataDir);
    assert.strictEqual(p.status, 0, `${p.stdout} / ${p.stderr}`);
    assert.strictEqual(p.receipt.workers.length, 1, JSON.stringify(p.receipt));
    // A wake is held only when the run's own poll (poll_ms 300) sees w1's row while the run is paused; a fast host
    // ran pause and resume inside one poll interval and held nothing. Nothing outside the run shows a held wake,
    // so wait out several of its polls: its own fixed timer, not a guess at another process's speed.
    await sleep(1200);

    const r = await cliAsync(['resume', ctx.runId], ctx.dataDir);
    assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
    assert.strictEqual(r.receipt.resumed, true);
    assert.ok(typeof r.receipt.line === 'string' && r.receipt.line.length > 0, 'the resume line must be recorded');
    // Whichever wake the poll found first while paused (w1's turn_end, or its row reading paused once the
    // park lands, design item 1) is held rather than written, and this resume delivers it.
    assert.ok(Array.isArray(r.receipt.held_wakes) && r.receipt.held_wakes.length >= 1, JSON.stringify(r.receipt.held_wakes));
    const heldForW1 = r.receipt.held_wakes.filter((w) => w.worker_id === 'w1');
    assert.ok(heldForW1.length >= 1, `no held wake for w1: ${JSON.stringify(r.receipt.held_wakes)}`);
    assert.ok(heldForW1.every((w) => (w.event === 'turn_end' || w.event === 'paused') && Number.isInteger(w.held_ms) && w.held_ms >= 0), JSON.stringify(heldForW1));
    assert.deepStrictEqual(r.receipt.workers_resumed.map((w) => w.worker_id), ['w1']);

    await sleep(600); // design item 5 (run-hold.cjs:133): lets the fake answer the resume line's own write
    await cliAsync(['stop', ctx.runId], ctx.dataDir); await waitForExit(ctx.cliProc.proc, 15000);
    const receipt = receiptOf(ctx.cliProc, ctx.cliProc.proc.exitCode === 0 ? 0 : 1);
    const resumeWake = (receipt.wakes || []).find((w) => w.event === 'resume_line');
    assert.ok(resumeWake && resumeWake.answered_at_ms >= resumeWake.at_ms, JSON.stringify(resumeWake));
  } finally { await teardown({ ...ctx, spawnedPids, dir }); }
});

// ================================================================ (s3)

test('run pause: a paused run is never closed by the idle rule, and resume lets the ordinary close end it once no worker is mid-turn or parked', async () => {
  const dir = sandbox();
  let ctx;
  try {
    // The orchestrator's own prompt turn stays open until the pause interrupts it (it waits for a gate nothing writes first), so
    // nothing here races its natural idle-close (which the pause is what must prevent, not a lucky ordering). A fixed answer delay
    // did that only while this test's setup and the pause, each vouched for by the owner's operator check (ADR 0045), fitted in it.
    const gate = `${dir}/orch.gate`;
    ctx = await startRun(dir, {}, { FAKE_ANSWER_DELAY_MS: '6000', FAKE_ANSWER_GATE_FILE: gate });
    await sleep(300);

    const p = await cliAsync(['pause', ctx.runId], ctx.dataDir);
    assert.strictEqual(p.status, 0, `${p.stdout} / ${p.stderr}`);
    fs.writeFileSync(gate, ''); // the resume line's answer takes the ordinary delay

    await sleep(1500); // several poll cycles: the idle rule must not close a paused run
    assert.strictEqual(ctx.cliProc.proc.exitCode, null, 'a paused run must not have closed on its own');

    const r = await cliAsync(['resume', ctx.runId], ctx.dataDir);
    assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);

    const exited = await waitForExit(ctx.cliProc.proc, 20000);
    assert.ok(exited, 'the run never closed after resume, with nothing left to hold it open');
    assert.strictEqual(exited.code, 0, `stdout: ${ctx.cliProc.stdout}, stderr: ${ctx.cliProc.stderr}`);
    const receipt = receiptOf(ctx.cliProc, 0);
    assert.match(receipt.ended_by, /no worker mid-turn; stdin closed/);
  } finally { await teardown({ ...ctx, spawnedPids: [], dir }); }
});

// ================================================================ (s4) — run-pause.cjs's own slot, fakes only

test('run pause: a second pause shares the first, a resume during a pause is E_BUSY, a pause of a paused run is already, and a resume of a running run is E_ARGS', async () => {
  let runRow = { id: 'run-x', ended_at: null, paused_at: null, paused_by: null };
  let releasePause = null;
  let interruptCalls = 0;
  const core = {
    run: {
      get: async () => ({ run: { ...runRow } }),
      setPaused: async ({ paused }) => {
        runRow = { ...runRow, paused_at: paused ? Date.now() : null, paused_by: paused ? 'operator' : null };
        return { ...runRow };
      },
    },
    worker: { list: async () => ({ workers: [] }) },
  };
  const hook = {
    pause: async () => {
      interruptCalls += 1;
      await new Promise((resolve) => { releasePause = resolve; });
      return { interrupt: { sent: true }, timeout: null };
    },
    resume: async (by, line) => ({ held: [], line, timeout: null }),
  };
  const ctrl = createRunPauseControl({
    runId: 'run-x', core, hook,
    pauseWorker: async () => ({ success: true }), resumeWorker: async () => ({ success: true }),
  });
  const caller = { role: 'operator', pid: process.pid };
  const run_id = 'run-x';
  const p1 = ctrl.pause({ caller, run_id });
  const p2 = ctrl.pause({ caller, run_id }); // a second pause while one is in flight shares it
  await sleep(20);
  assert.strictEqual(interruptCalls, 1, 'a second pause must not start its own hook.pause()');

  await assert.rejects(ctrl.resume({ caller, run_id }), (e) => { assert.strictEqual(e.code, 'E_BUSY'); assert.strictEqual(e.detail.op, 'pause'); return true; });

  releasePause();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(r1, r2, 'a shared pause resolves to the very same receipt');
  assert.strictEqual(r1.already, false);

  const already = await ctrl.pause({ caller, run_id });
  assert.strictEqual(already.already, true);
  assert.strictEqual(interruptCalls, 1, 'a pause of an already-paused run must not interrupt again');

  await ctrl.resume({ caller, run_id });
  await assert.rejects(ctrl.resume({ caller, run_id }), (e) => { assert.strictEqual(e.code, 'E_ARGS'); return true; });
  // finding 1 (blocking): any id but this control's own live run is refused outright.
  await assert.rejects(ctrl.pause({ caller, run_id: 'rv-stale-run' }), (e) => { assert.strictEqual(e.code, 'E_NOT_FOUND'); assert.strictEqual(e.detail.live_run_id, run_id); return true; });
  await assert.rejects(ctrl.resume({ caller, run_id: 'rv-stale-run' }), { code: 'E_NOT_FOUND' });
});

// ================================================================ (s5)

test('run pause: belay stop during a paused run ends it and names the parked workers under left_parked', async () => {
  const dir = sandbox();
  const spawnedPids = [];
  let ctx;
  try {
    ctx = await startRun(dir, { close_grace_ms: 5000 }, { FAKE_ANSWER_DELAY_MS: '8000' });
    const row = await ctx.m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' });
    spawnedPids.push({ pid: row.pid, created: row.pid_created });
    await sleep(400);

    const p = await cliAsync(['pause', ctx.runId], ctx.dataDir);
    assert.strictEqual(p.status, 0, `${p.stdout} / ${p.stderr}`);
    assert.strictEqual(p.receipt.workers.length, 1);

    const s = await cliAsync(['stop', ctx.runId], ctx.dataDir);
    assert.strictEqual(s.status, 0, `${s.stdout} / ${s.stderr}`);
    assert.deepStrictEqual(s.receipt.left_parked, ['w1']);

    // Wait for the run process itself to exit (closing its own store handle) before a copy-then-read:
    // reading the live memory.db-shm while its own owner is still mid-teardown can hit a transient
    // EBUSY on Windows.
    const exited = await waitForExit(ctx.cliProc.proc, 15000);
    assert.ok(exited, 'the CLI did not exit after stop');
    const runRow = currentRunRow(ctx.dataDir, ctx.runId);
    assert.ok(runRow.ended_at != null, 'the run must have ended');
  } finally { await teardown({ ...ctx, spawnedPids, dir }); }
});

// ================================================================ (s6)

test('run pause: a worker parked before the run pause is named already_parked and left parked by the run resume', async () => {
  const dir = sandbox();
  const spawnedPids = [];
  let ctx;
  try {
    // The orchestrator's own prompt turn stays open past this test's own steps (the idle-close rule
    // must never get a chance to fire on its own — see s3).
    ctx = await startRun(dir, {}, { FAKE_ANSWER_DELAY_MS: '6000' });
    const r1 = await ctx.m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' });
    const r2 = await ctx.m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w2'), prompt: 'hello', worker_id: 'w2' });
    spawnedPids.push({ pid: r1.pid, created: r1.pid_created }, { pid: r2.pid, created: r2.pid_created });
    await sleep(400);

    const preParked = await cliAsync(['pause', 'w1'], ctx.dataDir); // the worker form, ahead of any run pause
    assert.strictEqual(preParked.status, 0, `${preParked.stdout} / ${preParked.stderr}`);
    await sleep(300); // let the orchestrator's own poll see and echo w1's paused row before the run pause

    const p = await cliAsync(['pause', ctx.runId], ctx.dataDir);
    assert.strictEqual(p.status, 0, `${p.stdout} / ${p.stderr}`);
    assert.deepStrictEqual(p.receipt.already_parked, ['w1']);
    assert.strictEqual(p.receipt.workers.length, 1, JSON.stringify(p.receipt.workers));
    assert.strictEqual(p.receipt.workers[0].worker_id, 'w2');

    const r = await cliAsync(['resume', ctx.runId], ctx.dataDir);
    assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
    assert.strictEqual(r.receipt.workers_resumed.length, 1);
    assert.strictEqual(r.receipt.workers_resumed[0].worker_id, 'w2');
    const leftW1 = r.receipt.left_parked.find((w) => w.worker_id === 'w1');
    assert.ok(leftW1, JSON.stringify(r.receipt.left_parked));
    assert.strictEqual(leftW1.already_parked, true);

    const w1 = await ctx.core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(w1.state, 'paused', 'a worker parked before the run pause must stay parked after the run resume');
  } finally { await teardown({ ...ctx, spawnedPids, dir }); }
});

// ================================================================ (s7)

test('run pause: the timeout clock stops while paused and resume re-arms what remained', async () => {
  const dir = sandbox();
  let ctx;
  try {
    // A long answer delay keeps the orchestrator's own prompt turn open well past this test's own
    // steps, so the idle-close rule (not the timeout) never gets a chance to end the run first.
    // timeout_ms leaves a slow runner room to start the pause CLI before the clock runs out; the paused wait
    // below is sized from what remained, so the proof costs no more than that.
    ctx = await startRun(dir, { timeout_ms: 10000 }, { FAKE_ANSWER_DELAY_MS: '60000' });
    await sleep(300);

    const p = await cliAsync(['pause', ctx.runId], ctx.dataDir);
    assert.strictEqual(p.status, 0, `${p.stdout} / ${p.stderr}`);
    assert.ok(p.receipt.timeout && Number.isInteger(p.receipt.timeout.remaining_ms), JSON.stringify(p.receipt.timeout));
    assert.ok(p.receipt.timeout.remaining_ms > 0 && p.receipt.timeout.remaining_ms <= 10000, JSON.stringify(p.receipt.timeout));

    await sleep(p.receipt.timeout.remaining_ms + 1000); // longer than what remained — proves the clock is stopped
    assert.strictEqual(ctx.cliProc.proc.exitCode, null, 'a paused run\'s timeout must not have fired');

    const r = await cliAsync(['resume', ctx.runId], ctx.dataDir);
    assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
    assert.ok(r.receipt.timeout && Number.isInteger(r.receipt.timeout.armed_ms), JSON.stringify(r.receipt.timeout));
    assert.ok(r.receipt.timeout.armed_ms <= p.receipt.timeout.remaining_ms + 50, 'resume must re-arm no more than what remained');

    const exited = await waitForExit(ctx.cliProc.proc, 20000);
    assert.ok(exited, 'the re-armed timeout never ended the run');
    const receipt = receiptOf(ctx.cliProc, exited.code === 0 ? 0 : 1);
    assert.match(receipt.ended_by, /timeout/);
  } finally { await teardown({ ...ctx, spawnedPids: [], dir }); }
});

// ================================================================ (s8)

test('run pause: an interrupted orchestrator write is answered by its cancelled lifecycle, not the expiry', async () => {
  const dir = sandbox();
  const spawnedPids = [];
  let ctx;
  try {
    // The orchestrator's prompt turn is held by a gate nothing writes, so the pause below lands mid-turn however long this test's
    // setup and the pause's own operator check (ADR 0045) take; a fixed 6,000 ms answer held it only while they fitted.
    ctx = await startRun(dir, { mcp_tool_timeout_ms: 120000 }, { FAKE_ANSWER_DELAY_MS: '6000', FAKE_FOLD: '1', FAKE_ANSWER_GATE_FILE: `${dir}/orch.gate` });
    process.env.FAKE_ANSWER_DELAY_MS = '300'; // the worker's own turn, inherited at spawn
    const row = await ctx.m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' });
    delete process.env.FAKE_ANSWER_DELAY_MS;
    spawnedPids.push({ pid: row.pid, created: row.pid_created });

    // w1's own turn ends inside the orchestrator's held answer, so its wake is written
    // while the orchestrator is still mid-turn and, FAKE_FOLD=1, folded into it rather than started as
    // a turn of its own — exactly the shape an interrupt must cancel rather than let complete.
    const turned = await waitUntil(async () => {
      const w = await ctx.core.worker.get({ worker_id: 'w1' });
      return w && w.turns === 1 ? w : null;
    }, 10000, 100);
    assert.ok(turned, "w1's own first turn never landed in the store");
    await sleep(600); // the poll (300 ms) has had a chance to see it and write the wake

    const p = await cliAsync(['pause', ctx.runId], ctx.dataDir);
    assert.strictEqual(p.status, 0, `${p.stdout} / ${p.stderr}`);
    await cliAsync(['stop', ctx.runId], ctx.dataDir); // end the run outright; only the final wakes[] matter here

    const exited = await waitForExit(ctx.cliProc.proc, 20000);
    assert.ok(exited, 'the CLI did not exit after stop');
    const receipt = receiptOf(ctx.cliProc, exited.code === 0 ? 0 : 1);
    const w1wake = (receipt.wakes || []).find((w) => w.worker_id === 'w1');
    assert.ok(w1wake, `no wake recorded for w1: ${JSON.stringify(receipt.wakes)}`);
    assert.strictEqual(w1wake.answered_by, 'command_lifecycle_cancelled');
    assert.notStrictEqual(w1wake.expired, true, 'the cancelled lifecycle must answer it, not the 120,000 ms expiry');
  } finally { await teardown({ ...ctx, spawnedPids, dir }); }
});

// ================================================================ (s9)

test('run pause and resume: an ended run, no owner, an owner with no run control and an unknown id each exit 1 naming the fact, and a run resume with --message exits 2', async () => {
  const dir = sandbox();
  let ctx;
  try {
    // an ended run: no workers at all, so the ordinary idle rule closes it almost at once.
    // the run's owner vouches for this test by its process before it binds it (ADR 0045): the first answer waits for the gate, written once the setup is done
    ctx = await startRun(dir, {}, { FAKE_ANSWER_DELAY_MS: '200', FAKE_ANSWER_GATE_FILE: `${dir}/orch.gate` });
    fs.writeFileSync(`${dir}/orch.gate`, '');
    const asWorker = await openCore({ dataDir: ctx.dataDir, caller: { role: 'worker', worker_id: 'w1', run_id: ctx.runId, pid: process.pid } }); // plant (ix): worker refused
    try { for (const m of ['run.pause', 'run.resume']) await assert.rejects(asWorker.control(m, { run_id: ctx.runId }), (e) => { assert.ok(['E_ROLE', 'E_UNBOUND'].includes(e.code), e.code); return true; }); } finally { await asWorker.close(); }
    const exited = await waitForExit(ctx.cliProc.proc, 15000);
    assert.ok(exited, 'the run never ended on its own');
    await ctx.control.close(); await ctx.m.shutdown(); ctx.control = null; ctx.m = null;

    const p = await cliAsync(['pause', ctx.runId], ctx.dataDir);
    assert.strictEqual(p.status, 1, `${p.stdout} / ${p.stderr}`);
    assert.strictEqual(p.receipt.paused, false);
    assert.match(p.receipt.reason, /already ended/);
    assert.ok(p.receipt.ended_at != null);

    const resumeMsg = await cliAsync(['resume', ctx.runId, '--message', 'x'], ctx.dataDir);
    assert.strictEqual(resumeMsg.status, 2, `${resumeMsg.stdout} / ${resumeMsg.stderr}`);

    // unknown id: neither a worker nor a run.
    const unknown = await cliAsync(['pause', 'no-such-id-at-all'], ctx.dataDir);
    assert.strictEqual(unknown.status, 1, `${unknown.stdout} / ${unknown.stderr}`);
    assert.match(unknown.receipt.reason, /no run has id no-such-id-at-all either/);

    // a run row that exists, is not ended, but whose owner.lock names a now-dead pid: E_NO_OWNER.
    const deadRunId = 'run-dead-owner';
    const script = [
      `const { openCore } = require(${JSON.stringify(`${ROOT}/src/core/index.cjs`)});`,
      `(async () => {`,
      `  const core = await openCore({ dataDir: ${JSON.stringify(ctx.dataDir)}, caller: { role: 'operator', run_id: ${JSON.stringify(deadRunId)}, pid: process.pid } });`,
      `  await core.run.attach({ adapter_pid: process.pid });`,
      `  process.exit(0);`,
      `})();`,
    ].join('\n');
    spawnSync(process.execPath, ['-e', script], { cwd: ROOT, windowsHide: true });
    const noOwner = await cliAsync(['pause', deadRunId], ctx.dataDir);
    assert.strictEqual(noOwner.status, 1, `${noOwner.stdout} / ${noOwner.stderr}`);
    assert.strictEqual(noOwner.receipt.error.code, 'E_NO_OWNER', JSON.stringify(noOwner.receipt));

    // an owner alive but registering no run.pause control: this test process itself becomes the owner
    // (the first write on a data dir with none) with no controls at all.
    const headlessRunId = 'run-headless';
    const headlessCore = await openCore({ dataDir: ctx.dataDir, caller: { role: 'operator', run_id: headlessRunId, pid: process.pid } });
    try {
      await headlessCore.run.attach({ adapter_pid: process.pid });
      const noControl = await cliAsync(['pause', headlessRunId], ctx.dataDir);
      assert.strictEqual(noControl.status, 1, `${noControl.stdout} / ${noControl.stderr}`);
      assert.match(noControl.receipt.reason, /a run pause exists only for a headless run/);
    } finally {
      if (headlessCore.isOwner()) { try { await headlessCore.shutdownOwner(); } catch { /* best effort */ } }
      await headlessCore.close();
    }
  } finally { await teardown({ ...ctx, spawnedPids: [], dir }); }
});

// ================================================================ (s10) — design item 1, no run-level pause

test('run: a worker parked alone holds the idle close, the hold names it as parked, and a stop of that worker lets the run end', async () => {
  const dir = sandbox();
  const spawnedPids = [];
  let ctx;
  try {
    // The orchestrator's prompt turn is held until w1 is mid-turn (as in s2): a fixed 300 ms answer could let
    // the idle rule close the run before a slow spawn landed.
    const gate = `${dir}/orchestrator-gate`;
    ctx = await startRun(dir, {}, { FAKE_ANSWER_DELAY_MS: '300', FAKE_ANSWER_GATE_FILE: gate });
    // Build step E1 (finding F): the worker's own stated 5,000 ms turn, so the pause lands mid-turn by
    // construction rather than by a slow turn end.
    process.env.FAKE_ANSWER_DELAY_MS = '5000';
    const row = await ctx.m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' });
    process.env.FAKE_ANSWER_DELAY_MS = '300';
    spawnedPids.push({ pid: row.pid, created: row.pid_created });
    fs.writeFileSync(gate, '');
    const idle = await waitUntil(() => {
      try { return /"type":"result"/.test(fs.readFileSync(`${ctx.orchestratorDir}/stream.jsonl`, 'utf8')); } catch { return false; }
    }, 4000, 25);
    assert.ok(idle, "the orchestrator's turn never ended once the gate opened");
    assert.strictEqual(ctx.m._worker('w1').turnEnded, false, 'precondition: w1 is mid-turn when it is paused');

    const p = await cliAsync(['pause', 'w1'], ctx.dataDir); // the worker form: no run-level pause at all
    assert.strictEqual(p.status, 0, `${p.stdout} / ${p.stderr}`);

    await sleep(1500); // several poll cycles: the run must still be open, held by the parked worker alone
    assert.strictEqual(ctx.cliProc.proc.exitCode, null, 'a worker parked alone must hold the run open');

    const stop = await cliAsync(['worker', 'stop', 'w1'], ctx.dataDir);
    assert.strictEqual(stop.status, 0, `${stop.stdout} / ${stop.stderr}`);

    const exited = await waitForExit(ctx.cliProc.proc, 20000);
    assert.ok(exited, 'the run never closed once the parked worker was stopped');
    assert.strictEqual(exited.code, 0, `stdout: ${ctx.cliProc.stdout}, stderr: ${ctx.cliProc.stderr}`);
    const receipt = receiptOf(ctx.cliProc, 0);
    assert.ok(
      receipt.holds.some((h) => Array.isArray(h.parked) && h.parked.includes('w1')),
      `no hold named w1 as parked: ${JSON.stringify(receipt.holds)}`
    );
    assert.match(receipt.ended_by, /no worker mid-turn; stdin closed/);
  } finally { await teardown({ ...ctx, spawnedPids, dir }); }
});
