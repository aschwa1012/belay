'use strict';
// park-6.test.cjs — build step 6i-2, design items 2, 5 and
// 7. (h12) and (h13) drive a real RunManager over tests/run/fakes/fake-claude.cjs, reading every row from
// the store (never built by hand), the way park-4.test.cjs's (r8)-(r10) do. (h15) drives worker.cjs's
// `attach` and exit.cjs's `settle` directly with a synthetic child (an EventEmitter with stdout/stderr),
// deterministic, no process — the shape park-4's rebuilt (r7) and park-5's (h6)/(h7) use. (h16) drives a
// real RunManager's `stop`, the way park-5.test.cjs's (h5) drives `resume`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { diffWorkers } = require('../../src/run/wake.cjs');
const { newWorkerRecord, attach } = require('../../src/run/worker.cjs');
const { settle, EXIT_CLOSE_BOUND_MS } = require('../../src/run/exit.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-park6-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}
function mgr(sb, core, runId) {
  return createRunManager({
    core, dataDir: sb.data, runId,
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
}
async function teardown({ m, sb }) {
  if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
  if (sb) cleanup(sb.data);
}
async function pollUntil(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

// ---------------------------------------------------------------- (h12)
// R2 (src/run/pause.cjs:148): the existing park-5 (h1)/(h1b) cases drive diffWorkers on rows built by
// hand, never the brief's own probe-swallow scenario (poll_ms 1000, a real run, m.pause at running with
// turns 1). This reproduces it against a real store: no source change is intended (park_turns already
// carries the park's own turns, 6i item 1); this is the regression test that scenario never had.
test('wake: a park records park_turns on its own stopping row, so a turn that ended before the park is reported', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const RUN = 'run-park6-h12';
  const m = mgr(sb, core, RUN);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });

    // Poll 0: the baseline a real orchestrator poll would already hold well before the turn ends.
    const rowAtStart = await core.worker.get({ worker_id: 'w1' });
    let prev = {};
    ({ next: prev } = diffWorkers({ prev, rows: [rowAtStart], runId: RUN, nowMs: 0, graceMs: 1500 }));

    // The turn ends on its own; the pause is sent the instant the row reads running with turns 1 — no
    // poll runs in between, so this adapter's own next poll sees only the fully-landed paused row,
    // exactly the race R2 names (poll_ms 1000, m.pause at running/turns:1).
    await m._waitTurn('w1', 8000);
    const rowAtPause = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(rowAtPause.state, 'running');
    assert.strictEqual(rowAtPause.turns, 1);

    await m.pause({ worker_id: 'w1', by: 'operator:1' });
    const finalRow = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(finalRow.state, 'paused');

    const { events } = diffWorkers({ prev, rows: [finalRow], runId: RUN, nowMs: 500, graceMs: 1500 });
    assert.strictEqual(events.length, 2, JSON.stringify(events));
    assert.strictEqual(events[0].event, 'turn_end');
    assert.strictEqual(events[0].turn, 1);
    assert.strictEqual(events[1].event, 'paused');
    assert.strictEqual(events[1].turn, 1);
    assert.strictEqual(events[1].paused_by, 'operator:1');
  } finally { await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (h13)
// R7 (src/run/worker.cjs:126): rowOf's own reset of park_turns on a starting/running row had no test —
// a later plain stop's row could carry a stale value from an earlier park.
test('worker row: a relaunch after a park writes park_turns null, and a plain stop after it writes a stopping row with park_turns null', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core, 'run-park6-h13');
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    await m.pause({ worker_id: 'w1', by: 'operator:1' });
    const pausedRow = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(pausedRow.park_turns, 1, "the park's own row must carry its own turns");

    await m.resume({ worker_id: 'w1', by: 'operator:1' });
    const runningRow = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(runningRow.state, 'running');
    assert.strictEqual(runningRow.park_turns, null, "a relaunch's own running row must not carry the old park's turns forward");

    const writes = [];
    const origWrite = core.worker.write.bind(core.worker);
    core.worker.write = async (r) => { writes.push(r); return origWrite(r); };
    await m.stop({ worker_id: 'w1', mode: 'graceful', timeout_ms: 5000 });
    core.worker.write = origWrite;

    const stoppingWrite = writes.find((r) => r.id === 'w1' && r.state === 'stopping');
    assert.ok(stoppingWrite, 'no stopping row was written during the plain stop');
    assert.strictEqual(stoppingWrite.park_turns, null, "the stopping row from a plain stop must not carry the old park's turns");

    const stoppedRow = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(stoppedRow.state, 'stopped');
    assert.strictEqual(stoppedRow.park_turns, null);
  } finally { await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (h15)
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.pid = 30000 + Math.floor(Math.random() * 10000);
  return child;
}

// R6 (src/run/exit.cjs:89): settle()'s deferred close-wait (armed for both the close handler and its
// own bound timer) used to resolve whatever launch the record now holds, not the one it was armed for —
// a relaunch's own turn could be answered by its predecessor's stale close. Built on the review's own
// probe-close-replaced, for both channels a first settle can arrive on.
test("settle: a replaced child's close after a relaunch resolves nothing for the new launch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-park6-h15-'));
  const ctx = { writeRow: async () => {} };
  try {
    for (const establishedBy of ['pid-poll', 'exit-event']) {
      const w = newWorkerRecord({ id: 'w1', substrate: 'claude-code', worktree: dir, dataDir: dir });
      const c1 = fakeChild();
      attach(w, c1, ctx);

      settle(w, establishedBy === 'exit-event' ? 0 : null, null, establishedBy, ctx);
      assert.strictEqual(w.settled, true, `channel ${establishedBy}`);

      // Reset the record as manager.cjs's own launch() does before a relaunch's attach (manager.cjs:154-158).
      w.settled = false; w.exitedAt = null; w.exitCode = null; w.exitSignal = null; w.turnEnded = false;
      w.readyAt = null; w.parkRequested = null; w.paused = null; w.staleSince = null;
      w.bgTasks = new Map(); w.controlWaiters.clear(); w.pendingTurnEnd = null;

      const c2 = fakeChild();
      attach(w, c2, ctx);
      assert.strictEqual(w.child, c2, `channel ${establishedBy}: the new launch's own child must be current`);

      const waiterP = new Promise((res) => w.turnWaiters.push((v) => res(v)));
      c1.emit('close'); // the replaced child's own, late close

      const raced = await Promise.race([waiterP, new Promise((r) => setTimeout(() => r('still-pending'), 100))]);
      assert.strictEqual(raced, 'still-pending', `channel ${establishedBy}: a replaced child's close must resolve nothing for the new launch`);
    }
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------- (h15b)
// R6, the bound-timer half (design item 5; src/run/exit.cjs's EXIT_CLOSE_BOUND_MS timer): (h15) only ever
// drives the `close` event channel of settle()'s deferred close-wait. The timer arm of the same wait had
// no test of its own — a replaced child that never emits `close` at all must still resolve nothing for
// the new launch once the bound fires. Plant: remove the `stillCurrent()` gate on the timer branch only
// (leave the close-handler's own gate) — this test must turn red.
test("settle: a replaced child that never closes resolves nothing for the new launch when the bound fires", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-park6-h15b-'));
  const ctx = { writeRow: async () => {} };
  try {
    const w = newWorkerRecord({ id: 'w1', substrate: 'claude-code', worktree: dir, dataDir: dir });
    const c1 = fakeChild();
    attach(w, c1, ctx);

    settle(w, null, null, 'pid-poll', ctx);
    assert.strictEqual(w.settled, true);

    // Reset the record as manager.cjs's own launch() does before a relaunch's attach.
    w.settled = false; w.exitedAt = null; w.exitCode = null; w.exitSignal = null; w.turnEnded = false;
    w.readyAt = null; w.parkRequested = null; w.paused = null; w.staleSince = null;
    w.bgTasks = new Map(); w.controlWaiters.clear(); w.pendingTurnEnd = null;

    const c2 = fakeChild();
    attach(w, c2, ctx);
    assert.strictEqual(w.child, c2, "the new launch's own child must be current");

    const waiterP = new Promise((res) => w.turnWaiters.push((v) => res(v)));
    // c1 never emits 'close' at all — only the bound timer can resolve this wait.

    const raced = await Promise.race([
      waiterP,
      new Promise((r) => setTimeout(() => r('still-pending'), EXIT_CLOSE_BOUND_MS + 500)),
    ]);
    assert.strictEqual(raced, 'still-pending', "a replaced child's own close-wait bound must resolve nothing for the new launch");
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------- (h16)
// R9 (src/run/pause.cjs:61): isOwnActiveRow read `row.state !== 'forgotten'`, so clearParkForStop counted
// this adapter's own stopped/dead/idle rows as its own live park, not only forgotten ones. Fixed (6i-2 fix
// round) with a discriminator, not a bare live-state list: `relaunchedSincePark` (worker.cjs's
// `launchesAtPark`, set at doPause's own step 1) is false here (w1 is never resumed), so the narrow,
// live-state check applies and a planted 'stopped' row is not counted as this adapter's own active park.
// park-3.test.cjs's (r4) needs the opposite breadth for a row this adapter's own resume genuinely
// committed after a relaunch, and stays green because its own launches count grew since its park.
test("stop: a stopped row carrying this adapter's pid is not counted as this adapter's own park", async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core, 'run-park6-h16');
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    await m.pause({ worker_id: 'w1', by: 'operator:1' });
    const rowBefore = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(rowBefore.state, 'paused');

    // Planted directly, as (h5)/(r8) do: a row this adapter's own manager never itself wrote this way,
    // but whose adapter_pid still names this adapter.
    const planted = await core.worker.write({ ...rowBefore, state: 'stopped', paused_at: null, paused_by: null });

    const stopped = await m.stop({ worker_id: 'w1', mode: 'kill', timeout_ms: 2000 });
    assert.strictEqual(stopped.stale, true, "a stopped row carrying this adapter's own pid must never be counted as this adapter's own park");

    const rowAfter = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(rowAfter.seq, planted.seq, 'the planted stopped row must be left untouched');
    assert.strictEqual(rowAfter.state, 'stopped');
  } finally { await teardown({ m, sb }); }
});
