'use strict';
// park-5.test.cjs — build step 6i, hygiene: four carried
// pause findings each get a test that can fail against the unchanged code (a planted revert must turn
// it red). (h1) drives wake.cjs's `diffWorkers` directly, pure and store-free, the way wake.test.cjs
// does. (h5) drives a real RunManager over tests/run/fakes/fake-claude.cjs, the way park-4.test.cjs's
// (r8) does. (h6) and (h7) drive worker.cjs's `attach` and exit.cjs's `settle` directly with a synthetic
// child (an EventEmitter with stdout/stderr), deterministic, no process — park-4.test.cjs's rebuilt (r7)
// uses the same shape.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { diffWorkers } = require('../../src/run/wake.cjs');
const { newWorkerRecord, attach } = require('../../src/run/worker.cjs');
const { settle } = require('../../src/run/exit.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const RUN = 'run-park5-1';
const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');

// ---------------------------------------------------------------- (h1)
// C2 (src/run/pause.cjs:147, src/run/wake.cjs:56): a turn that ended on its own just before the park's
// own `stopping` write lands, inside one poll, was masked outright — the worker never produced its own
// `turn_end`, only the later `paused`. Design item 1's `park_turns` fixes it: a `stopping` row reports
// every turn up to its own `park_turns` as a live row would, masking only what comes after.
test('wake: a turn that ended on its own just before the pause is reported as turn_end, then paused', () => {
  let prev = {};
  const base = { id: 'w1', run_id: RUN };

  // Poll 0: baseline at running/turns:0 (nothing owed yet).
  ({ next: prev } = diffWorkers({ prev, rows: [{ ...base, state: 'running', turns: 0, seq: 1 }], runId: RUN, nowMs: 0, graceMs: 1500 }));
  assert.deepStrictEqual(prev.w1, { turns: 0, state: 'running' });

  // Poll 1: the turn ended AND the park's step 1b `stopping` write both landed inside this one poll —
  // this adapter never saw an intermediate running/turns:1 row. park_turns (1) says the turn is this
  // park's own acceptance count, so it must be reported now, exactly as a live row's turn_end would be.
  const stopping = diffWorkers({ prev, rows: [{ ...base, state: 'stopping', turns: 1, park_turns: 1, seq: 2 }], runId: RUN, nowMs: 500, graceMs: 1500 });
  assert.deepStrictEqual(stopping.events, [{ worker_id: 'w1', event: 'turn_end', turn: 1, seq: 2 }],
    'a stopping row must still report the turn its own park_turns says already finished');
  prev = stopping.next;

  // Poll 2: the row settles paused. Only the park itself wakes now; the turn already has.
  const paused = diffWorkers({ prev, rows: [{ ...base, state: 'paused', turns: 1, park_turns: 1, paused_by: 'operator:1', seq: 3 }], runId: RUN, nowMs: 800, graceMs: 1500 });
  assert.deepStrictEqual(paused.events, [{ worker_id: 'w1', event: 'paused', turn: 1, seq: 3, paused_by: 'operator:1' }]);
});

// Should-fix (review of build step 6i item 1, wake.cjs:58): only the `stopping` branch read `park_turns`
// — a poll slow enough to miss the intermediate `stopping` row entirely (the turn ended and the row
// settled `paused` between two polls) went straight from `running` to `paused` (`justParked` true on
// first sight of `paused`), and the turn_end this park's own `park_turns` says already finished was
// swallowed outright, never reported at all.
test('wake: a turn that ended on its own is still reported as turn_end even when the poll never saw an intermediate stopping row', () => {
  let prev = {};
  const base = { id: 'w1', run_id: RUN };
  ({ next: prev } = diffWorkers({ prev, rows: [{ ...base, state: 'running', turns: 0, seq: 1 }], runId: RUN, nowMs: 0, graceMs: 1500 }));

  // Poll 1: running/turns:0 -> paused/turns:1/park_turns:1 in one jump; no stopping row was ever seen.
  const r = diffWorkers({ prev, rows: [{ ...base, state: 'paused', turns: 1, park_turns: 1, paused_by: 'operator:1', seq: 2 }], runId: RUN, nowMs: 500, graceMs: 1500 });
  assert.deepStrictEqual(r.events, [
    { worker_id: 'w1', event: 'turn_end', turn: 1, seq: 2 },
    { worker_id: 'w1', event: 'paused', turn: 1, seq: 2, paused_by: 'operator:1' },
  ], 'the turn park_turns says already finished must be reported before the paused event, never swallowed');
});

// ---------------------------------------------------------------- (h5)
// C13, first half (src/run/pause.cjs:62): `isOwnActiveRow` narrowed to a *live* row (design item 6).
function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-park5-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}
function mgr(sb, core) {
  return createRunManager({
    core, dataDir: sb.data, runId: 'run-park5-mgr',
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
}
async function teardown({ m, sb }) {
  if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
  if (sb) cleanup(sb.data);
}

test('resume: a stopped row carrying this adapter\'s pid is not taken for this adapter\'s own write', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    await m.pause({ worker_id: 'w1', by: 'operator:1' });
    const rowBefore = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(rowBefore.state, 'paused');

    // A row this adapter's own manager never itself wrote to 'stopped' this way — planted directly, as
    // (r8) plants 'forgotten' — but its adapter_pid still names this adapter.
    await core.worker.write({ ...rowBefore, state: 'stopped', paused_at: null, paused_by: null });

    await assert.rejects(m.resume({ worker_id: 'w1', by: 'operator:2' }), (e) => { assert.strictEqual(e.code, 'E_SUBSTRATE'); return true; });
    const rowAfter = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(rowAfter.state, 'stopped', 'a stopped row must never be relaunched as this adapter\'s own resume');
  } finally { await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (h6) and (h7)
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.pid = 10000 + Math.floor(Math.random() * 10000);
  return child;
}

// C1, C6 (src/run/worker.cjs:321): the exit handler settles the record only while `w.child === child` —
// a relaunch's own exit-event handler is installed the instant `attach` runs, so the *old* child's own
// late 'exit' (a Codex back-to-back E_NO_READY, and the mechanism behind (r1)'s failure under load) must
// change nothing about the record's current life.
test('settle: an exit event from a child the record no longer holds settles nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-park5-w-'));
  const w = newWorkerRecord({ id: 'w1', substrate: 'claude-code', worktree: dir, dataDir: dir });
  const ctx = { writeRow: async () => {} };
  const child1 = fakeChild();
  attach(w, child1, ctx);
  const child2 = fakeChild();
  attach(w, child2, ctx); // a relaunch replaces the record's own child
  assert.strictEqual(w.child, child2);

  child1.emit('exit', 7, null); // the replaced child's own, late exit
  assert.strictEqual(w.settled, false, 'a replaced child\'s exit must settle nothing');
  assert.strictEqual(w.exitCode, null);
  assert.strictEqual(w.child, child2, 'the current child must be left exactly as it was');
  // Note (6i review, worker.cjs:332): the replaced child's late exit must not resolve the NEW launch's
  // own exitEventSeen with the OLD child's exit code either — only settle() was gated before this fix.
  const raced = await Promise.race([w.exitEventSeen, new Promise((r) => setTimeout(() => r('still-pending'), 50))]);
  assert.strictEqual(raced, 'still-pending', 'the replaced child\'s exit must not resolve the current child\'s own exitEventSeen');
  cleanup(dir);
});

