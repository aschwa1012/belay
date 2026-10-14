'use strict';
// RunManager.wait — experimental, ADR 0014 finding 1, probed before any record adopts it. Every assertion is about a derived fact: a turn that ended on the stream, a
// process that exited, a timeout that came back as a result. Nothing here is a worker's claim.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const P = require('../../src/run/process.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-wait-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}

function mgr(sb, core) {
  return createRunManager({
    core, dataDir: sb.data, runId: 'run-wait',
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
}

test('wait answers at once for a worker whose turn already ended, and names what established it', async () => {
  const sb = sandbox();
  const m = mgr(sb, createFakeCore());
  await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w1' });
  await m._waitTurn('w1', 8000);

  const r = await m.wait({ worker_ids: ['w1'], timeout_ms: 30000 });
  assert.equal(r.worker_id, 'w1');
  assert.equal(r.event, 'turn_end');
  assert.equal(r.already, true, 'the turn had ended before the call, and the result says so');
  assert.equal(r.timed_out, false);
  assert.equal(r.turn, 1);
  assert.match(r.established_by, /result event on the worker stream/);
  // A call that held for its budget waits 30,000 ms; 10,000 keeps a hosted runner's lag out of the way.
  assert.ok(r.waited_ms < 10000, `an already-ended turn should not hold the call: ${r.waited_ms} ms`);
  assert.deepEqual(r.watched, ['w1']);
  await m.shutdown();
});

test('wait blocks on a worker mid-turn and returns the turn when it ends; a timeout is a result with the busy set', async () => {
  const sb = sandbox();
  const m = mgr(sb, createFakeCore());
  await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w2' });
  await m._waitTurn('w2', 8000);

  // Mid-turn, deterministically: the record's own flag, not a race against the fake's reply.
  m._worker('w2').turnEnded = false;
  const t = await m.wait({ worker_ids: ['w2'], timeout_ms: 150 });
  assert.equal(t.timed_out, true);
  assert.equal(t.worker_id, null);
  assert.ok(t.waited_ms >= 140, `held for the timeout: ${t.waited_ms} ms`);
  assert.deepEqual(t.busy.map((b) => b.worker_id), ['w2']);
  assert.equal(t.busy[0].pid_alive, true);

  // A message starts a turn; the fake answers it; wait sees the new turn, not the old one.
  const p = m.wait({ worker_ids: ['w2'], timeout_ms: 8000 });
  await m.message({ worker_id: 'w2', text: 'again' });
  const r = await p;
  assert.equal(r.event, 'turn_end');
  assert.equal(r.turn, 2, 'the second turn, established by the second result on the stream');
  assert.equal(r.already, undefined, 'it was waited for, not found already ended');
  assert.ok(r.usage && typeof r.usage.input_tokens === 'number', 'the turn\'s usage comes with it');
  await m.shutdown();
});

test('wait on a stopped worker reports the exit and what established it', async () => {
  const sb = sandbox();
  const m = mgr(sb, createFakeCore());
  await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w3' });
  await m._waitTurn('w3', 8000);
  await m.stop({ worker_id: 'w3', mode: 'graceful' });

  const r = await m.wait({ worker_ids: ['w3'], timeout_ms: 2000 });
  assert.equal(r.worker_id, 'w3');
  assert.equal(r.event, 'stopped');
  assert.equal(r.exit_code, 0, 'the fake exits 0 when its stdin closes');
  assert.match(r.established_by, /exit-event|pid-poll/);
  await m.shutdown();
});

test('wait blocking on a worker that dies mid-turn reports the death, its exit code and what established it', async () => {
  const sb = sandbox();
  const m = mgr(sb, createFakeCore());
  const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w5' });
  await m._waitTurn('w5', 8000);
  // Mid-turn, deterministically: the record's own flag, not a race against the fake's reply.
  m._worker('w5').turnEnded = false;

  const p = m.wait({ worker_ids: ['w5'], timeout_ms: 5000 });
  require('../crash.cjs').crash(m._worker('w5').child);
  const r = await p;

  assert.equal(r.worker_id, 'w5');
  assert.equal(r.event, 'dead');
  assert.equal(r.timed_out, false);
  assert.equal(r.already, undefined, 'it was waited for, not found already dead');
  assert.ok(
    Number.isInteger(r.exit_code) || typeof r.exit_signal === 'string',
    'the death carries an exit code or a signal, got ' + JSON.stringify({ exit_code: r.exit_code, exit_signal: r.exit_signal })
  );
  assert.match(r.established_by, /exit-event|pid-poll/);
  // No wall-clock bound: the answer returned inside this call's own 5,000 ms (timed_out false above), and
  // wait.cjs holds a poll-established death for the exit event's code within that budget.
  await m.shutdown();
});

test('a worker that died before the call answers at once as dead, already', async () => {
  const sb = sandbox();
  const m = mgr(sb, createFakeCore());
  const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w6' });
  await m._waitTurn('w6', 8000);
  require('../crash.cjs').crash(m._worker('w6').child);
  await m._waitExit('w6', 8000);

  const r = await m.wait({ worker_ids: ['w6'], timeout_ms: 2000 });
  assert.equal(r.worker_id, 'w6');
  assert.equal(r.event, 'dead');
  assert.equal(r.already, true);
  assert.ok(
    Number.isInteger(r.exit_code) || typeof r.exit_signal === 'string',
    'the death carries an exit code or a signal, got ' + JSON.stringify({ exit_code: r.exit_code, exit_signal: r.exit_signal })
  );
  // No latency bound: an already-dead answer holds only for the exit event's code, inside the call's budget.
  await m.shutdown();
});

test('wait on a worker adopted from another session, still alive, echoes the row state, never a dead this adapter never saw', async (t) => {
  const sb = sandbox();
  const core = createFakeCore();
  const m1 = mgr(sb, core);
  // The live fake is released even when an assertion below fails; otherwise the runner never exits.
  t.after(() => m1.shutdown());
  await m1.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w7' });
  await m1._waitTurn('w7', 8000);

  // A second adapter, same store, that never spawned this worker: forWorker adopts it from the row
  // (manager.cjs forWorker) before message() refuses it for having no live stdin here, so the
  // adopted record lands in this manager's map exactly as a real worker_message call would leave it.
  const m2 = mgr(sb, core);
  await assert.rejects(m2.message({ worker_id: 'w7', text: 'x' }), (e) => e.code === 'E_SUBSTRATE');

  const r = await m2.wait({ worker_ids: ['w7'], timeout_ms: 2000 });
  assert.equal(r.worker_id, 'w7');
  assert.equal(r.already, true);
  assert.equal(r.event, 'running', 'the store row still says running and the pid is alive; adopt() never settled it here');
});

test('a stop issued after a worker had already died on its own still answers dead, not stopped', async () => {
  const sb = sandbox();
  const m = mgr(sb, createFakeCore());
  const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w8' });
  await m._waitTurn('w8', 8000);
  require('../crash.cjs').crash(m._worker('w8').child);
  await m._waitExit('w8', 8000);

  const s = await m.stop({ worker_id: 'w8', mode: 'graceful' });
  assert.equal(s.graceful, false, 'nothing was closed; the worker was already gone');
  assert.equal(s.killed, false, 'nothing was killed; the worker was already gone');

  const r = await m.wait({ worker_ids: ['w8'], timeout_ms: 2000 });
  assert.equal(r.event, 'dead', 'the worker died on its own; a stop issued afterward is not credited with it');
  assert.equal(r.already, true);
  await m.shutdown();
});

test('wait with no worker ids watches every worker; refuses when none was launched or the id is unknown', async () => {
  const sb = sandbox();
  const m = mgr(sb, createFakeCore());
  await assert.rejects(m.wait({ timeout_ms: 100 }), (e) => e.code === 'E_ARGS');
  await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w4' });
  await m._waitTurn('w4', 8000);
  const r = await m.wait({ timeout_ms: 2000 });
  assert.deepEqual(r.watched, ['w4']);
  assert.equal(r.event, 'turn_end');
  await assert.rejects(m.wait({ worker_ids: ['nope'], timeout_ms: 100 }), (e) => e.code === 'E_NOT_FOUND');
  await m.shutdown();
});

// Deterministic ordering (review 1 SF2): the child's 'exit' event is held back 2,500 ms, so the 1,000 ms pid
// poll settles the death first and it has no code. On the code before this fix both answers were null.
// The pid poll holds a death for the exit event (worker.cjs POLL_EXIT_HOLD_MS); these tests need the poll to settle
// first, so the hold is off for them (the hold itself is tested in manager-exit-hold.test.cjs).
process.env.BELAY_POLL_EXIT_HOLD_MS = '0';
function delayExit(child, ms) {
  const emit = child.emit;
  child.emit = function (ev, ...a) {
    if (ev === 'exit') { setTimeout(() => emit.call(this, ev, ...a), ms); return true; }
    return emit.call(this, ev, ...a);
  };
}

test('forced lag: a wait running when the pid poll settles a death still answers with the exit code', async () => {
  const sb = sandbox();
  const m = mgr(sb, createFakeCore());
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w10' });
    await m._waitTurn('w10', 8000);
    const w = m._worker('w10');
    w.turnEnded = false;
    delayExit(w.child, 2500);
    const p = m.wait({ worker_ids: ['w10'], timeout_ms: 8000 });
    require('../crash.cjs').crash(m._worker('w10').child);
    const r = await p;
    assert.equal(r.event, 'dead');
    assert.ok(Number.isInteger(r.exit_code) || typeof r.exit_signal === 'string', 'code: ' + JSON.stringify(r));
    assert.match(r.established_by, /pid-poll\+exit-event/, 'the poll settled first, the event filled the code in');
  } finally { await m.shutdown(); }
});

test('forced lag: a wait called after the pid poll settled a death, before its exit event, answers with the code', async () => {
  const sb = sandbox();
  const m = mgr(sb, createFakeCore());
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w11' });
    await m._waitTurn('w11', 8000);
    const w = m._worker('w11');
    delayExit(w.child, 2500);
    require('../crash.cjs').crash(m._worker('w11').child);
    await m._waitExit('w11', 8000);
    assert.ok(w.settled && w.exitCode == null && w.exitSignal == null, 'premise: settled by the poll with no code yet');
    const r = await m.wait({ worker_ids: ['w11'], timeout_ms: 8000 });
    assert.equal(r.already, true);
    assert.ok(Number.isInteger(r.exit_code) || typeof r.exit_signal === 'string', 'code: ' + JSON.stringify(r));
  } finally { await m.shutdown(); }
});

