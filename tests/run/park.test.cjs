'use strict';
// park.test.cjs — build step 6e-4, ADR 0023 amendment 2, a
// real RunManager over tests/run/fakes/fake-claude.cjs (fake-claude-with-child.cjs for p4/p12, fake-codex.cjs
// for p6), with tests/run/fake-core.cjs standing in for the store. Replaces pause.test.cjs/pause-bg.test.cjs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunManager, createWorkerControl } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');
const { Client } = require('../../src/core/client.cjs');
const { createParser } = require('../../src/run/parsers.cjs');
const P = require('../../src/run/process.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const FAKE_WITH_CHILD = path.join(__dirname, 'fakes', 'fake-claude-with-child.cjs').replace(/\\/g, '/');
const FAKE_CODEX = path.join(__dirname, 'fakes', 'fake-codex.cjs').replace(/\\/g, '/');
const CALLER_OPERATOR = { role: 'operator', run_id: 'cli', pid: process.pid };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-park-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}
function mgr(sb, core, exe = FAKE) {
  return createRunManager({
    core, dataDir: sb.data, runId: 'run-park-test',
    paths: { claudeExe: exe, codexExe: exe, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
}
async function teardown({ client, control, m, sb }) {
  if (client) { try { await client.close(); } catch { /* best effort */ } }
  if (control) { try { await control.close(); } catch { /* best effort */ } }
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

// ---------------------------------------------------------------- (p1)
test('park: a mid-turn worker is interrupted, its process exits, and its row is paused with the session id and no live pid; the receipt names the interrupt, the results seen and the exit', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  process.env.FAKE_ANSWER_DELAY_MS = '8000';
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await sleep(300); // the spawn's own turn is in flight, held by FAKE_ANSWER_DELAY_MS
    const pid = m._worker('w1').pid;
    const r = await m.pause({ worker_id: 'w1', by: 'operator:999' });
    assert.strictEqual(r.paused, true);
    assert.strictEqual(r.already, false);
    assert.strictEqual(r.paused_by, 'operator:999');
    assert.strictEqual(r.interrupt.sent, true);
    assert.strictEqual(r.interrupt.response_subtype, 'success');
    assert.ok(r.interrupt.request_id.startsWith('belay-pause-'), r.interrupt.request_id);
    assert.ok(r.results_after_interrupt.includes('error_during_execution'), JSON.stringify(r.results_after_interrupt));
    assert.strictEqual(r.interrupted, true);
    assert.strictEqual(r.exit.graceful, true, JSON.stringify(r.exit));
    assert.strictEqual(r.session_id, m._worker('w1').sessionId);
    assert.strictEqual(r.row.state, 'paused');
    assert.strictEqual(r.row.paused_by, 'operator:999');
    assert.strictEqual(r.row.session_id, r.session_id);
    assert.strictEqual(P.pidAlive(pid), false, 'the worker process must be dead once parked');
    assert.strictEqual(r.cache_deadline.enforced, false);
  } finally {
    delete process.env.FAKE_ANSWER_DELAY_MS;
    await teardown({ m, sb });
  }
});

// ---------------------------------------------------------------- (p2)
test('park: a worker between turns is interrupted harmlessly and parked, and interrupted is false', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    const r = await m.pause({ worker_id: 'w1', by: 'operator:1' });
    assert.strictEqual(r.paused, true);
    assert.strictEqual(r.interrupt.sent, true, 'the interrupt is written unconditionally, even between turns');
    assert.strictEqual(r.interrupt.response_subtype, 'success');
    assert.strictEqual(r.interrupted, false);
    assert.deepStrictEqual(r.results_after_interrupt, []);
    assert.strictEqual(r.row.state, 'paused');
  } finally { await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (p3)
test('park: every background task seen running gets stop_task, the receipt names each, and no descendant outlives the exit', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  const pidFile = path.join(sb.data, 'orphan.pid');
  process.env.FAKE_BG_TASK = '1';
  process.env.FAKE_BG_TASK_MS = '30000';
  process.env.FAKE_ORPHAN_CHILD = '1';
  process.env.FAKE_CHILD_PID_FILE = pidFile;
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000); // the turn that backgrounded the task has ended
    const orphanPid = Number(fs.readFileSync(pidFile, 'utf8'));
    const r = await m.pause({ worker_id: 'w1', by: 'operator:1' });
    assert.strictEqual(r.background_tasks.length, 1, JSON.stringify(r.background_tasks));
    assert.strictEqual(r.background_tasks[0].status_after, 'killed');
    assert.strictEqual(r.background_tasks[0].response_subtype, 'success');
    assert.ok(r.background_tasks[0].task_id.startsWith('bgtask_'));
    assert.ok(r.background_tasks[0].request_id.startsWith('belay-stop-task-'));
    assert.ok(r.descendants.before_close.includes(orphanPid), JSON.stringify(r.descendants));
    // The orphan is spawned detached, its own process group, so a graceful exit's own job-object
    // teardown does not take it — only doPause's own step 5 kill loop does.
    assert.ok(r.descendants.killed_after_exit.includes(orphanPid), JSON.stringify(r.descendants));
    assert.strictEqual(P.pidAlive(orphanPid), false, 'the orphaned descendant must not outlive the exit');
  } finally {
    delete process.env.FAKE_BG_TASK; delete process.env.FAKE_BG_TASK_MS;
    delete process.env.FAKE_ORPHAN_CHILD; delete process.env.FAKE_CHILD_PID_FILE;
    await teardown({ m, sb });
  }
});

