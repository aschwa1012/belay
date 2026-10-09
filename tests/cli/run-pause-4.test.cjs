'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// run-pause-4.test.cjs — build step 6i-2, design item 1,
// ADR 0023 amendment 4: `run.resume` matches its parks by equality with the run row's own recorded
// `pause_parks`, never by comparing this run process's own clock with the worker adapter's. (h8) to
// (h11) drive `createRunPauseControl` directly against fake collaborators, as run-pause-3.test.cjs's
// (h3)/(h4) already do — no process, no store, deterministic.

const { test } = require('node:test');
const assert = require('node:assert');

const { createRunPauseControl } = require('../../src/run/run-pause.cjs');
const { renderRunResumeText, resumeHadErrors } = require('../../src/cli/cmd-pause.cjs');

// A fake `core.run` that, unlike run-pause-3.test.cjs's own (which predates `parks`), persists
// `pause_parks` the way the real store does: an object once written with `paused: true`, `null` once
// cleared — so these tests exercise the equality path itself, matching `doResume`'s own rule (fix-up
// (a)): the run row alone, never an in-memory fallback (item f: stale reference to a removed one, fixed).
function makeFakeRun(runId) {
  const workers = new Map();
  let run = { id: runId, paused_at: null, paused_by: null, pause_parks: null, ended_at: null };
  const core = {
    run: {
      async get() { return { run }; },
      async setPaused({ paused, at, by, parks }) {
        run = {
          ...run,
          paused_at: paused ? at : null,
          paused_by: paused ? by : null,
          pause_parks: paused ? (parks !== undefined ? parks : run.pause_parks) : null,
        };
        return run;
      },
    },
    worker: { async list() { return { workers: [...workers.values()] }; } },
  };
  return { core, workers, setWorker: (id, row) => workers.set(id, { id, ...row }) };
}

function fakeHook() {
  return { exited: () => false, finishing: () => false, pause: async () => ({ interrupt: { sent: false }, timeout: null }), resume: async (by, line) => ({ held: [], line, timeout: null }) };
}

function fakeResumeWorker(workers) {
  return async (id) => {
    const w = workers.get(id);
    workers.set(id, { ...w, state: 'running', paused_by: null, paused_at: null });
    return { success: true, receipt: { worker_id: id, resumed: true } };
  };
}

// ================================================================ (h8)
// C4/C5, Q1 (src/run/resume-set.cjs): the fake `pauseWorker` answers with `paused_at` equal to the run's
// own `at` minus 5 — deterministic skew a `paused_at >= run.paused_at` comparison (6i's withdrawn rule)
// would reject, but equality with the *recorded* pair (which is this very stamp) always accepts.
test('run resume: a worker this pause parked whose own stamp reads earlier than the run\'s is resumed', async () => {
  const { core, workers, setWorker } = makeFakeRun('run-h8');
  setWorker('w1', { run_id: 'run-h8', substrate: 'claude-code', state: 'running', pid_alive: true });
  const control = createRunPauseControl({
    runId: 'run-h8', core, hook: fakeHook(),
    pauseWorker: async (id, caller) => {
      const { run } = await core.run.get();
      const paused_at = run.paused_at - 5;
      const paused_by = `${caller.role}:${caller.pid}`;
      workers.set(id, { ...workers.get(id), state: 'paused', paused_by, paused_at });
      return { success: true, worker_id: id, paused: true, already: false, paused_at, paused_by };
    },
    resumeWorker: fakeResumeWorker(workers), stopInFlight: () => false,
  });

  const pauseResult = await control.pause({ run_id: 'run-h8', caller: { role: 'operator', pid: 1 } });
  assert.deepStrictEqual(pauseResult.workers.map((w) => w.worker_id), ['w1']);
  assert.ok(pauseResult.run.pause_parks.parked[0].paused_at < pauseResult.run.paused_at, 'the fake must make the skew real, not merely equal');

  const resumeResult = await control.resume({ run_id: 'run-h8', caller: { role: 'operator', pid: 1 } });
  assert.deepStrictEqual(resumeResult.workers_resumed.map((w) => w.worker_id), ['w1']);
  assert.deepStrictEqual(resumeResult.left_parked, []);
  assert.strictEqual(workers.get('w1').state, 'running');
});

// ================================================================ (h9)
// Q5: a row in none of the three recorded lists is `not_this_pause`, never `re_paused` — w2 is set up
// directly on the workers map after the pause, as a worker spawned afterwards and hand-paused by a
// different identity would be, with no entry of its own in this pause's `pause_parks`.
test('run resume: a worker spawned after the pause and paused by another identity is named not_this_pause', async () => {
  const { core, workers, setWorker } = makeFakeRun('run-h9');
  const control = createRunPauseControl({
    runId: 'run-h9', core, hook: fakeHook(),
    pauseWorker: async () => { throw new Error('no live worker at pause time; must not be called'); },
    resumeWorker: fakeResumeWorker(workers), stopInFlight: () => false,
  });

  const pauseResult = await control.pause({ run_id: 'run-h9', caller: { role: 'operator', pid: 1 } });
  assert.deepStrictEqual(pauseResult.workers, []);
  setWorker('w2', { run_id: 'run-h9', substrate: 'claude-code', state: 'paused', paused_by: 'operator:9999', paused_at: Date.now() });

  const resumeResult = await control.resume({ run_id: 'run-h9', caller: { role: 'operator', pid: 1 } });
  assert.deepStrictEqual(resumeResult.workers_resumed, []);
  const w2Left = resumeResult.left_parked.find((w) => w.worker_id === 'w2');
  assert.ok(w2Left && w2Left.not_this_pause === true, `w2 must be named not_this_pause: ${JSON.stringify(w2Left)}`);
  assert.strictEqual(workers.get('w2').state, 'paused');
});

