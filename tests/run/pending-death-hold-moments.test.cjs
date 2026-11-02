'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// A pending death is one hold moment, however many polls see it and however far the clock jumps between them (a host that slept):
// the recorder keys a moment on the busy/awaiting/pending/parked/live sets, and a moment is added only when a set changes or a turn
// ends. This drives the real diffWorkers + idleClose + createHoldRecorder over a scripted sequence of worker.list reads, so a
// second moment in the end-to-end run test (tests/cli/run-paths.test.cjs) can be told apart: it came from a set change or a turn end
// the run really saw, not from the recorder sampling the same hold twice.
const test = require('node:test');
const assert = require('node:assert');
const { diffWorkers, createHoldRecorder } = require('../../src/run/wake.cjs');
const { idleClose } = require('../../src/run/orchestrator-idle-close.cjs');

const GRACE = 8000;
function harness() {
  const rec = createHoldRecorder();
  const holds = [];
  const state = { pendingWrites: [], evalSeen: new Map(), finishing: false, idle: true };
  let baseline = {};
  const preClose = { check: async () => ({ ran: false }) };
  const callWatcher = { holds: () => [] };
  const hold = { isPaused: () => false };
  async function poll(rows, nowMs) {
    const { next, pending_deaths } = diffWorkers({ prev: baseline, rows, runId: 'r', nowMs, graceMs: GRACE, adapterAlive: () => true });
    baseline = next;
    await idleClose({
      state, rows, runId: 'r', pending_deaths, turnAtCall: 1, hold, awaitingWakeIds: () => [], callWatcher, preClose,
      recordHold: (turn, busy, awaiting, by, pd, pk, lv) => rec.record(holds, nowMs, turn, busy, awaiting, by, pd, pk, lv),
      writeWake() {}, closeThenKillOnDeadline() { throw new Error('closed inside the grace'); },
    });
  }
  return { poll, holds, reset: rec.reset };
}
const row = (alive) => ({ id: 'w', run_id: 'r', state: 'starting', mid_turn: 1, turns: 0, pid_alive: alive, adapter_pid: 1, seq: 1 });
const pendingMoments = (h) => h.filter((m) => m.pending_deaths && m.pending_deaths.length === 1);

test('many polls of one dead pid, with the clock jumping between them, record one pending moment', async () => {
  const h = harness();
  await h.poll([row(true)], 0);
  for (const t of [300, 600, 900, 4000, 4300, 7000, 7700]) await h.poll([row(false)], t); // 4000 -> 7000: a host that slept
  assert.strictEqual(h.holds.length, 2, JSON.stringify(h.holds));
  assert.deepStrictEqual(h.holds[0].busy, ['w']);
  assert.strictEqual(pendingMoments(h.holds).length, 1);
  assert.deepStrictEqual(h.holds[1].busy, []);
});

test('a second pending moment needs a real input change: a turn end, or the pid reading alive and dead again', async () => {
  const turnEnd = harness();
  await turnEnd.poll([row(true)], 0);
  await turnEnd.poll([row(false)], 300);
  turnEnd.reset(); // a turn ended inside the grace (a hold is scoped to one idle period)
  await turnEnd.poll([row(false)], 600);
  assert.strictEqual(pendingMoments(turnEnd.holds).length, 2);

  const flap = harness();
  await flap.poll([row(true)], 0);
  await flap.poll([row(false)], 300);
  await flap.poll([row(true)], 600); // the pid reads alive for one poll
  await flap.poll([row(false)], 900);
  assert.strictEqual(pendingMoments(flap.holds).length, 2);
  assert.strictEqual(flap.holds.length, 4);
});

test('a pid that read dead and then alive (a reused number) stays one pending moment through the dead-pid memory', async () => {
  const { createDeadPids } = require('../../src/run/dead-pids.cjs');
  const withMemory = async (useMemory) => {
    const h = harness();
    const mem = createDeadPids();
    const feed = (alive, t) => h.poll(useMemory ? mem.apply([{ ...row(alive), pid: 4242 }]) : [row(alive)], t);
    await feed(true, 0);
    await feed(false, 300);
    await feed(true, 4000); // another process holds the number now
    await feed(false, 4300);
    return h;
  };
  assert.strictEqual(pendingMoments((await withMemory(false)).holds).length, 2, 'without the memory the reused pid makes a second moment');
  const h = await withMemory(true);
  assert.strictEqual(pendingMoments(h.holds).length, 1);
});

test('the hold text names what kept a dead pid dead when the number reads alive again', async () => {
  const { createDeadPids } = require('../../src/run/dead-pids.cjs');
  const h = harness();
  const mem = createDeadPids({ now: () => 777 });
  await h.poll(mem.apply([{ ...row(true), pid: 4242 }]), 0);
  await h.poll(mem.apply([{ ...row(false), pid: 4242 }]), 300);
  h.reset(); // a turn ended: the next idle period records its hold afresh, from rows that read alive again
  await h.poll(mem.apply([{ ...row(true), pid: 4242 }]), 600);
  assert.strictEqual(h.holds.filter((m) => m.busy.length).length, 1, 'the reused number never makes the worker busy again');
  assert.strictEqual(h.holds.length, 3);
  assert.strictEqual(h.holds[2].established_by, "worker.list; pid dead (seen dead at w 777 by pid check, and the number reads alive since: another process may hold it), awaiting the detector's row");
});

test('the orchestrator poll and the interactive wake publisher read their rows through the dead-pid memory', () => {
  const read = (f) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'src', 'run', f), 'utf8');
  assert.match(read('orchestrator.cjs'), /const rows = deadPids.apply(list.workers || [])/);
  assert.match(read('wake-pipe.cjs'), /workers: deadPids.apply(list.workers || [])/);
});