// ---------------------------------------------------------------- (p4)
test('park: a worker that ignores stdin close is killed by exact pid within the bound and is still parked', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core, FAKE_WITH_CHILD);
  const pidFile = path.join(sb.data, 'child.pid');
  process.env.FAKE_CHILD_PID_FILE = pidFile;
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._worker('w1'); // ready once system/init lands (waitReady resolves inside spawn already)
    const pid = m._worker('w1').pid;
    const childPid = await pollUntil(() => fs.existsSync(pidFile), 5000) ? Number(fs.readFileSync(pidFile, 'utf8')) : null;
    assert.ok(childPid, 'the fake never wrote its own child pid');
    const t0 = Date.now();
    const r = await m.pause({ worker_id: 'w1', by: 'operator:1', interrupt_timeout_ms: 300, exit_timeout_ms: 800 });
    const ms = Date.now() - t0;
    // ADR 0048 decision 8 (a): the park's three identity snapshots are not what this bound is about; its own receipt names them.
    assert.ok(Number.isFinite(r.snapshot_ms) && r.snapshot_ms >= 0, 'the pause receipt must name the time spent on snapshots');
    assert.ok(ms - r.snapshot_ms < 15000, `pause took ${ms} ms (${r.snapshot_ms} ms of it snapshots), expected well under the bound`);
    assert.strictEqual(r.paused, true);
    assert.strictEqual(r.exit.graceful, false);
    assert.strictEqual(r.exit.killed, true);
    assert.strictEqual(r.row.state, 'paused');
    assert.strictEqual(P.pidAlive(pid), false);
    assert.strictEqual(P.pidAlive(childPid), false, 'the tree kill must take the child with it');
  } finally { delete process.env.FAKE_CHILD_PID_FILE; await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (p5)
test('park: while parking or paused, message and restart are refused E_PAUSED and nothing reaches stdin', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    process.env.FAKE_IGNORE_STDIN_END = '1'; // 6e-6 item 7: before the fake spawns — read only at its own module load
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);

    // In-flight half: ignoring stdin close keeps the park running for exit_timeout_ms — message reads
    // E_PAUSED, restart E_BUSY(pause), while parkRequested is set but the park is not done.
    const turnsInFlight = core.currentWorker('w1').turns;
    const parkP = m.pause({ worker_id: 'w1', by: 'operator:7', exit_timeout_ms: 2000 });
    assert.ok(await pollUntil(() => !!m._worker('w1').parkRequested, 2000), 'parkRequested was never set');
    await assert.rejects(m.message({ worker_id: 'w1', text: 'mid-flight' }),
      (e) => { assert.strictEqual(e.code, 'E_PAUSED'); assert.strictEqual(e.detail.paused_by, 'operator:7'); return true; });
    await assert.rejects(m.restart({ worker_id: 'w1' }),
      (e) => { assert.strictEqual(e.code, 'E_BUSY'); assert.strictEqual(e.detail.op, 'pause'); return true; });
    assert.strictEqual(core.currentWorker('w1').turns, turnsInFlight, 'a refused message or restart must not start a turn');
    const paused = await parkP;
    assert.strictEqual(paused.paused, true);
    delete process.env.FAKE_IGNORE_STDIN_END;

    const turnsBefore = core.currentWorker('w1').turns;
    await assert.rejects(m.message({ worker_id: 'w1', text: 'hello' }), (e) => {
      assert.strictEqual(e.code, 'E_PAUSED');
      assert.strictEqual(e.detail.paused_by, 'operator:7');
      return true;
    });
    await assert.rejects(m.restart({ worker_id: 'w1' }), (e) => { assert.strictEqual(e.code, 'E_PAUSED'); return true; });
    assert.strictEqual(core.currentWorker('w1').turns, turnsBefore, 'a refused message or restart must not start a turn');
    const stopped = await m.stop({ worker_id: 'w1', mode: 'kill', timeout_ms: 5000 });
    assert.strictEqual(stopped.pid, m._worker('w1').pid);
  } finally { delete process.env.FAKE_IGNORE_STDIN_END; await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (p6)
test('park: a codex worker is refused E_SUBSTRATE, an adopted one naming adoption, a dead one E_WORKER_NOT_LIVE, and a starting one naming starting; none writes a row', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const mCodex = mgr(sb, core, FAKE_CODEX);
  const m = mgr(sb, core);
  let hung = null;
  try {
    await mCodex.spawn({ substrate: 'codex', worktree: sb.worktree, prompt: 'one', worker_id: 'w-codex' });
    await mCodex._waitTurn('w-codex', 8000);
    // Codex is one process per turn: the turn end's own row write and the exit event's settle() write
    // can both still be in flight when `_waitTurn` resolves (it resolves at the turn waiters, before
    // either write lands); wait them both out before taking the "before" snapshot.
    await pollUntil(() => mCodex._worker('w-codex').settled === true, 5000);
    await mCodex._worker('w-codex').queue;
    const rowsBefore = core.rowsFor('w-codex').length;
    await assert.rejects(mCodex.pause({ worker_id: 'w-codex', by: 'operator:1' }), (e) => {
      assert.strictEqual(e.code, 'E_SUBSTRATE');
      assert.strictEqual(e.detail.substrate, 'codex');
      assert.match(e.message, /docked for Codex/);
      return true;
    });
    assert.strictEqual(core.rowsFor('w-codex').length, rowsBefore);

    hung = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
    await core.worker.write({ id: 'w-adopted', run_id: 'run-park-test', substrate: 'claude-code', pid: hung.pid, state: 'running', worktree: sb.worktree, session_id: 'sess-adopted', turns: 0, started_at: Date.now() });
    const rowsBefore2 = core.rowsFor('w-adopted').length;
    await assert.rejects(m.pause({ worker_id: 'w-adopted', by: 'operator:1' }), (e) => {
      assert.strictEqual(e.code, 'E_SUBSTRATE');
      assert.strictEqual(e.detail.adopted, true);
      return true;
    });
    assert.strictEqual(core.rowsFor('w-adopted').length, rowsBefore2);

    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-dead' });
    const pid = m._worker('w-dead').pid;
    require('../crash.cjs').crash(m._worker('w-dead').child);
    await m._waitExit('w-dead', 5000);
    await m._worker('w-dead').queue; // the exit's own 'dead' row write, still in flight when waitExit resolves
    // W2-3 (amendment 2, SF4): in a git worktree the head_sha follow-up row is queued when git answers; wait for it
    // here so the row count below never depends on how slow git happens to be.
    if (m._worker('w-dead').headPromise) { await m._worker('w-dead').headPromise; await m._worker('w-dead').queue; }
    const rowsBefore3 = core.rowsFor('w-dead').length;
    await assert.rejects(m.pause({ worker_id: 'w-dead', by: 'operator:1' }), (e) => {
      assert.strictEqual(e.code, 'E_WORKER_NOT_LIVE');
      assert.strictEqual(e.detail.pid, pid);
      assert.strictEqual(e.detail.adopted, undefined, 'a spawned-then-died worker must never read as adopted');
      return true;
    });
    assert.strictEqual(core.rowsFor('w-dead').length, rowsBefore3);

    // A worker mid-relaunch (readyAt reset by launch(), not yet through its own ready gate) is refused
    // naming 'starting', deterministically: the operation slot is not what this sub-case is testing (p12
    // covers E_BUSY), so `readyAt` is cleared directly on the record, exactly as launch() itself does.
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-restarting' });
    await m._waitTurn('w-restarting', 8000);
    const wRestarting = m._worker('w-restarting');
    const savedReadyAt = wRestarting.readyAt;
    wRestarting.readyAt = null;
    const rowsBefore4 = core.rowsFor('w-restarting').length;
    try {
      await assert.rejects(m.pause({ worker_id: 'w-restarting', by: 'operator:1' }), (e) => {
        assert.strictEqual(e.code, 'E_ARGS');
        assert.strictEqual(e.detail.state, 'starting');
        return true;
      });
    } finally { wRestarting.readyAt = savedReadyAt; }
    assert.strictEqual(core.rowsFor('w-restarting').length, rowsBefore4);
  } finally {
    delete process.env.FAKE_ANSWER_DELAY_MS;
    if (hung && hung.exitCode === null) { try { require('../crash.cjs').crash(hung); } catch { /* best effort */ } }
    await teardown({ m: mCodex, sb: null });
    await teardown({ m, sb });
  }
});

