'use strict';
// park-3.test.cjs — build step 6e-6, closing what 6e-5
// carried (earlier review items): a restart shares only its relaunch and its first-turn
// wait ends on the worker's exit (r1, r2); stop keys "already parked" on the process this adapter holds,
// not on the state word (r3, r4); a stale record reads stale (r5); a park in flight at shutdown completes
// as a park (r6). A real RunManager over tests/run/fakes/fake-claude.cjs (fake-claude-with-child.cjs for
// r6), with tests/run/fake-core.cjs standing in for the store — the same fixtures park.test.cjs uses.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore, FakeCoreError } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');
const P = require('../../src/run/process.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const FAKE_WITH_CHILD = path.join(__dirname, 'fakes', 'fake-claude-with-child.cjs').replace(/\\/g, '/');
const FAKE_CODEX = path.join(__dirname, 'fakes', 'fake-codex.cjs').replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-park3-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}
// `adapterPid` (fix round, pause.cjs:104): overridable so a test can give two managers distinct
// identities in one OS process, the way two real adapters would differ for real.
function mgr(sb, core, exe = FAKE, adapterPid) {
  return createRunManager({
    core, dataDir: sb.data, runId: 'run-park3-test',
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

// ---------------------------------------------------------------- (r1)
test('restart: a restart after a stop that landed during the previous restart\'s first turn relaunches again and returns its own receipt', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    const launchesBefore = m._worker('w1').launches;
    // The stop's kill takes an identity snapshot first, so when it lands depends on the machine (ADR 0048 decision 8, c). The
    // first turn is held open far past it, so the exit that ends the wait is the stop's kill, never the turn's end or its timeout.
    process.env.FAKE_ANSWER_DELAY_MS = '40000';
    const p1 = m.restart({ worker_id: 'w1', first_turn_timeout_ms: 30000 });
    assert.ok(await pollUntil(() => m._worker('w1').launches > launchesBefore && m._worker('w1').readyAt !== null
      && m._worker('w1').op === null, 5000), 'the relaunch never completed and released the operation slot');
    assert.strictEqual(m._worker('w1').restartInFlight, null, 'restartInFlight must be cleared once the relaunch settles, before the first turn ends');
    const launchesAfterFirst = m._worker('w1').launches;
    const pidAfterFirst = m._worker('w1').pid;

    const stopped = await m.stop({ worker_id: 'w1', mode: 'kill', timeout_ms: 5000 }); // lands during restart1's own first-turn wait
    assert.strictEqual(stopped.pid, pidAfterFirst);
    delete process.env.FAKE_ANSWER_DELAY_MS;
    const r1 = await p1;
    assert.strictEqual(r1.first_turn_timed_out, false);
    assert.strictEqual(r1.first_turn_ended_by, 'exit');

    const r2 = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 5000 }); // the natural next act
    assert.notStrictEqual(r2, r1, 'a restart after the first one settled must be its own call, not a shared receipt');
    assert.strictEqual(m._worker('w1').launches, launchesAfterFirst + 1, 'the second restart must have relaunched the worker again');
    assert.notStrictEqual(r2.new_pid, pidAfterFirst, 'the second restart must produce a new process');
    assert.strictEqual(r2.worker.state, 'running');
  } finally { delete process.env.FAKE_ANSWER_DELAY_MS; await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (r2)
test('restart: a first-turn wait ends when the worker exits, and the receipt names the exit, not a timeout', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    const launchesBefore = m._worker('w1').launches;
    process.env.FAKE_ANSWER_DELAY_MS = '30000';
    const restartP = m.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000 });
    // launches must itself have grown before the other two conditions are trusted, or a check made right
    // after `restart()` is called can read the *previous* launch's already-true state and pass at once.
    assert.ok(await pollUntil(() => m._worker('w1').launches > launchesBefore && m._worker('w1').readyAt !== null
      && m._worker('w1').op === null, 5000), 'the relaunch never completed and released the operation slot');
    const pid = m._worker('w1').pid;
    const t0 = Date.now();
    require('../crash.cjs').crash(m._worker('w1').child); // a crash, not `stop()`: settle()'s own exit path must resolve the wait
    const r = await restartP;
    const ms = Date.now() - t0;
    // Waiting out the turn's answer takes 30,000 ms and the timeout 20,000 ms; 10,000 separates them from an exit-ended wait
    // with room for a slow runner (this whole test took 3 s there).
    assert.ok(ms < 10000, `restart's receipt took ${ms} ms, far short of the 20,000 ms first_turn_timeout_ms it should never have waited out`);
    assert.strictEqual(r.first_turn_timed_out, false);
    assert.strictEqual(r.first_turn_ended_by, 'exit');
    assert.strictEqual(r.first_turn_usage, null, 'an exited turn produced no usage');
    assert.strictEqual(r.worker.state, m._worker('w1').settledState);
  } finally { delete process.env.FAKE_ANSWER_DELAY_MS; await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (r3)
test('stop: a worker whose resume failed to write its starting row is parked again with its relaunched child ended, and a stop turns its row stopped', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    await m.pause({ worker_id: 'w1', by: 'operator:1' });
    assert.strictEqual(m._worker('w1').state, 'paused');

    // A resume whose 'starting' row write fails: the relaunch has already spawned a child (`launch` runs before the write). It holds
    // a bind, so the failed start ends it (ADR 0045 amendment 3) and the worker reads parked again, as before the resume.
    const origWrite = core.worker.write.bind(core.worker);
    let failOnce = true;
    core.worker.write = async (r) => {
      if (failOnce && r.id === 'w1' && r.state === 'starting') {
        failOnce = false;
        throw new FakeCoreError('E_TIMEOUT', 'fake core: simulated starting-row write failure');
      }
      return origWrite(r);
    };
    await assert.rejects(m.resume({ worker_id: 'w1', by: 'operator:2' }));
    core.worker.write = origWrite;

    const w = m._worker('w1');
    assert.strictEqual(w.state, 'paused', 'the in-memory state must still read paused after the failed write');
    assert.notStrictEqual(await P.waitPidGone(w.pid, { timeoutMs: 10000 }), null, 'the relaunched process must have been ended');
    assert.ok(await pollUntil(() => !w.child && w.state === 'paused', 5000), `the worker must read parked again (state ${w.state}, child ${!!w.child})`);
    const rowBefore = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(rowBefore.state, 'paused');

    const stopped = await m.stop({ worker_id: 'w1', mode: 'graceful', timeout_ms: 5000 });
    assert.strictEqual(stopped.stale, undefined, "a park this adapter returned to is not another adapter's resume");
    assert.strictEqual(P.pidAlive(w.pid), false, 'the live process must actually have been stopped');
    const rowAfter = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(rowAfter.state, 'stopped');
  } finally { await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (r4)
test('stop: a starting row written by this adapter is not taken for another adapter\'s resume', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    await m.pause({ worker_id: 'w1', by: 'operator:1' });
    const resumed = await m.resume({ worker_id: 'w1', by: 'operator:2' });
    assert.strictEqual(resumed.resumed, true);
    const w = m._worker('w1');
    const rowNow = await core.worker.get({ worker_id: 'w1' });
    assert.notStrictEqual(rowNow.state, 'paused');
    assert.ok(w.child, 'this adapter\'s own resume must have attached a live child');

    // The race carried item 2 names: this adapter wrote the row itself, but the in-memory record has not
    // caught up to it yet (`writeRow` sets `w.state` only once the write resolves) — simulated directly.
    w.state = 'paused';

    const stopped = await m.stop({ worker_id: 'w1', mode: 'kill', timeout_ms: 5000 });
    assert.strictEqual(stopped.stale, undefined, 'this adapter\'s own live child must never be taken for a different adapter\'s resume');
    assert.strictEqual(w.staleSince, null, 'a live child of our own must never be recorded as staleness either');
    assert.strictEqual(P.pidAlive(w.pid), false);
    const rowAfter = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(rowAfter.state, 'stopped');

    // The finding's own scenario (pause.cjs:104): a *different* worker whose resume's 'starting' write
    // actually committed (api.md §6's may_have_committed) despite throwing E_TIMEOUT to the caller, and
    // whose relaunched child has since died — so, unlike above, no live child ever shields it from the
    // row lookup. Without the adapter_pid comparison, clearParkForStop reads the committed row (no longer
    // 'paused') and takes its own write for another adapter's resume, staling the record against its own
    // pid for good.
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w2' });
    await m._waitTurn('w2', 8000);
    await m.pause({ worker_id: 'w2', by: 'operator:1' });
    const origWrite2 = core.worker.write.bind(core.worker);
    // Every write for w2 commits to the store (api.md §6's may_have_committed) but throws to its own
    // caller, for as long as this stays true — so w2.state (set only on writeRow's own success path)
    // never catches up, not even from settle()'s later 'dead' write once the relaunch dies below.
    let failWrites2 = true;
    core.worker.write = async (r) => {
      if (failWrites2 && r.id === 'w2') { const written = await origWrite2(r); throw new FakeCoreError('E_TIMEOUT', 'fake core: simulated persistent write timeout for w2'); }
      return origWrite2(r);
    };
    await assert.rejects(m.resume({ worker_id: 'w2', by: 'operator:2' }));
    const w2 = m._worker('w2');
    assert.strictEqual(w2.state, 'paused', 'the in-memory state must still read paused after the apparently failed write');
    assert.ok(await pollUntil(() => !w2.child, 10000), 'the failed start never ended the relaunched child'); // ADR 0045 amendment 3: the guard, not a crash
    assert.strictEqual(w2.state, 'paused', 'w2.state must still be stuck: every write for w2 threw');
    const rowNow2 = await core.worker.get({ worker_id: 'w2' });
    assert.strictEqual(rowNow2.adapter_pid, process.pid, "this adapter's own writes must have actually committed: the row carries its pid");
    failWrites2 = false;
    core.worker.write = origWrite2;
    const stopped2 = await m.stop({ worker_id: 'w2', mode: 'kill', timeout_ms: 5000 });
    assert.strictEqual(stopped2.stale, undefined, 'this adapter\'s own committed writes, whose relaunch has since died, must never be taken for another adapter\'s resume');
    assert.strictEqual(w2.staleSince, null, 'never recorded as staleness against our own pid');
    const rowAfter2 = await core.worker.get({ worker_id: 'w2' });
    assert.strictEqual(rowAfter2.state, 'stopped');
  } finally { await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (r5)
test('wait and shutdown: a stale record answers stale naming the row and the adapter, and shutdown lists it under left_stale', async (tcx) => {
  const sb = sandbox();
  const core = createFakeCore();
  // Distinct fake adapter pids (fix round, pause.cjs:104): both managers run in this one test process
  // and would otherwise share the same real process.pid, hiding the very distinction this test is for.
  const m1 = mgr(sb, core, FAKE, 900001);
  tcx.after(() => Promise.resolve().then(() => m1.shutdown()));
  let m2 = null;
  try {
    await m1.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m1._waitTurn('w1', 8000);
    await m1.pause({ worker_id: 'w1', by: 'operator:1' });

    m2 = mgr(sb, core, FAKE, 900002);
    const resumed = await m2.resume({ worker_id: 'w1', by: 'operator:2' });
    assert.strictEqual(resumed.resumed, true);

    // 6f-2 item 8: checkNotStale (pause.cjs:78), reached through `pause`, not only through `stop`'s own
    // `clearParkForStop` below — m1's own `w.paused` is still set, so a second pause of it hits checkNotStale.
    await assert.rejects(m1.pause({ worker_id: 'w1', by: 'operator:3' }), (e) => { assert.strictEqual(e.code, 'E_SUBSTRATE'); return true; });
    assert.ok(m1._worker('w1').staleSince, 'checkNotStale must record staleness too, not only clearParkForStop');

    // m1's own record still believes it parked w1; the row now disagrees (m2 resumed it for real).
    const staleStop = await m1.stop({ worker_id: 'w1', mode: 'kill', timeout_ms: 2000 });
    assert.strictEqual(staleStop.stale, true);
    const w = m1._worker('w1');
    assert.ok(w.staleSince, 'the record must carry when and by whom it went stale');
    assert.strictEqual(w.staleSince.row_state, 'running');

    const waited = await m1.wait({ worker_ids: ['w1'], timeout_ms: 1000 });
    assert.strictEqual(waited.event, 'stale');
    assert.doesNotMatch(waited.established_by, /unknown at null/);
    assert.match(waited.established_by, /running/);
    assert.match(waited.established_by, new RegExp(String(w.staleSince.adapter_pid)));

    const receipt = await m1.shutdown();
    assert.deepStrictEqual(receipt.left_stale, ['w1']);
    assert.deepStrictEqual(receipt.left_parked, []);
    assert.deepStrictEqual(receipt.stopped, []);
    assert.strictEqual(P.pidAlive(resumed.new_pid), true, 'm1\'s shutdown must never touch the live adapter\'s process');
  } finally { if (m2) await m2.shutdown().catch(() => {}); await teardown({ m: m1, sb }); }
});

// ---------------------------------------------------------------- (r6)
test('shutdown: a park in flight at shutdown completes as a park, the worker is left parked and its row reads paused', async (tcx) => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core, FAKE_WITH_CHILD);
  tcx.after(() => Promise.resolve().then(() => m.shutdown()));
  const pidFile = path.join(sb.data, 'child.pid');
  process.env.FAKE_CHILD_PID_FILE = pidFile;
  // Hold the pause in flight on a gate, never on timing: the pause's first row ('stopping') is held inside the
  // core write until shutdown has been called, so the shutdown is certain to meet a pause that has not finished.
  let reached; const atWrite = new Promise((r) => { reached = r; });
  let release; const gate = new Promise((r) => { release = r; });
  const write = core.worker.write;
  core.worker.write = async (r) => { if (r.state === 'stopping' && reached) { const f = reached; reached = null; f(); await gate; } return write(r); };
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    assert.ok(await pollUntil(() => fs.existsSync(pidFile), 5000), 'the fake never wrote its own child pid');
    const pauseP = m.pause({ worker_id: 'w1', by: 'operator:1', interrupt_timeout_ms: 500, exit_timeout_ms: 1500 });
    await atWrite;
    assert.ok(m._worker('w1').parkRequested, 'parkRequested was never set');
    assert.strictEqual(m._worker('w1').op && m._worker('w1').op.name, 'pause', 'the pause must still be in flight when shutdown runs');

    const shutdownP = m.shutdown();
    release();
    const receipt = await shutdownP;
    const paused = await pauseP;
    assert.strictEqual(paused.paused, true);
    assert.deepStrictEqual(receipt.left_parked, ['w1']);
    assert.deepStrictEqual(receipt.stopped, []);
    const row = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(row.state, 'paused');
  } finally { delete process.env.FAKE_CHILD_PID_FILE; await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (worker.cjs:317 fix)
// A Codex worker exits right after every turn by design; its own turn_end is queued behind onTurnEnd's
// store writes, and settle()'s own exit-path resolution must never race ahead of it (fix round).
test('restart: a Codex worker whose turn genuinely completed still reports that turn\'s own usage, not exit/null, even when its own store write is slow', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const origStore = core.memory.store.bind(core.memory);
  core.memory.store = async (a) => { await sleep(150); return origStore(a); }; // the finding's own 20-50ms+ store latency
  const m = mgr(sb, core, FAKE_CODEX);
  try {
    await m.spawn({ substrate: 'codex', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    assert.ok(await pollUntil(() => m._worker('w1').settled === true, 5000), 'the first codex process never settled');
    await m._worker('w1').queue;
    const r = await m.restart({ worker_id: 'w1' });
    assert.strictEqual(r.first_turn_ended_by, 'turn', 'a turn that genuinely completed must never be reported as ended by exit');
    assert.ok(r.first_turn_usage, 'a completed turn must report its own usage, not null');
    assert.strictEqual(r.first_turn_usage.input_tokens, 120);
  } finally { core.memory.store = origStore; await teardown({ m, sb }); }
});
