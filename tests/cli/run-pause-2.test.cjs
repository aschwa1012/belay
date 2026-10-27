'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// run-pause-2.test.cjs — build step 6f-2, design items 1,
// 2 and 3: a worker whose park is in progress holds the idle close, named under `live` (s12); a run
// pause/resume refuse a run that is finishing for any reason, naming that (s13); a run resume derives
// exactly the workers it parked from the rows, across a worker-form resume and a second pause (s11).
// tests/cli/run-pause.test.cjs stays under its own 450-line budget with (s2) only, so these three go
// here instead, sharing its own scaffolding (tests/cli/run-wake.test.cjs's, via stop-helpers.cjs).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const {
  ROOT, CLI, sleep, sandbox, cleanup, waitUntil, waitForExit, makeSpec, runCli, receiptOf, connectOrchestratorCore,
} = require('./stop-helpers.cjs');
const { createRunManager, createWorkerControl } = require('../../src/run/index.cjs');
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
// that subprocess's own `run.attach` named `adapter_pid` — its own (tests/cli/run-pause.test.cjs's own).
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
  delete process.env.FAKE_IGNORE_STDIN_END;
  if (cliProc && cliProc.proc.exitCode === null && runId && dataDir) { try { await cliAsync(['stop', runId], dataDir); } catch { /* best effort */ } await waitForExit(cliProc.proc, 8000); }
  if (control) { try { await control.close(); } catch { /* best effort */ } }
  if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
  for (const p of spawnedPids || []) require('../crash.cjs').crash(p.pid, p.created); // the row's own creation time, or no signal (ADR 0039)
  if (core) { try { await core.close(); } catch { /* best effort */ } }
  if (cliProc && cliProc.proc.exitCode === null) { try { await P.killTree(cliProc.proc); } catch { /* best effort */ } }
  cleanup(dir);
}

// ================================================================ (s11)

test('run resume: relaunches exactly the workers this run pause parked, derived from the rows, across a worker-form resume and a second pause', async () => {
  const dir = sandbox();
  const spawnedPids = [];
  let ctx;
  try {
    // The orchestrator's own prompt turn stays open past every step here, so the idle-close rule never
    // gets a chance to end the run on its own (run-pause.test.cjs's own s3/s6 precedent).
    ctx = await startRun(dir, {}, { FAKE_ANSWER_DELAY_MS: '8000' });
    const r1 = await ctx.m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' });
    const r2 = await ctx.m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w2'), prompt: 'hello', worker_id: 'w2' });
    spawnedPids.push({ pid: r1.pid, created: r1.pid_created }, { pid: r2.pid, created: r2.pid_created });
    await sleep(400);

    const p1 = await cliAsync(['pause', ctx.runId], ctx.dataDir); // run pause 1: parks w1 and w2
    assert.strictEqual(p1.status, 0, `${p1.stdout} / ${p1.stderr}`);
    assert.strictEqual(p1.receipt.workers.length, 2, JSON.stringify(p1.receipt));

    const wr1 = await cliAsync(['resume', 'w1'], ctx.dataDir); // worker-form resume of w1, bypassing the run control
    assert.strictEqual(wr1.status, 0, `${wr1.stdout} / ${wr1.stderr}`);

    const r1r = await cliAsync(['resume', ctx.runId], ctx.dataDir); // run resume 1: only w2 is still paused
    assert.strictEqual(r1r.status, 0, `${r1r.stdout} / ${r1r.stderr}`);
    assert.deepStrictEqual(r1r.receipt.workers_resumed.map((w) => w.worker_id), ['w2']);
    assert.deepStrictEqual(r1r.receipt.left_parked, []);

    const wp1 = await cliAsync(['pause', 'w1'], ctx.dataDir); // w1 paused again by hand, ahead of the next run pause
    assert.strictEqual(wp1.status, 0, `${wp1.stdout} / ${wp1.stderr}`);

    const p2 = await cliAsync(['pause', ctx.runId], ctx.dataDir); // run pause 2: only w2 is live now
    assert.strictEqual(p2.status, 0, `${p2.stdout} / ${p2.stderr}`);
    assert.deepStrictEqual(p2.receipt.already_parked, ['w1']);
    assert.deepStrictEqual(p2.receipt.workers.map((w) => w.worker_id), ['w2']);

    const r2r = await cliAsync(['resume', ctx.runId], ctx.dataDir); // run resume 2: must relaunch only w2
    assert.strictEqual(r2r.status, 0, `${r2r.stdout} / ${r2r.stderr}`);
    assert.deepStrictEqual(r2r.receipt.workers_resumed.map((w) => w.worker_id), ['w2']);
    const leftW1 = r2r.receipt.left_parked.find((w) => w.worker_id === 'w1');
    assert.ok(leftW1 && leftW1.already_parked, `w1 must be left parked, not relaunched: ${JSON.stringify(r2r.receipt.left_parked)}`);

    const w1 = await ctx.core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(w1.state, 'paused', 'w1 must still read paused: this run resume must never have relaunched it');
  } finally { await teardown({ ...ctx, spawnedPids, dir }); }
});