// ---------------------------------------------------------------- (p7)
test('resume: a parked worker is relaunched on its session with the resume line and the task resume line when a turn was interrupted, and the slot is free before its first turn ends', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  // A gate file holds every turn of this test's workers (the first, interrupted one and the resumed one) until
  // the test releases it, so "resume does not await the first turn" is asserted against a turn that is
  // provably still running when resume returns, not against a wall-clock guess.
  const gate = path.join(sb.data, 'answer-gate').replace(/\\/g, '/');
  process.env.FAKE_ANSWER_GATE_FILE = gate;
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1', task_id: 't-1' });
    await sleep(300);
    const paused = await m.pause({ worker_id: 'w1', by: 'operator:1' });
    assert.strictEqual(paused.interrupted, true);
    const sessionBefore = paused.session_id;
    const r = await m.resume({ worker_id: 'w1', by: 'operator:2' });
    assert.strictEqual(r.resumed, true);
    assert.strictEqual(r.interrupted, true);
    assert.strictEqual(r.session_id, sessionBefore);
    assert.notStrictEqual(r.new_pid, paused.row.pid);
    assert.strictEqual(r.first_turn_awaited, false);
    assert.strictEqual(m._worker('w1').op, null, 'the slot must be free once resume resolves, before the turn ends');
    // The resumed turn is gated, so it cannot have answered yet: resume returned while it was still running.
    assert.ok(!fs.existsSync(gate));
    assert.doesNotMatch(m._worker('w1').lastAssistantText, /paused you a moment ago/, 'the resumed turn had already ended when resume returned');
    fs.writeFileSync(gate, '');
    // m.wait, not the raw _waitTurn: the released turn can end before this line runs; wait
    // answers `already` for a turn that has landed, where the bare per-call waiter would miss it.
    const waited = await m.wait({ worker_ids: ['w1'], timeout_ms: 8000 });
    assert.strictEqual(waited.timed_out, false, 'the resumed worker\'s next turn never ended');
    const w = m._worker('w1');
    assert.match(w.lastAssistantText, /paused you a moment ago/);
    assert.match(w.lastAssistantText, /t-1/);
  } finally {
    delete process.env.FAKE_ANSWER_GATE_FILE;
    await teardown({ m, sb });
  }
});

