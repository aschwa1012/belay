'use strict';
// park-2.test.cjs — build step 6e-5, closing 6e-4's second
// review (FINDINGS.json review2, eedc3a6): a graceful shutdown leaving a parked worker parked, a stopped
// parked worker reading stopped everywhere, a park writing no row before its exit, restart releasing its
// slot at the running row, a cross-adapter resume relaunching on what the worker was spawned with, and a
// stale park record deferring to the row. A real RunManager over tests/run/fakes/fake-claude.cjs, with
// tests/run/fake-core.cjs standing in for the store — the same fixtures tests/run/park.test.cjs uses.
// q7 and q8 close this step's own fix round #2 (a review of 6e-5's own output): a parked worker's pid,
// reused by Windows, must never be treated as live (manager.cjs:351), a stale stop's leftover w.state
// 'paused' must still refuse a later restart on the same record (pause.cjs:81), and a second `restart`
// while one is already running must share the first's promise, not relaunch over it (manager.cjs:462).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: spawnChild } = require('node:child_process');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore, FakeCoreError } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');
const P = require('../../src/run/process.cjs');
const { SNAPSHOT_TIMEOUT_MS } = require('../../src/core/proc-identity.cjs');

// A real, harmless process standing in for a pid Windows reused after the park's own process exited —
// the same method the reviewer's own pid-reuse probe used (a live bystander at the recorded dead pid).
function spawnBystander() {
  return spawnChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-park2-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}
