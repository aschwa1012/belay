'use strict';
// wake.test.cjs — build step 5b, Done item 1.
// `diffWorkers` and `wakeText` are pure and store-free: every case here drives them with plain row
// objects, the shape `worker.list` returns (methods-run.cjs `decorate` plus this step's `mid_turn`
// and `death_established_by`). No process, no store, no I/O.

const test = require('node:test');
const assert = require('node:assert');

const { diffWorkers, wakeText } = require('../../src/run/wake.cjs');

const RUN = 'run-wake-1';

test('diffWorkers: a worker seen for the first time baselines at 0, and wakes when its turns is already 1', () => {
  const rows = [{ id: 'w1', run_id: RUN, state: 'running', turns: 1, seq: 5 }];
  const { events, next } = diffWorkers({ prev: {}, rows, runId: RUN });
  assert.deepEqual(events, [{ worker_id: 'w1', event: 'turn_end', turn: 1, seq: 5 }]);
  assert.deepEqual(next.w1, { turns: 1, state: 'running' });
});

test('diffWorkers: a worker first seen dead before the baseline began, or stopped, wakes nothing, and is baselined as seen', () => {
  const rows = [
    { id: 'w2', run_id: RUN, state: 'dead', turns: 3, seq: 1, exit_code: 1, exit_signal: null, death_established_by: 'exit-event', exited_at: 4000 },
    { id: 'w3', run_id: RUN, state: 'stopped', turns: 2, seq: 2 },
  ];
  const { events, next } = diffWorkers({ prev: {}, rows, runId: RUN, sinceAt: 5000 });
  assert.deepEqual(events, []);
  assert.deepEqual(next.w2, { turns: 3, state: 'dead' });
  assert.deepEqual(next.w3, { turns: 2, state: 'stopped' });
});

test('diffWorkers: a turns increase of 1 wakes once with that turn', () => {
  const prev = { w4: { turns: 1, state: 'running' } };
  const rows = [{ id: 'w4', run_id: RUN, state: 'running', turns: 2, seq: 9 }];
  const { events } = diffWorkers({ prev, rows, runId: RUN });
  assert.deepEqual(events, [{ worker_id: 'w4', event: 'turn_end', turn: 2, seq: 9 }]);
});

test('diffWorkers: an increase of 3 wakes once with turns_skipped: 2', () => {
  const prev = { w5: { turns: 1, state: 'running' } };
  const rows = [{ id: 'w5', run_id: RUN, state: 'running', turns: 4, seq: 11 }];
  const { events } = diffWorkers({ prev, rows, runId: RUN });
  assert.deepEqual(events, [{ worker_id: 'w5', event: 'turn_end', turn: 4, seq: 11, turns_skipped: 2 }]);
});

test('diffWorkers: a running to dead transition wakes a death carrying the row\'s exit_code, exit_signal and death_established_by', () => {
  const prev = { w6: { turns: 2, state: 'running' } };
  const rows = [{
    id: 'w6', run_id: RUN, state: 'dead', turns: 2, seq: 20,
    exit_code: 137, exit_signal: null, death_established_by: 'pid-poll',
  }];
  const { events } = diffWorkers({ prev, rows, runId: RUN });
  assert.deepEqual(events, [{
    worker_id: 'w6', event: 'death', turn: 2, seq: 20,
    exit_code: 137, exit_signal: null, death_established_by: 'pid-poll',
  }]);
});

test('diffWorkers: running to stopped wakes nothing', () => {
  const prev = { w7: { turns: 2, state: 'running' } };
  const rows = [{ id: 'w7', run_id: RUN, state: 'stopped', turns: 2, seq: 21 }];
  const { events, next } = diffWorkers({ prev, rows, runId: RUN });
  assert.deepEqual(events, []);
  assert.deepEqual(next.w7, { turns: 2, state: 'stopped' });
});

test('diffWorkers: a row of another run_id is ignored, and never baselined', () => {
  const rows = [{ id: 'w8', run_id: 'some-other-run', state: 'running', turns: 5, seq: 1 }];
  const { events, next } = diffWorkers({ prev: {}, rows, runId: RUN });
  assert.deepEqual(events, []);
  assert.deepEqual(next, {}, 'a row of another run must not be baselined at all');
});

test('diffWorkers: a non-terminal row whose pid is dead is a pending death inside the grace, and stamps pid_dead_seen_at_ms on first sight', () => {
  const row = { id: 'w9', run_id: RUN, state: 'starting', turns: 0, seq: 30, pid_alive: false };
  const first = diffWorkers({ prev: {}, rows: [row], runId: RUN, nowMs: 1000, graceMs: 1500 });
  assert.deepEqual(first.events, []);
  assert.deepEqual(first.pending_deaths, [{ worker_id: 'w9', seen_at_ms: 1000, waited_ms: 0 }]);
  assert.equal(first.next.w9.pid_dead_seen_at_ms, 1000);

  const second = diffWorkers({ prev: first.next, rows: [row], runId: RUN, nowMs: 2400, graceMs: 1500 });
  assert.deepEqual(second.events, []);
  assert.deepEqual(second.pending_deaths, [{ worker_id: 'w9', seen_at_ms: 1000, waited_ms: 1400 }]);
});