// ---------------------------------------------------------------- (p8)
test('resume: a worker parked between turns is relaunched with the pause-over line, plus the operator\'s message when given', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    await m.pause({ worker_id: 'w1', by: 'operator:1' });
    const r1 = await m.resume({ worker_id: 'w1', by: 'operator:2' });
    assert.strictEqual(r1.interrupted, false);
    assert.strictEqual((await m.wait({ worker_ids: ['w1'], timeout_ms: 8000 })).timed_out, false); // m.wait: the turn can end before this line
    assert.match(m._worker('w1').lastAssistantText, /pause is over/);

    await m.pause({ worker_id: 'w1', by: 'operator:1' });
    const r2 = await m.resume({ worker_id: 'w1', by: 'operator:2', message: 'carry on' });
    assert.ok(r2.text_bytes > Buffer.byteLength('carry on', 'utf8'), 'the pause-over line plus the message must both be sent');
    assert.strictEqual((await m.wait({ worker_ids: ['w1'], timeout_ms: 8000 })).timed_out, false);
    assert.match(m._worker('w1').lastAssistantText, /pause is over/);
    assert.match(m._worker('w1').lastAssistantText, /carry on/);
  } finally { await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (p9)
test('resume: a worker parked by another adapter is resumed by this one from the store', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m1 = mgr(sb, core);
  let m2 = null;
  try {
    await m1.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m1._waitTurn('w1', 8000);
    const paused = await m1.pause({ worker_id: 'w1', by: 'operator:1' });
    assert.strictEqual(paused.paused, true);
    m2 = mgr(sb, core);
    const r = await m2.resume({ worker_id: 'w1', by: 'operator:2' });
    assert.strictEqual(r.resumed, true);
    assert.strictEqual(r.session_id, paused.session_id);
    assert.strictEqual(r.interrupted, false, 'an adopted parked record carries no interrupted fact');
  } finally { if (m2) await m2.shutdown().catch(() => {}); await teardown({ m: m1, sb }); }
});