// `adapterPid` (fix round, pause.cjs:104): lets two managers hold distinct identities in one OS process.
function mgr(sb, core, exe = FAKE, adapterPid) {
  return createRunManager({
    core, dataDir: sb.data, runId: 'run-park2-test',
    paths: { claudeExe: exe, codexExe: exe, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json'), adapterPid },
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
    await sleep(20);
  }
  return false;
}

// ---------------------------------------------------------------- (q1)
test('shutdown: a parked worker is left parked and named in left_parked, and a new adapter resumes it from the store', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m1 = mgr(sb, core);
  let m2 = null;
  try {
    await m1.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m1._waitTurn('w1', 8000);
    const paused = await m1.pause({ worker_id: 'w1', by: 'operator:1' });
    assert.strictEqual(paused.paused, true);

    const receipt = await m1.shutdown();
    assert.deepStrictEqual(receipt.left_parked, ['w1']);
    assert.deepStrictEqual(receipt.stopped, []);
    const rowAfterShutdown = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(rowAfterShutdown.state, 'paused');

    m2 = mgr(sb, core);
    const resumed = await m2.resume({ worker_id: 'w1', by: 'operator:2' });
    assert.strictEqual(resumed.resumed, true);
    assert.strictEqual(resumed.session_id, paused.session_id);
  } finally { if (m2) await m2.shutdown().catch(() => {}); await teardown({ m: m1, sb }); }
});

// ---------------------------------------------------------------- (q2)
test('stop: a stopped parked worker\'s row, wait answer and settled state all read stopped, naming the stop', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    await m.pause({ worker_id: 'w1', by: 'operator:1' });
    const w = m._worker('w1');
    assert.strictEqual(w.settledState, 'paused', 'the park must settle paused before the stop');

    const stopped = await m.stop({ worker_id: 'w1', mode: 'kill', timeout_ms: 5000 });
    assert.strictEqual(stopped.stale, undefined);
    const row = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(row.state, 'stopped');
    assert.strictEqual(w.settledState, 'stopped');
    assert.match(w.deathEstablishedBy, /stopped/);

    const waited = await m.wait({ worker_ids: ['w1'], timeout_ms: 1000 });
    assert.strictEqual(waited.event, 'stopped');
    assert.match(waited.established_by, /stopped/);
    assert.doesNotMatch(waited.established_by, /unknown at null/);
  } finally { await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (q3)
test('park: no worker row is written between the park\'s acceptance and its exit, and only a result at or after the interrupt is reported as interrupted', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    // 6e-6 item 7 (carried item 3, note park-2.test.cjs:128): FAKE_ANSWER_DELAY_MS is read once at the
    // fake's own module load (its one process serves both turns), so it must be set before `spawn`, not
    // after — a result that lands well before any pause is the first turn's own, long before the second
    // turn's interrupt below, both delayed by the same fixed bound.
    process.env.FAKE_ANSWER_DELAY_MS = '8000';
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 10000);
    await m.message({ worker_id: 'w1', text: 'two' });
    await sleep(300); // the second turn is in flight, held by the same FAKE_ANSWER_DELAY_MS
    const rowsBefore = core.rowsFor('w1').length;
    const r = await m.pause({ worker_id: 'w1', by: 'operator:1' });
    assert.strictEqual(r.paused, true);
    assert.strictEqual(r.interrupted, true);
    // The first turn's own result landed well before this pause's interrupt; it must never appear in
    // this park's own results_after_interrupt (6e-6 item 7: q3 drives a result that lands before the
    // interrupt — probe A, which the code already handles by the stream's own `e.at`, not write order).
    assert.deepStrictEqual(r.results_after_interrupt, ['error_during_execution']);
    const rowsAfter = core.rowsFor('w1');
    // 6e-6 item 7 (carried item 3): every row written between the park's acceptance and its own 'paused'
    // row must be exactly the park's own writes — 'stopping' then 'paused' — never merely "no 'paused'
    // row before 'stopping'" (the review 2 finding this used to let a planted extra write pass).
    const newRows = rowsAfter.slice(rowsBefore);
    assert.deepStrictEqual(newRows.map((row) => row.state), ['stopping', 'paused'], JSON.stringify(newRows));
    assert.strictEqual(r.row.mid_turn, 0, 'a paused row must never claim mid_turn');
  } finally { delete process.env.FAKE_ANSWER_DELAY_MS; await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (q4)
test('restart: the slot is released at the running row, so a stop during the first turn proceeds at once', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    const launchesBefore = m._worker('w1').launches;
    process.env.FAKE_ANSWER_DELAY_MS = '40000'; // the relaunch's own first turn is held open
    const restartP = m.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000 });
    // 6e-6 item 7 (carried item 3, note park.test.cjs:169): `launches` must itself have grown before the
    // poll's other two conditions are trusted, or a check made right after `restart()` is called (before
    // `launch()` has reset `readyAt`/`op` for the new attempt) can read the *previous* launch's already-
    // true state and pass on its first look, never truly waiting for anything.
    // fix round (review, park-2.test.cjs:156): bound tightened well under first_turn_timeout_ms (now 20,000 so a hosted runner's lag fits)
    // above — the old 5000 ms bound outlasted the regression this test is named for, so it always passed.
    assert.ok(await pollUntil(() => m._worker('w1').launches > launchesBefore && m._worker('w1').readyAt !== null
      && m._worker('w1').op === null, 8000), 'the operation slot was never released at the running row');
    const t0 = Date.now();
    const stopped = await m.stop({ worker_id: 'w1', mode: 'kill', timeout_ms: 5000 });
    const stopMs = Date.now() - t0;
    // Waiting behind the first turn takes 20,000 ms (its timeout); 10,000 leaves a slow runner room. The kill's own
    // identity snapshot (ADR 0048, rule a) is not what this test is about: it is subtracted, and itself bounded by
    // the most one caller can wait for a snapshot, one in flight and then its own.
    const snapMs = (stopped.tree_kill && stopped.tree_kill.snapshot_ms) || 0;
    assert.ok(snapMs <= 2 * SNAPSHOT_TIMEOUT_MS, `the kill's snapshot took ${snapMs} ms`);
    assert.ok(stopMs - snapMs < 10000, `stop took ${stopMs} ms (${snapMs} ms of it the kill's snapshot), which suggests it waited behind restart's first turn`);
    assert.strictEqual(stopped.pid, m._worker('w1').pid);
    delete process.env.FAKE_ANSWER_DELAY_MS;
    const restarted = await restartP;
    // 6e-6 item 2 (carried items 1 and 5): the worker's own exit (the stop above) now ends the first-turn
    // wait directly, so this is no longer a timeout — it is named by the exit that actually ended it.
    assert.strictEqual(restarted.first_turn_timed_out, false, 'the exit that ended the wait is not a timeout');
    assert.strictEqual(restarted.first_turn_ended_by, 'exit');
  } finally { delete process.env.FAKE_ANSWER_DELAY_MS; await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (q5)
test('resume: a worker parked by another adapter is relaunched with the model, allowed tools and permission prompt it was spawned with', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m1 = mgr(sb, core);
  let m2 = null;
  try {
    await m1.spawn({
      substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1',
      model: 'claude-sonnet-5', allowed_tools: ['Read', 'Bash'], permission_prompt: true, permit_wait_ms: 12345,
    });
    await m1._waitTurn('w1', 8000);
    await m1.pause({ worker_id: 'w1', by: 'operator:1' });

    m2 = mgr(sb, core);
    const r = await m2.resume({ worker_id: 'w1', by: 'operator:2' });
    assert.strictEqual(r.resumed, true);
    assert.strictEqual(r.model, 'claude-sonnet-5');
    assert.strictEqual(r.permission_prompt, true);
    const w2 = m2._worker('w1');
    assert.deepStrictEqual(w2.allowedTools, ['Read', 'Bash']);
    assert.strictEqual(w2.permitWaitMs, 12345);
  } finally { if (m2) await m2.shutdown().catch(() => {}); await teardown({ m: m1, sb }); }
});