// ================================================================ (s12)

test('run: a worker whose park is in progress (row stopping, pid live) holds the idle close, named under live', async () => {
  const dir = sandbox();
  const spawnedPids = [];
  let ctx;
  try {
    // The orchestrator's prompt turn is held until the gate file exists, so it goes idle only once w1's row
    // reads stopping. A fixed answer delay raced the park: an idle-running w1 (deliberately not a hold) let
    // the idle rule close the run before a slow park's stopping row landed.
    const gate = `${dir}/orchestrator-gate`;
    ctx = await startRun(dir, {}, { FAKE_ANSWER_GATE_FILE: gate });
    process.env.FAKE_IGNORE_STDIN_END = '1'; // this worker never exits on stdin close: its own park hangs at 'stopping'
    const row = await ctx.m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' });
    spawnedPids.push({ pid: row.pid, created: row.pid_created });
    delete process.env.FAKE_IGNORE_STDIN_END;
    await sleep(300);

    // The park's stopping row is stalled 1,500 ms, as a slow runner lands it; the gate makes that harmless.
    const write = ctx.core.worker.write.bind(ctx.core.worker);
    ctx.core.worker.write = async (r) => { if (r.state === 'stopping') await sleep(1500); return write(r); };
    const pauseP = ctx.m.pause({ worker_id: 'w1', by: 'operator:1', interrupt_timeout_ms: 500, exit_timeout_ms: 8000 });
    const midRow = await waitUntil(async () => {
      const w = await ctx.core.worker.get({ worker_id: 'w1' });
      return w.state === 'stopping' ? w : null;
    }, 8000, 100);
    assert.ok(midRow, "w1's row never reached stopping");
    assert.strictEqual(midRow.pid_alive, true);
    assert.strictEqual(ctx.cliProc.proc.exitCode, null, 'the run closed before the orchestrator went idle');

    fs.writeFileSync(gate, ''); // the orchestrator now ends its turn, with w1 mid-park (the fake ignores the close)
    const turnEnded = await waitUntil(() => {
      try { return /"type":"result"/.test(fs.readFileSync(`${ctx.orchestratorDir}/stream.jsonl`, 'utf8')); } catch { return false; }
    }, 8000, 25);
    assert.ok(turnEnded, "the orchestrator's turn never ended once the gate opened");
    await sleep(400); // a 300 ms poll cycle of an idle orchestrator has had time to see the stopping row
    assert.strictEqual(ctx.cliProc.proc.exitCode, null, 'a worker mid-park must hold the run open, named under live');

    const paused = await pauseP; // the kill fallback lands at ~8,000 ms
    assert.strictEqual(paused.paused, true);

    const stop = await cliAsync(['worker', 'stop', 'w1'], ctx.dataDir); // lets the run end (run-pause.test.cjs's s10)
    assert.strictEqual(stop.status, 0, `${stop.stdout} / ${stop.stderr}`);

    const exited = await waitForExit(ctx.cliProc.proc, 20000);
    assert.ok(exited, 'the run never closed once the parked worker was stopped');
    const receipt = receiptOf(ctx.cliProc, exited.code === 0 ? 0 : 1);
    assert.ok(
      receipt.holds.some((h) => Array.isArray(h.live) && h.live.includes('w1')),
      `no hold named w1 as live: ${JSON.stringify(receipt.holds)}`
    );
  } finally { delete process.env.FAKE_IGNORE_STDIN_END; await teardown({ ...ctx, spawnedPids, dir }); }
});

// ================================================================ (s13)