// ---------------------------------------------------------------- (p10)
test('resume: a worker that is not paused is E_ARGS naming its state', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    await assert.rejects(m.resume({ worker_id: 'w1', by: 'operator:1' }), (e) => {
      assert.strictEqual(e.code, 'E_ARGS');
      assert.match(e.message, /not paused/);
      assert.strictEqual(e.detail.state, 'running');
      return true;
    });
  } finally { await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (p11)
test('wait: a parked worker answers event paused established by the exit and the park, and a turn ending during the park is reported paused', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  process.env.FAKE_ANSWER_DELAY_MS = '2000';
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await sleep(300);
    const waitP = m.wait({ worker_ids: ['w1'], timeout_ms: 8000 });
    const paused = await m.pause({ worker_id: 'w1', by: 'operator:1' });
    assert.strictEqual(paused.paused, true);
    const w1 = await waitP;
    assert.strictEqual(w1.event, 'paused');
    assert.notStrictEqual(w1.event, 'turn_failed');
    assert.match(w1.established_by, /pause interrupted the turn/);

    const already = await m.wait({ worker_ids: ['w1'], timeout_ms: 1000 });
    assert.strictEqual(already.already, true);
    assert.strictEqual(already.event, 'paused');
    assert.match(already.established_by, /parked by operator:1/);
  } finally { delete process.env.FAKE_ANSWER_DELAY_MS; await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (p12)
test('operations: a second pause shares the first, a resume or restart during a pause is E_BUSY naming it, and a stop during a pause waits for it and then stops', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core, FAKE_WITH_CHILD);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    const p1 = m.pause({ worker_id: 'w1', by: 'operator:1', interrupt_timeout_ms: 500, exit_timeout_ms: 1000 });
    const p2 = m.pause({ worker_id: 'w1', by: 'operator:2' });
    await sleep(100); // both are now sharing the one in-flight 'pause' operation
    await assert.rejects(m.resume({ worker_id: 'w1', by: 'operator:3' }), (e) => {
      assert.strictEqual(e.code, 'E_BUSY');
      assert.strictEqual(e.detail.op, 'pause');
      return true;
    });
    await assert.rejects(m.restart({ worker_id: 'w1' }), (e) => {
      assert.strictEqual(e.code, 'E_BUSY');
      assert.strictEqual(e.detail.op, 'pause');
      return true;
    });
    const stopP = m.stop({ worker_id: 'w1', mode: 'kill', timeout_ms: 5000 });
    const [r1, r2, stopResult] = await Promise.all([p1, p2, stopP]);
    assert.deepStrictEqual(r1, r2, 'two concurrent pauses of the same worker must share one receipt');
    assert.strictEqual(r1.paused, true);
    assert.ok(stopResult, 'a stop waiting out a pause must still resolve, never reject');
  } finally { await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (p13)
test('worker control: worker.pause and worker.resume over the pipe take paused_by from the caller, never from the arguments', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  let control = null; let client = null;
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    control = createWorkerControl({ redeem: null, dataDir: sb.data, manager: m });
    await control.listen();
    client = new Client(sb.data, { pipe: control.pipe, elect: false });
    await client.connect();
    const r = await client.call('worker.pause', { worker_id: 'w1', by: 'orchestrator:1', caller: CALLER_OPERATOR });
    assert.strictEqual(r.paused_by, `operator:${CALLER_OPERATOR.pid}`, 'paused_by must come from the caller, not the by argument');
    const r2 = await client.call('worker.resume', { worker_id: 'w1', by: 'orchestrator:2', caller: CALLER_OPERATOR });
    assert.strictEqual(r2.resumed_by, `operator:${CALLER_OPERATOR.pid}`);
  } finally { await teardown({ client, control, m, sb }); }
});