// ---------------------------------------------------------------- (q6)
test('pause and resume: an adapter whose park record is stale after another adapter resumed the worker refuses naming the row, and its stop writes nothing over that row', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  // Distinct fake adapter pids (fix round, pause.cjs:104): both managers share this test's real
  // process.pid otherwise, hiding the very cross-adapter distinction this test exists to exercise.
  const m1 = mgr(sb, core, FAKE, 900011);
  let m2 = null;
  try {
    await m1.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m1._waitTurn('w1', 8000);
    await m1.pause({ worker_id: 'w1', by: 'operator:1' });

    m2 = mgr(sb, core, FAKE, 900012);
    const resumed = await m2.resume({ worker_id: 'w1', by: 'operator:2' });
    assert.strictEqual(resumed.resumed, true);

    // m1's own record is now stale: the row m2 wrote says running, under a different adapter pid.
    await assert.rejects(m1.pause({ worker_id: 'w1', by: 'operator:3' }), (e) => {
      assert.strictEqual(e.code, 'E_SUBSTRATE');
      assert.strictEqual(e.detail.row_state, 'running');
      return true;
    });
    const rowAfterPause = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(rowAfterPause.state, 'running');
    assert.strictEqual(rowAfterPause.pid, resumed.new_pid);

    await assert.rejects(m1.resume({ worker_id: 'w1', by: 'operator:4' }), (e) => {
      assert.strictEqual(e.code, 'E_SUBSTRATE');
      return true;
    });

    const rowBeforeStop = await core.worker.get({ worker_id: 'w1' });
    const staleStop = await m1.stop({ worker_id: 'w1', mode: 'kill', timeout_ms: 2000 });
    assert.strictEqual(staleStop.stale, true);
    const rowAfterStop = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(rowAfterStop.state, rowBeforeStop.state, 'a stale stop must not overwrite the live adapter\'s row');
    assert.strictEqual(rowAfterStop.pid, rowBeforeStop.pid);
    assert.strictEqual(P.pidAlive(resumed.new_pid), true, 'the live adapter\'s own process must survive the stale stop');
  } finally { if (m2) await m2.shutdown().catch(() => {}); await teardown({ m: m1, sb }); }
});