test('run pause and resume: a run whose stdin the timeout or idle rule has closed refuses both naming finishing, and the CLI exits 1', async () => {
  const dir = sandbox();
  let ctx;
  try {
    // No worker at all: the orchestrator's own prompt turn ends quickly and the idle rule closes stdin
    // almost at once (run-pause.test.cjs's own s9 precedent). FAKE_IGNORE_STDIN_END keeps the process
    // alive past that close, inside close_grace_ms, so `state.finishing` is true well before the child's
    // own exit event lands — review 2's own window (blocking finding, orchestrator.cjs:308's sibling).
    // The prompt turn waits for a gate written once the setup is done, and the test waits for the stdin close itself (the fake's
    // marker file), not a fixed sleep: the setup and each command below are vouched for by the owner's operator check (ADR 0045),
    // about a second each and more on a loaded host, so the close-grace window starts at the close and holds both, sent together.
    const gate = `${dir}/orch.gate`; const closed = `${dir}/stdin-closed`;
    ctx = await startRun(dir, { close_grace_ms: 10000 }, { FAKE_ANSWER_DELAY_MS: '200', FAKE_IGNORE_STDIN_END: '1', FAKE_ANSWER_GATE_FILE: gate, FAKE_STDIN_END_FILE: closed });
    fs.writeFileSync(gate, '');
    assert.ok(await waitUntil(() => fs.existsSync(closed), 15000, 25), "the idle rule never closed the orchestrator's stdin");

    const [p, r] = await Promise.all([cliAsync(['pause', ctx.runId], ctx.dataDir), cliAsync(['resume', ctx.runId], ctx.dataDir)]);
    assert.strictEqual(p.status, 1, `${p.stdout} / ${p.stderr}`);
    assert.strictEqual(p.receipt.paused, false);
    assert.match(p.receipt.reason, /finishing/);

    assert.strictEqual(r.status, 1, `${r.stdout} / ${r.stderr}`);
    assert.strictEqual(r.receipt.resumed, false);
    assert.match(r.receipt.reason, /finishing/);

    const exited = await waitForExit(ctx.cliProc.proc, 25000);
    assert.ok(exited, 'the run never exited after its own close-grace kill');
  } finally { await teardown({ ...ctx, spawnedPids: [], dir }); }
});

// build step 6i item 5 (C13, second half): the same refusal, for an explicit `run.stop` in flight, not
// only for a run finishing on its own. Before this fix, `run.pause`/`run.resume` answered `E_BUSY
// {op:'stop'}` here instead (pause.cjs and stop.cjs's own `handle` gate every other way of finishing by
// `finishing()`; this call site was the one left out).
test('run pause and resume: a run.stop in flight refuses both naming finishing, not E_BUSY, and the CLI exits 1', async () => {
  const dir = sandbox();
  let ctx;
  try {
    // The orchestrator is kept mid prompt-turn throughout (a gate nothing writes), and its own stdin close is ignored, so only the
    // stop's own close_grace_ms kill ever ends it. The stop is known to be in flight once the orchestrator's stdin has closed (the
    // fake's marker file), not after a fixed sleep: the stop, the pause and the resume are each vouched for by the owner's operator
    // check (ADR 0045), about a second each and more on a loaded host, so the window starts at the close and holds the two, sent together.
    const closed = `${dir}/stdin-closed`;
    ctx = await startRun(dir, { close_grace_ms: 10000 }, { FAKE_ANSWER_DELAY_MS: '8000', FAKE_IGNORE_STDIN_END: '1', FAKE_ANSWER_GATE_FILE: `${dir}/orch.gate`, FAKE_STDIN_END_FILE: closed });

    const stopP = cliAsync(['stop', ctx.runId], ctx.dataDir);
    assert.ok(await waitUntil(() => fs.existsSync(closed), 30000, 25), "the stop never closed the orchestrator's stdin");
    assert.strictEqual(ctx.cliProc.proc.exitCode, null, 'the run must not have exited on its own yet');

    const [p, r] = await Promise.all([cliAsync(['pause', ctx.runId], ctx.dataDir), cliAsync(['resume', ctx.runId], ctx.dataDir)]);
    assert.strictEqual(p.status, 1, `${p.stdout} / ${p.stderr}`);
    assert.strictEqual(p.receipt.paused, false);
    assert.strictEqual(p.receipt.error && p.receipt.error.code, 'E_NOT_FOUND', JSON.stringify(p.receipt));
    assert.match(p.receipt.reason, /finishing/);

    assert.strictEqual(r.status, 1, `${r.stdout} / ${r.stderr}`);
    assert.strictEqual(r.receipt.error && r.receipt.error.code, 'E_NOT_FOUND', JSON.stringify(r.receipt));
    assert.match(r.receipt.reason, /finishing/);

    await stopP;
    const exited = await waitForExit(ctx.cliProc.proc, 25000);
    assert.ok(exited, 'the run never exited after the stop\'s own close-grace kill');
  } finally { await teardown({ ...ctx, spawnedPids: [], dir }); }
});