// ================================================================ (h10)
// Q3: a failed park call is recorded in `pause_parks.unconfirmed` (the adapter may still have acted, per
// amendment 4's own note, so the row is left `paused`); the resume leaves it parked `park_unconfirmed`
// and the CLI's own exit-code rule (cmd-pause.cjs's `resumeHadErrors`) reads 1, as for an `error` entry.
test('run resume: a park whose call timed out is left parked as park_unconfirmed, and the CLI exits 1', async () => {
  const { core, workers, setWorker } = makeFakeRun('run-h10');
  setWorker('w1', { run_id: 'run-h10', substrate: 'claude-code', state: 'running', pid_alive: true });
  const control = createRunPauseControl({
    runId: 'run-h10', core, hook: fakeHook(),
    pauseWorker: async (id) => {
      // the adapter's own call timed out, but it had already written the row paused (amendment 4's note).
      workers.set(id, { ...workers.get(id), state: 'paused', paused_by: 'operator:1', paused_at: 777 });
      return { success: false, error: { code: 'E_TIMEOUT', message: `worker ${id} pause did not confirm within its bound` } };
    },
    resumeWorker: fakeResumeWorker(workers), stopInFlight: () => false,
  });

  const pauseResult = await control.pause({ run_id: 'run-h10', caller: { role: 'operator', pid: 1 } });
  assert.deepStrictEqual(pauseResult.not_paused.map((w) => w.worker_id), ['w1']);
  assert.deepStrictEqual(pauseResult.run.pause_parks.unconfirmed, ['w1']);

  const resumeResult = await control.resume({ run_id: 'run-h10', caller: { role: 'operator', pid: 1 } });
  const w1Left = resumeResult.left_parked.find((w) => w.worker_id === 'w1');
  assert.ok(w1Left && w1Left.park_unconfirmed === true, `w1 must be named park_unconfirmed: ${JSON.stringify(w1Left)}`);
  assert.strictEqual(workers.get('w1').state, 'paused', 'a park_unconfirmed worker must never have been relaunched');

  assert.strictEqual(resumeHadErrors(resumeResult), true, "cmd-pause.cjs's own exit-code rule must read this a failure");
  const text = renderRunResumeText({ run_id: 'run-h10', resumed: true, ...resumeResult });
  assert.match(text, /worker w1: left parked \(this pause's park was not confirmed; try belay resume w1\)/, text);
});

// ================================================================ (h11)
// Q2: a receipt with `already: true` is recorded in `pause_parks.already_parked`, never `parked` — w1
// was live at listing time but had already been paused (by another identity) by the time the call
// landed, so the adapter answers `already: true` with the row that already existed.
test('run resume: a park answered already: true is recorded as already parked and stays parked', async () => {
  const { core, workers, setWorker } = makeFakeRun('run-h11');
  setWorker('w1', { run_id: 'run-h11', substrate: 'claude-code', state: 'running', pid_alive: true });
  const control = createRunPauseControl({
    runId: 'run-h11', core, hook: fakeHook(),
    pauseWorker: async (id) => {
      const paused_at = 500; const paused_by = 'other:1';
      workers.set(id, { ...workers.get(id), state: 'paused', paused_by, paused_at });
      return { success: true, worker_id: id, paused: true, already: true, paused_at, paused_by };
    },
    resumeWorker: fakeResumeWorker(workers), stopInFlight: () => false,
  });

  const pauseResult = await control.pause({ run_id: 'run-h11', caller: { role: 'operator', pid: 1 } });
  assert.deepStrictEqual(pauseResult.run.pause_parks.parked, []);
  assert.deepStrictEqual(pauseResult.run.pause_parks.already_parked, [{ worker_id: 'w1', paused_at: 500, paused_by: 'other:1' }]);

  const resumeResult = await control.resume({ run_id: 'run-h11', caller: { role: 'operator', pid: 1 } });
  assert.deepStrictEqual(resumeResult.workers_resumed, []);
  const w1Left = resumeResult.left_parked.find((w) => w.worker_id === 'w1');
  assert.ok(w1Left && w1Left.already_parked === true, `w1 must be named already_parked: ${JSON.stringify(w1Left)}`);
  assert.strictEqual(workers.get('w1').state, 'paused', 'w1 must stay parked, never relaunched');
});

// ================================================================ (h17)
// Blocking (R-review; item a): `pairFor` must record each park's own receipt pair, never a fresh row
// re-read — a hand resume and re-pause of w1 by another identity, landing while w2's own park call is
// still in flight, would otherwise show that later row and relaunch w1. Built on a reviewer's probe.
test('run resume: a worker this pause parked, then resumed and re-paused by another identity while later parks ran, stays parked and is named re_paused', async () => {
  const { core, workers, setWorker } = makeFakeRun('run-h17');
  setWorker('w1', { run_id: 'run-h17', substrate: 'claude-code', state: 'running', pid_alive: true });
  setWorker('w2', { run_id: 'run-h17', substrate: 'claude-code', state: 'running', pid_alive: true });
  const control = createRunPauseControl({
    runId: 'run-h17', core, hook: fakeHook(),
    pauseWorker: async (id, caller) => {
      const paused_at = 1000 + (id === 'w2' ? 10 : 0);
      const paused_by = `${caller.role}:${caller.pid}`;
      workers.set(id, { ...workers.get(id), state: 'paused', paused_by, paused_at });
      // while w2's own park call is still running, a hand resume + re-pause of w1 by another identity lands.
      if (id === 'w2') workers.set('w1', { ...workers.get('w1'), state: 'paused', paused_by: 'operator:777', paused_at: 2500 });
      return { success: true, worker_id: id, paused: true, already: false, paused_at, paused_by };
    },
    resumeWorker: fakeResumeWorker(workers), stopInFlight: () => false,
  });

  const pauseResult = await control.pause({ run_id: 'run-h17', caller: { role: 'operator', pid: 1 } });
  assert.deepStrictEqual(pauseResult.run.pause_parks.parked, [
    { worker_id: 'w1', paused_at: 1000, paused_by: 'operator:1' },
    { worker_id: 'w2', paused_at: 1010, paused_by: 'operator:1' },
  ], 'the recorded pair must be each receipt\'s own, not a later row a hand re-pause overwrote');

  const resumeResult = await control.resume({ run_id: 'run-h17', caller: { role: 'operator', pid: 1 } });
  assert.deepStrictEqual(resumeResult.workers_resumed.map((w) => w.worker_id), ['w2']);
  const w1Left = resumeResult.left_parked.find((w) => w.worker_id === 'w1');
  assert.ok(w1Left && w1Left.re_paused === true, `w1 must be named re_paused, never relaunched: ${JSON.stringify(w1Left)}`);
  assert.strictEqual(workers.get('w1').state, 'paused');
});

// ================================================================ (h20)
// Regression (found in a second review): a hand pause by another identity, in
// flight when the run pause's own `pauseWorker` call for the same worker reaches it, shares that
// operation (lifecycle.cjs's `runOp` shares a same-name op's promise) — the run pause receives the hand
// pause's own receipt back: `success: true`, `already: false`, `paused_by` the other identity, never this
// pause's own `by`. `buildParks` must not read `already: false` alone as "this pause's own park": a
// successful receipt whose `paused_by` differs from doPause's own `by` belongs in `already_parked` with
// the receipt's own pair, never in `parked` (src/run/resume-set.cjs `buildParks`).
test('run resume: a hand pause by another identity sharing the run pause\'s park call is recorded as already parked and stays parked', async () => {
  const { core, workers, setWorker } = makeFakeRun('run-h20');
  setWorker('w1', { run_id: 'run-h20', substrate: 'claude-code', state: 'running', pid_alive: true });
  const control = createRunPauseControl({
    runId: 'run-h20', core, hook: fakeHook(),
    // the shared op's own receipt: success, not already, but `paused_by` the *other* identity — never
    // this pause's own caller below — exactly as a shared runOp promise answers both callers alike.
    pauseWorker: async (id) => {
      const paused_at = 777000; const paused_by = 'operator:777';
      workers.set(id, { ...workers.get(id), state: 'paused', paused_by, paused_at });
      return { success: true, worker_id: id, paused: true, already: false, paused_at, paused_by };
    },
    resumeWorker: fakeResumeWorker(workers), stopInFlight: () => false,
  });

  const pauseResult = await control.pause({ run_id: 'run-h20', caller: { role: 'run', pid: 1 } });
  assert.deepStrictEqual(pauseResult.run.pause_parks.parked, [], 'a receipt from another identity must never be recorded as this pause\'s own park');
  assert.deepStrictEqual(pauseResult.run.pause_parks.already_parked, [{ worker_id: 'w1', paused_at: 777000, paused_by: 'operator:777' }]);

  const resumeResult = await control.resume({ run_id: 'run-h20', caller: { role: 'run', pid: 1 } });
  assert.deepStrictEqual(resumeResult.workers_resumed, []);
  const w1Left = resumeResult.left_parked.find((w) => w.worker_id === 'w1');
  assert.ok(w1Left && w1Left.already_parked === true, `w1 must be named already_parked: ${JSON.stringify(w1Left)}`);
  assert.strictEqual(workers.get('w1').state, 'paused', 'w1 must stay parked, never relaunched by the run resume');
});