// ---------------------------------------------------------------- (q7)
test('stop: a parked worker\'s pid reused by Windows for a live bystander is never touched, whether the record is stale or not, and a stale stop still refuses a later restart', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  // Distinct fake adapter pids (fix round, pause.cjs:104), for the same reason as q6.
  const m1 = mgr(sb, core, FAKE, 900021);
  let m2 = null;
  let bystanderA = null;
  let bystanderB = null;
  try {
    // Same-adapter case: a legitimately parked worker (row and record agree) whose recorded pid a
    // Windows reuse has since handed to a live, unrelated process (fix round #2, manager.cjs:351).
    await m1.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m1._waitTurn('w1', 8000);
    await m1.pause({ worker_id: 'w1', by: 'operator:1' });
    bystanderA = spawnBystander();
    await new Promise((r) => bystanderA.once('spawn', r));
    m1._worker('w1').pid = bystanderA.pid;

    const sameAdapterStop = await m1.stop({ worker_id: 'w1', mode: 'kill', timeout_ms: 2000 });
    assert.strictEqual(sameAdapterStop.killed, false, 'a parked worker\'s dead-by-construction pid must never be killed');
    assert.strictEqual(P.pidAlive(bystanderA.pid), true, 'the bystander holding the reused pid must survive');
    const rowAfterSameAdapterStop = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(rowAfterSameAdapterStop.state, 'stopped', 'an explicit stop of a parked worker still writes stopped');

    // Cross-adapter (stale) case: m1's record still believes 'w2' parked; m2 resumes it for real, then
    // m1's own cached pid is pointed at a second bystander simulating the same pid-reuse.
    await m1.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w2' });
    await m1._waitTurn('w2', 8000);
    await m1.pause({ worker_id: 'w2', by: 'operator:1' });
    m2 = mgr(sb, core, FAKE, 900022);
    const resumed = await m2.resume({ worker_id: 'w2', by: 'operator:2' });
    assert.strictEqual(resumed.resumed, true);
    bystanderB = spawnBystander();
    await new Promise((r) => bystanderB.once('spawn', r));
    m1._worker('w2').pid = bystanderB.pid;

    const rowBeforeStaleStop = await core.worker.get({ worker_id: 'w2' });
    const staleStop = await m1.stop({ worker_id: 'w2', mode: 'kill', timeout_ms: 2000 });
    assert.strictEqual(staleStop.stale, true);
    assert.strictEqual(staleStop.killed, false, 'a stale stop must never kill the pid it happens to be holding');
    assert.strictEqual(P.pidAlive(bystanderB.pid), true, 'the second bystander must also survive');
    const rowAfterStaleStop = await core.worker.get({ worker_id: 'w2' });
    assert.deepStrictEqual(rowAfterStaleStop, rowBeforeStaleStop, 'a stale stop must not overwrite the live adapter\'s row');
    assert.strictEqual(P.pidAlive(resumed.new_pid), true, 'the live adapter\'s own process must survive the stale stop');

    // Fix round #2, pause.cjs:81: the stale stop cleared m1's parkRequested/paused but left w.state
    // 'paused'; a restart on that leftover record must still be refused, never relaunch --resume onto
    // the session m2 is actively running. 6e-6 item 4 (carried item 4, wait.cjs:37): the stale stop above
    // already named the record `w.staleSince`, so this refusal is `checkNotStale`'s own E_SUBSTRATE,
    // naming the row and the adapter that now holds it, not the bare E_PAUSED a stuck `w.state` alone used
    // to produce.
    await assert.rejects(m1.restart({ worker_id: 'w2' }), (e) => {
      assert.strictEqual(e.code, 'E_SUBSTRATE');
      assert.strictEqual(e.detail.row_state, 'running');
      return true;
    });
    const rowAfterStaleRestart = await core.worker.get({ worker_id: 'w2' });
    assert.deepStrictEqual(rowAfterStaleRestart, rowBeforeStaleStop, 'a refused restart on a stale record must write nothing');
    assert.strictEqual(P.pidAlive(resumed.new_pid), true, 'the live adapter\'s own process must survive the refused restart');
  } finally {
    for (const b of [bystanderA, bystanderB]) if (b && b.pid) require('../crash.cjs').crash(b);
    if (m2) await m2.shutdown().catch(() => {});
    await teardown({ m: m1, sb });
  }
});

