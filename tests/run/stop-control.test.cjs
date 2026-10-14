'use strict';
// stop-control.test.cjs — build step 5c-2, Done item 2.
// Drives createStopControl in-process against tests/run/fake-core.cjs (a worker.list planted onto the
// fake core's own object, never edited in the shared file) and a hand-built hook — no processes
// spawned. Covers two round-1 fixes that landed with no regression test (the stopT0-vs-phaseStart
// timestamp fix and the inFlight/exited reorder) and the round-2 fix this step adds (inFlight cleared
// on a rejected worker phase).

const test = require('node:test');
const assert = require('node:assert');

const { createStopControl } = require('../../src/run/stop.cjs');
const { createFakeCore } = require('./fake-core.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("stop control: ms_to_exit and every worker-phase timestamp measure from the stop's own t0, not the child's lifetime or the phase start", async () => {
  const STOP_DELAY_MS = 300;
  let exitedFacts = null;
  const hook = {
    pid: 4242,
    exited: () => exitedFacts,
    stop: async (reason) => {
      await sleep(STOP_DELAY_MS);
      exitedFacts = { pid: 4242, exit_code: 0, exit_signal: null, killed_after_close: false, ended_by: reason, ms: 987654 };
      return exitedFacts;
    },
  };
  const core = createFakeCore();
  // A dead pid: claimsLive(w) is true (state 'running') but pid_alive is false, so the worker phase's
  // first check finds nothing live and breaks at once — no kill, exactly the case this test wants — but
  // still runs the fixed 500 ms confirmation read (src/run/stop.cjs's own "read once more" step), which
  // is why the discriminating check below is relative to worker_phase_ms rather than a bare "< 300".
  core.worker.list = async () => ({ workers: [
    { id: 'w1', run_id: 'r1', state: 'running', pid: 999999, pid_alive: false, seq: 1,
      exit_code: null, exit_signal: null, death_established_by: null, mid_turn: 0 },
  ] });

  const sc = createStopControl({ runId: 'r1', core, closeGraceMs: 400 });
  sc.attach(hook);
  const receipt = await sc.handle({ run_id: 'r1', caller: { pid: 111 } });

  // The upper bound separates the stop's own t0 from the child's lifetime, which the stub reports as 987,654 ms; 1000 sat
  // 140 ms over what a hosted runner took for this whole test, so it is 30,000.
  assert.ok(receipt.orchestrator.ms_to_exit >= STOP_DELAY_MS && receipt.orchestrator.ms_to_exit < 30000,
    `ms_to_exit ${receipt.orchestrator.ms_to_exit} was not between ${STOP_DELAY_MS} and 30,000`);

  assert.strictEqual(receipt.workers.length, 1);
  const m = receipt.workers[0].established_by.match(/at (\d+) ms after the stop began/);
  assert.ok(m, `established_by did not match the expected shape: ${receipt.workers[0].established_by}`);
  const capturedMs = Number(m[1]);
  assert.ok(capturedMs >= STOP_DELAY_MS, `captured ${capturedMs} ms was under the stop delay of ${STOP_DELAY_MS} ms`);
  assert.ok(capturedMs <= receipt.ms, `captured ${capturedMs} ms exceeded the receipt's own total ms ${receipt.ms}`);
  // The discriminating check (evidence for the coder's revert below): measured from the stop's own t0,
  // the timestamp must lead worker_phase_ms — which measures only the worker phase itself — by roughly
  // the orchestrator phase's own duration (STOP_DELAY_MS). Measured from phaseStart instead (the
  // mutation), the two collapse to the same number, so this margin vanishes.
  assert.ok(capturedMs - receipt.worker_phase_ms >= STOP_DELAY_MS - 80,
    `captured ${capturedMs} ms did not lead worker_phase_ms ${receipt.worker_phase_ms} by roughly the stop delay — looks measured from phaseStart, not stopT0`);
  assert.ok(receipt.ms >= receipt.worker_phase_ms + STOP_DELAY_MS - 80,
    `total ms ${receipt.ms} did not account for both the orchestrator phase and the worker phase`);
});

test('stop control: a second handle during the worker phase returns the in-flight promise, and after completion is refused as ended naming the first caller', async () => {
  let exitedFacts = null;
  const hook = {
    pid: 5555,
    exited: () => exitedFacts, // turns non-null the instant stop() resolves, below
    stop: async (reason) => {
      await sleep(200);
      exitedFacts = { pid: 5555, exit_code: 0, exit_signal: null, killed_after_close: false, ended_by: reason, ms: 42 };
      return exitedFacts;
    },
  };
  const core = createFakeCore();
  core.worker.list = async () => ({ workers: [] });

  const sc = createStopControl({ runId: 'r1', core, closeGraceMs: 600 });
  sc.attach(hook);

  const p1 = sc.handle({ run_id: 'r1', caller: { pid: 222 } });
  // Past the 200 ms hook.stop() delay (so hook.exited() is already non-null, as it is for the whole of
  // a real worker phase) but well inside the ~700 ms doStop() itself still takes (the fixed 500 ms
  // confirmation sleep of an empty worker list) — the exact shape design item 1's comment describes.
  await sleep(300);
  const p2 = sc.handle({ run_id: 'r1', caller: { pid: 333 } }); // a different caller — still in flight
  assert.strictEqual(p2, p1, 'a second handle mid-flight did not return the exact same promise');
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(r2, r1, 'the two callers did not resolve to the same receipt object');
  assert.strictEqual(r1.caller_pid, 222, 'the completed receipt should still belong to the first caller');

  await assert.rejects(sc.handle({ run_id: 'r1', caller: { pid: 444 } }), (e) => {
    assert.strictEqual(e.code, 'E_NOT_FOUND');
    assert.strictEqual(e.detail.phase, 'ended');
    assert.strictEqual(e.detail.stopped_by.caller_pid, 222);
    assert.ok(Number.isFinite(e.detail.stopped_by.at_ms));
    return true;
  });
});

test('stop control: a rejected worker phase clears inFlight so the next handle attempts a fresh stop', async () => {
  let stopCalls = 0;
  const hook = {
    pid: 7777,
    exited: () => null, // deliberately never reports the orchestrator as exited in this test
    stop: async (reason) => {
      stopCalls += 1;
      return { pid: 7777, exit_code: 0, exit_signal: null, killed_after_close: false, ended_by: reason, ms: 9 };
    },
  };
  const core = createFakeCore();
  let listCalls = 0;
  core.worker.list = async () => {
    listCalls += 1;
    if (listCalls === 1) { const e = new Error('fake core: worker.list refused'); e.code = 'E_INTERNAL'; throw e; }
    return { workers: [] };
  };

  const sc = createStopControl({ runId: 'r1', core, closeGraceMs: 200 });
  sc.attach(hook);

  await assert.rejects(sc.handle({ run_id: 'r1', caller: { pid: 555 } }), (e) => e.code === 'E_INTERNAL');
  assert.strictEqual(stopCalls, 1);
  assert.strictEqual(await sc.settled(), null, 'settled() after a rejected stop should resolve null');

  const receipt = await sc.handle({ run_id: 'r1', caller: { pid: 666 } });
  assert.strictEqual(stopCalls, 2, "the hook's stop() was not called again on the fresh attempt");
  assert.strictEqual(receipt.caller_pid, 666);
  assert.strictEqual(await sc.settled(), receipt, 'settled() after the second, successful stop should resolve its receipt');
});