// C11 (src/run/exit.cjs:82, src/run/manager.cjs:106): a pid-poll death of a record that still holds a
// child now waits for that same child's own 'close' event, exactly as the exit-event channel already
// did, so a turn still unread in the pipe wins there too.
// Rebuilt at build step 6i-2 design item 6 (R10): the review found this resolved the waiter by hand
// rather than through the child's own stdout, so exit.cjs's `pendingTurnEnd` guard had no test on the
// pid-poll channel either. `newWorkerRecord`/`attach` wire up the record's real parser; the turn's
// result now arrives as a real stdout `data` event, and `close` is the child's own — no hand-built
// waiter resolution.
test('settle: a pid-poll death of a record holding a child waits for close and reports the turn in the pipe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-park5-h7-'));
  try {
    const w = newWorkerRecord({ id: 'w1', substrate: 'claude-code', worktree: dir, dataDir: dir });
    const ctx = { writeRow: async () => {} };
    const child = fakeChild();
    attach(w, child, ctx);
    const waiterP = new Promise((res) => w.turnWaiters.push((v) => res(v)));

    settle(w, null, null, 'pid-poll', ctx); // the pid is gone; no 'exit' event yet, the child stays attached
    assert.strictEqual(w.settled, true);
    assert.strictEqual(w.turnWaiters.length, 1, "pid-poll alone must not resolve the waiter before the child's own close");

    const resultLine = JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, session_id: 'fake-h7', num_turns: 1,
      total_cost_usd: 0.001, result: '', usage: { output_tokens: 1 },
    }) + '\n';
    child.stdout.emit('data', Buffer.from(resultLine));
    child.emit('close');

    const r = await waiterP;
    assert.ok(r.usage, 'a completed turn must report its own usage, not the exit');
    assert.strictEqual(r.exited, undefined, 'the turn must win; pid-poll\'s own facts must never answer this waiter');
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------- (h8)
// Verifier failure 1 (manager.test.cjs regression): item 7a's `w.child === child` guard, meant only to
// silence a relaunch's replaced child, also silenced this same, single child's own 'exit' event once a
// pid-poll settle (item 7b) had already nulled `w.child` first — so a plain kill's real exit code was
// lost, not merely delayed. `w.settledChild` (exit.cjs, worker.cjs) tells the two cases apart.
test('settle: a pid-poll death still lets this same child\'s own later exit event fill in the real exit code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-park5-w2-'));
  const w = newWorkerRecord({ id: 'w1', substrate: 'claude-code', worktree: dir, dataDir: dir });
  const writes = [];
  const ctx = { writeRow: async (ww, state) => { writes.push({ state, exitCode: ww.exitCode }); } };
  const child = fakeChild();
  attach(w, child, ctx);

  settle(w, null, null, 'pid-poll', ctx); // the manager's poll found the pid gone before the exit event
  assert.strictEqual(w.settled, true);
  assert.strictEqual(w.exitCode, null);
  assert.strictEqual(w.child, null, 'settle() clears the record\'s own child once settled');

  child.emit('exit', 7, null); // the OS event for that SAME child, arriving after pid-poll settled it
  assert.strictEqual(w.exitCode, 7, 'the same child\'s own late exit event must still fill in the real code');
  await w.queue; // the fill-in write is queued (exit.cjs settle()'s already-settled branch), not synchronous
  assert.ok(writes.some((x) => x.exitCode === 7), 'the fill-in write must carry the real exit code');
  cleanup(dir);
});