// ---------------------------------------------------------------- (q8)
// 6e-6 item 1 (carried item 1, manager.cjs:460) narrows what a second `restart` shares: only the
// relaunch itself, not the first-turn wait that used to keep `restartInFlight` set (fix round #2's own
// regression). A second call arriving while the relaunch is still in flight — before `w.restartInFlight`
// clears — still shares that one relaunch; this is the boundary that still holds.
test('restart: a second restart issued while the first\'s own relaunch is still in flight shares that relaunch rather than starting its own', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    const launchesBefore = m._worker('w1').launches;
    process.env.FAKE_ANSWER_DELAY_MS = '8000'; // holds the relaunch's own first turn open once it lands
    const p1 = m.restart({ worker_id: 'w1', first_turn_timeout_ms: 3000 });
    const p2 = m.restart({ worker_id: 'w1', first_turn_timeout_ms: 3000 }); // issued at once, relaunch still in flight
    assert.ok(await pollUntil(() => m._worker('w1').launches > launchesBefore && m._worker('w1').readyAt !== null
      && m._worker('w1').op === null, 5000), 'the relaunch never completed and released the operation slot');
    const launchesAfterRelaunch = m._worker('w1').launches;
    const pidAfterRelaunch = m._worker('w1').pid;
    delete process.env.FAKE_ANSWER_DELAY_MS;
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(r1.new_pid, pidAfterRelaunch, 'both callers must have waited on the one relaunch that happened');
    assert.strictEqual(r2.new_pid, pidAfterRelaunch, 'both callers must have waited on the one relaunch that happened');
    assert.strictEqual(m._worker('w1').launches, launchesAfterRelaunch, 'no second relaunch must ever have happened');
    assert.strictEqual(m._worker('w1').restartInFlight, null, 'the shared field must be cleared once the relaunch has settled');
  } finally { delete process.env.FAKE_ANSWER_DELAY_MS; await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (lifecycle.cjs:65 fix)
// A resume whose 'starting' row write failed leaves state 'paused' with a live child still attached;
// shutdown's left_parked skip must never key on the state word alone (review, lifecycle.cjs:65).
test('shutdown: a paused row with a live child from a failed resume write is stopped, not left parked', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    await m.pause({ worker_id: 'w1', by: 'operator:1' });
    const origWrite = core.worker.write.bind(core.worker);
    let failOnce = true;
    core.worker.write = async (r) => {
      if (failOnce && r.id === 'w1' && r.state === 'starting') { failOnce = false; throw new FakeCoreError('E_TIMEOUT', 'fake core: simulated starting-row write failure'); }
      return origWrite(r);
    };
    await assert.rejects(m.resume({ worker_id: 'w1', by: 'operator:2' }));
    core.worker.write = origWrite;
    const w = m._worker('w1');
    assert.strictEqual(w.state, 'paused', 'the in-memory state must still read paused after the failed write');
    assert.ok(w.child, 'the relaunch must have already attached a live child');
    const pid = w.pid;
    const receipt = await m.shutdown();
    assert.deepStrictEqual(receipt.left_parked, [], 'a worker with a live child must never be left parked');
    assert.deepStrictEqual(receipt.stopped, ['w1']);
    assert.strictEqual(P.pidAlive(pid), false, 'the live process must actually have been stopped');
  } finally { await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (q3 probe A)
// (q3) never actually drove probe A (review, park-2.test.cjs:129): its own onTurnEnd is held queued
// behind a gate installed before the child spawns, so its e.at-vs-interruptAt check runs only after
// pause() has set parkRequested/interruptAt — unlike (q3)'s own already-settled early result.
test('park: a result timestamped before the interrupt is never counted as landing after it, however delayed its own onTurnEnd runs', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  let gateInstalled = false;
  let releaseGate = null;
  const origWrite = core.worker.write.bind(core.worker);
  core.worker.write = async (r) => {
    if (!gateInstalled && r.id === 'w1' && r.state === 'starting') { gateInstalled = true; const w0 = m._worker('w1'); w0.queue = w0.queue.then(() => new Promise((res) => { releaseGate = res; })); }
    return origWrite(r);
  };
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    core.worker.write = origWrite;
    const w = m._worker('w1');
    assert.ok(await pollUntil(() => !!releaseGate, 2000), 'the queue gate was never armed');
    assert.ok(await pollUntil(() => !!w.pendingTurnEnd, 5000), 'the first turn was never parsed off the stream');
    const firstAt = w.pendingTurnEnd.at;
    const pausePromise = m.pause({ worker_id: 'w1', by: 'operator:1' });
    // pause() awaits forWorker before setting parkRequested, so it is not synchronous from here — poll,
    // never assume (an exception here would skip releaseGate() and hang shutdown() in `finally` forever).
    assert.ok(await pollUntil(() => !!w.parkRequested, 2000), 'pause() never set parkRequested');
    assert.ok(w.parkRequested.interruptAt >= firstAt, 'the interrupt must be timestamped at or after the result it must not count');
    releaseGate(); // only now does the gated onTurnEnd, and its afterInterrupt check, actually run
    const r = await pausePromise;
    assert.strictEqual(r.paused, true);
    assert.deepStrictEqual(r.results_after_interrupt, [], 'a result timestamped before the interrupt must never be counted, however late its own processing runs');
  } finally { await teardown({ m, sb }); }
});