test('forced lag: a relaunch between the poll settle and the old exit event does not hold the wait for its budget', async () => {
  const sb = sandbox();
  const m = mgr(sb, createFakeCore());
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w12' });
    await m._waitTurn('w12', 8000);
    const w = m._worker('w12');
    delayExit(w.child, 60000); // the old child's exit event never arrives inside this test
    require('../crash.cjs').crash(m._worker('w12').child);
    await m._waitExit('w12', 8000);
    const p = m.wait({ worker_ids: ['w12'], timeout_ms: 120000 });
    await new Promise((r) => setTimeout(r, 200));
    await m.restart({ worker_id: 'w12', first_turn_timeout_ms: 20000 });
    const r = await p;
    // Held for the old exit event it waits 60,000 ms (delayExit above), held for its budget 120,000 ms. 45,000 leaves a slow
    // runner room (this whole test took 29.6 s there once); the old budget of 20,000 left a bound of 15,000.
    assert.ok(r.waited_ms < 45000, 'the wait ended on the relaunch, not on its 120,000 ms budget: ' + r.waited_ms);
  } finally { await m.shutdown(); }
});

test('a worker whose executable is missing (spawn error, no exit event ever) is answered by wait at once, not after its budget', async () => {
  const sb = sandbox();
  const m = createRunManager({
    core: createFakeCore(), dataDir: sb.data, runId: 'run-wait',
    paths: { claudeExe: sb.data + '/no-such-claude.exe', codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
  try {
    await assert.rejects(m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w13', startup_timeout_ms: 5000 }), (e) => e.code === 'E_NO_READY');
    const w = m._worker('w13');
    assert.equal(w.deathEstablishedBy, 'spawn-error', 'premise: a spawn error, not a pid check');
    const r = await m.wait({ worker_ids: ['w13'], timeout_ms: 20000 });
    assert.equal(r.event, 'dead');
    assert.equal(r.already, true);
    assert.ok(r.waited_ms < 5000, 'answered at once, not after its 20,000 ms budget: ' + r.waited_ms);
  } finally { await m.shutdown(); }
});