test('diffWorkers: a pending death past the grace is no longer pending, and a dead row inside it wakes a death and clears it', () => {
  const startingRow = { id: 'w10', run_id: RUN, state: 'starting', turns: 0, seq: 31, pid_alive: false };
  const baseline = diffWorkers({ prev: {}, rows: [startingRow], runId: RUN, nowMs: 1000, graceMs: 1500 }).next;

  const pastGrace = diffWorkers({ prev: baseline, rows: [startingRow], runId: RUN, nowMs: 2600, graceMs: 1500 });
  assert.deepEqual(pastGrace.events, []);
  assert.deepEqual(pastGrace.pending_deaths, []);

  const deadRow = {
    id: 'w10', run_id: RUN, state: 'dead', turns: 0, seq: 32, pid_alive: false,
    exit_code: null, exit_signal: 'SIGKILL', death_established_by: 'exit-event',
  };
  const settled = diffWorkers({ prev: baseline, rows: [deadRow], runId: RUN, nowMs: 1300, graceMs: 1500 });
  assert.deepEqual(settled.events, [{
    worker_id: 'w10', event: 'death', turn: 0, seq: 32,
    exit_code: null, exit_signal: 'SIGKILL', death_established_by: 'exit-event',
  }]);
  assert.deepEqual(settled.pending_deaths, []);
  assert.ok(!('pid_dead_seen_at_ms' in settled.next.w10), 'pid_dead_seen_at_ms must not survive onto a terminal row');
});

test('diffWorkers: a row seen alive again clears pid_dead_seen_at_ms, and a first-sight dead row from before the baseline is neither a wake nor a pending death', () => {
  const startingRow = { id: 'w11', run_id: RUN, state: 'starting', turns: 0, seq: 33, pid_alive: false };
  const baseline = diffWorkers({ prev: {}, rows: [startingRow], runId: RUN, nowMs: 1000, graceMs: 1500 }).next;

  const aliveAgain = { id: 'w11', run_id: RUN, state: 'starting', turns: 0, seq: 34, pid_alive: true };
  const revived = diffWorkers({ prev: baseline, rows: [aliveAgain], runId: RUN, nowMs: 1200, graceMs: 1500 });
  assert.deepEqual(revived.events, []);
  assert.deepEqual(revived.pending_deaths, []);
  assert.ok(!('pid_dead_seen_at_ms' in revived.next.w11), 'a live pid must clear pid_dead_seen_at_ms');

  const firstSightDead = { id: 'w12', run_id: RUN, state: 'dead', turns: 1, seq: 35, pid_alive: false, exit_code: 1, exit_signal: null, death_established_by: 'exit-event', exited_at: 100 };
  const firstSight = diffWorkers({ prev: {}, rows: [firstSightDead], runId: RUN, nowMs: 5000, graceMs: 1500, sinceAt: 200 });
  assert.deepEqual(firstSight.events, []);
  assert.deepEqual(firstSight.pending_deaths, []);
  assert.deepEqual(firstSight.next.w12, { turns: 1, state: 'dead' });
});

test('wakeText: a turn_end message carries only the id, the turn and the fixed sentence, under 400 bytes, no worker output', () => {
  const text = wakeText({ worker_id: 'w-abc', event: 'turn_end', turn: 3, seq: 40 });
  assert.equal(text, 'belay: worker w-abc finished turn 3.'); // the pointer to the store (task_list, briefing or memory_search) is gone: the prompt says where a hand-back is read
  assert.ok(Buffer.byteLength(text, 'utf8') < 400, `wake text is ${Buffer.byteLength(text, 'utf8')} bytes`);
});

test('wakeText: a death message carries only the id, the turn, the exit facts and the fixed sentence, under 400 bytes, no worker output', () => {
  const text = wakeText({
    worker_id: 'w-def', event: 'death', turn: 2, seq: 41,
    exit_code: 137, exit_signal: null, death_established_by: 'exit-event',
  });
  assert.equal(
    text,
    "belay: worker w-def died during turn 2 (exit code 137, signal null, established by exit-event). Its rows are in the store: task_list, briefing."
  );
  assert.ok(Buffer.byteLength(text, 'utf8') < 400, `wake text is ${Buffer.byteLength(text, 'utf8')} bytes`);
});

// build step 6f, design item 1, ADR 0023 amendment 3
// decision 3.

test('diffWorkers: a row first reading paused emits one paused event and no turn_end for the interrupted turn', () => {
  const prev = { w13: { turns: 2, state: 'running' } };
  // turns moved 2 -> 3 (the interrupted turn), which alone would be a turn_end (see the plain
  // turns-increase test above); the row reading paused must pre-empt that entirely.
  const rows = [{ id: 'w13', run_id: RUN, state: 'paused', turns: 3, seq: 50, paused_by: 'operator:123' }];
  const { events, next } = diffWorkers({ prev, rows, runId: RUN, nowMs: 1000, graceMs: 1500 });
  assert.deepEqual(events, [{ worker_id: 'w13', event: 'paused', turn: 3, seq: 50, paused_by: 'operator:123' }]);
  assert.deepEqual(next.w13, { turns: 3, state: 'paused' });
});