// ---------------------------------------------------------------- (p14)
test('park: after a restart, background tasks and the park state of the previous process are gone', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  process.env.FAKE_BG_TASK = '1';
  process.env.FAKE_BG_TASK_MS = '30000';
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    const w = m._worker('w1');
    assert.strictEqual(w.bgTasks.size, 1, 'the backgrounded task must be tracked before the restart');
    delete process.env.FAKE_BG_TASK; delete process.env.FAKE_BG_TASK_MS; // the relaunch's own turn must not add a fresh one
    await m.restart({ worker_id: 'w1' });
    assert.strictEqual(w.bgTasks.size, 0, 'a restart must clear the previous process\'s background tasks');
    assert.strictEqual(w.parkRequested, null);
    assert.strictEqual(w.paused, null);
  } finally { delete process.env.FAKE_BG_TASK; delete process.env.FAKE_BG_TASK_MS; await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- parsers (moved verbatim from 6e/6e-3)
test('parser: a control_response line becomes a control_response event carrying its request id and subtype', () => {
  const parser = createParser('claude-code');
  const line = JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'req_abc', response: { still_queued: [] } } });
  const { events } = parser.pushChunk(Buffer.from(line + '\n'));
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].kind, 'control_response');
  assert.strictEqual(events[0].request_id, 'req_abc');
  assert.strictEqual(events[0].subtype, 'success');
  assert.strictEqual(events[0].error, null);
});

test('parser: task_started, background_tasks_changed, task_updated and task_notification become bg_task events, and a foreground task_started does not', () => {
  const parser = createParser('claude-code');
  const started = JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 't1', is_backgrounded: true, description: 'sleep 20' });
  const foreground = JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 't2', is_backgrounded: false });
  const list = JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1' }] });
  const status = JSON.stringify({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'killed' } });
  const notified = JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' });
  const { events } = parser.pushChunk(Buffer.from([started, foreground, list, status, notified].join('\n') + '\n'));
  assert.strictEqual(events.length, 5, JSON.stringify(events));
  assert.strictEqual(events[0].kind, 'bg_task'); assert.strictEqual(events[0].op, 'started'); assert.strictEqual(events[0].task_id, 't1'); assert.strictEqual(events[0].description, 'sleep 20');
  assert.strictEqual(events[1].kind, 'raw', 'a foreground task_started must not become bg_task');
  assert.strictEqual(events[2].kind, 'bg_task'); assert.strictEqual(events[2].op, 'list'); assert.deepStrictEqual(events[2].tasks, ['t1']);
  assert.strictEqual(events[3].kind, 'bg_task'); assert.strictEqual(events[3].op, 'status'); assert.strictEqual(events[3].status, 'killed');
  assert.strictEqual(events[4].kind, 'bg_task'); assert.strictEqual(events[4].op, 'notified'); assert.strictEqual(events[4].status, 'completed');
});
