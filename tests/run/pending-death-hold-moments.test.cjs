'use strict';
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

test('a pid that read dead and then alive (a reused number) stays one pending moment through the run\'s dead-pid memory', async () => {
  const { createDeadPids } = require('../../src/run/dead-pids.cjs');
  const withMemory = async (useMemory) => {
    const h = harness();
    const mem = createDeadPids();
    const feed = (alive, t) => h.poll(useMemory ? mem.apply([{ ...row(alive), pid: 4242, pid_created: 111 }]) : [row(alive)], t);
    await feed(true, 0);
    await feed(false, 300);
    await feed(true, 4000); // another process holds the number now
    await feed(false, 4300);
    return pendingMoments(h.holds).length;
  };
  assert.strictEqual(await withMemory(false), 2, 'without the memory the reused pid makes a second moment');
  assert.strictEqual(await withMemory(true), 1);
  const mem = createDeadPids();
  mem.apply([{ id: 'w', pid: 4242, pid_created: 111, pid_alive: false }]);
  assert.strictEqual(mem.apply([{ id: 'w', pid: 4242, pid_created: 222, pid_alive: true }])[0].pid_alive, true, 'a relaunch (new creation time) is a new process');
  assert.strictEqual(mem.apply([{ id: 'w', pid: 5000, pid_created: 111, pid_alive: true }])[0].pid_alive, true, 'a new pid is a new process');
});

test('the orchestrator poll reads its rows through the dead-pid memory', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'src', 'run', 'orchestrator.cjs'), 'utf8');
  assert.match(src, /const rows = deadPids\.apply\(list\.workers \|\| \[\]\)/);
});