// Fix round (finding 6): a park reuses the ordinary graceful stop, which can write an intermediate
// `stopping` row that already carries the interrupted turn's bumped count before the row ever reads
// `paused` — the two-step move the reviewer's own probe saw and the fake substrate exits too fast to
// show. `stopping` must not fire its own `turn_end` for that bump; the `paused` event, one poll later,
// is the only wake this turn produces.
test('diffWorkers: a row reading stopping mid-park defers the interrupted turn, and paused announces it alone', () => {
  const prev = { w15: { turns: 2, state: 'running' } };
  const stopping = diffWorkers({ prev, rows: [{ id: 'w15', run_id: RUN, state: 'stopping', turns: 3, seq: 51 }], runId: RUN, nowMs: 1000, graceMs: 1500 });
  assert.deepEqual(stopping.events, [], 'a stopping row must not wake a turn_end for the bump a park is about to explain');
  assert.deepEqual(stopping.next.w15, { turns: 2, state: 'stopping' }, 'the baseline holds at the pre-stop turns until the row settles');

  const paused = diffWorkers({ prev: stopping.next, rows: [{ id: 'w15', run_id: RUN, state: 'paused', turns: 3, seq: 52, paused_by: 'operator:9' }], runId: RUN, nowMs: 1200, graceMs: 1500 });
  assert.deepEqual(paused.events, [{ worker_id: 'w15', event: 'paused', turn: 3, seq: 52, paused_by: 'operator:9' }]);
  assert.deepEqual(paused.next.w15, { turns: 3, state: 'paused' });
});

test('diffWorkers: a paused row is never a pending death and a first-sight paused row is silent', () => {
  const pausedRow = { id: 'w14', run_id: RUN, state: 'paused', turns: 1, seq: 60, pid_alive: false, paused_by: 'operator:1' };
  const baseline = diffWorkers({ prev: {}, rows: [pausedRow], runId: RUN, nowMs: 1000, graceMs: 1500 });
  assert.deepEqual(baseline.events, [], 'a first-sight paused row must be baselined silently, like stopped/dead');
  assert.deepEqual(baseline.pending_deaths, []);
  assert.deepEqual(baseline.next.w14, { turns: 1, state: 'paused' });

  // Still paused on a later poll, a dead pid by construction: never a pending death, however long.
  const again = diffWorkers({ prev: baseline.next, rows: [pausedRow], runId: RUN, nowMs: 5000, graceMs: 1500 });
  assert.deepEqual(again.events, []);
  assert.deepEqual(again.pending_deaths, []);
});

test('wakeText: the paused wake names the worker, the turn and who paused it, under 400 bytes, with no worker output', () => {
  const text = wakeText({ worker_id: 'w-ghi', event: 'paused', turn: 4, seq: 42, paused_by: 'operator:555' });
  assert.equal(
    text,
    "belay: worker w-ghi was paused by operator:555 during turn 4; its process is parked and its session kept, and it takes no turn until the operator resumes it."
  );
  assert.ok(Buffer.byteLength(text, 'utf8') < 400, `wake text is ${Buffer.byteLength(text, 'utf8')} bytes`);
});

test('diffWorkers: a row whose adapter is dead is held only the orphan grace; one with a live adapter, the long grace', () => {
  const alive = (pid) => pid === 111;
  const live = { id: 'wa', run_id: RUN, state: 'running', turns: 0, seq: 1, pid_alive: false, adapter_pid: 111 };
  const orphan = { id: 'wb', run_id: RUN, state: 'running', turns: 0, seq: 2, pid_alive: false, adapter_pid: 222 };
  const base = diffWorkers({ prev: {}, rows: [live, orphan], runId: RUN, nowMs: 0, graceMs: 8000, orphanGraceMs: 1500, adapterAlive: alive });
  const later = diffWorkers({ prev: base.next, rows: [live, orphan], runId: RUN, nowMs: 3000, graceMs: 8000, orphanGraceMs: 1500, adapterAlive: alive });
  assert.deepEqual(later.pending_deaths.map((p) => p.worker_id), ['wa']);
});

test('diffWorkers: a Codex idle row with a finished turn\'s dead pid is not a pending death', () => {
  const idle = { id: 'wc', run_id: RUN, state: 'idle', turns: 1, seq: 3, pid_alive: false, adapter_pid: 111 };
  const r = diffWorkers({ prev: {}, rows: [idle], runId: RUN, nowMs: 0, graceMs: 8000 });
  assert.deepEqual(r.pending_deaths, []);
  assert.equal(r.next.wc.pid_dead_seen_at_ms, undefined);
});
