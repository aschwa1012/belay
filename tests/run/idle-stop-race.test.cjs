'use strict';
// stop_idle_on_done decides at the moment of the stop, inside the stop's operation slot: work or a relaunch that landed while
// the leases were read is seen there. Real modules: idle-stop.cjs and lifecycle.cjs (runOp, refuseMessageDuringOp).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { stopIfIdleDone } = require(path.join(__dirname, '../../src/run/idle-stop.cjs'));
const LC = require(path.join(__dirname, '../../src/run/lifecycle.cjs'));

const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const done = { id: 't1', state: 'done', handoff: { by: 'w1' } };

function fixture(listAnswers) {
  const store = { leases: [] };
  const w = { id: 'w1', turnEnded: true, settled: false, stopRequested: false, parkRequested: null, queue: Promise.resolve(), op: null, evaluation: null, launches: 1 };
  const stops = [];
  let lists = 0;
  const manager = {
    _worker: (id) => (id === 'w1' ? w : null),
    stop: ({ worker_id, guard }) => LC.runOp(w, 'stop', async () => {
      if (guard && await guard()) return null;
      stops.push(worker_id);
      return { worker_id, graceful: true };
    }, { waitFor: ['pause', 'resume', 'restart'] }),
  };
  // each list call takes its snapshot of the store, then waits for its own gate (the answer in flight)
  const ctx = { stopIdleOnDone: true, core: { task: { list: async () => { const snap = store.leases.map((l) => ({ ...l })); const g = listAnswers[lists++]; if (g) await g.p; return { tasks: snap }; } } } };
  return { store, w, stops, manager, ctx };
}

test('an assignment committed while the leases are read keeps the worker running and its message is not refused', async () => {
  const gate = deferred();
  const f = fixture([gate]);
  const run = stopIfIdleDone(f.manager, f.ctx, done);
  await ticks();
  f.store.leases.push({ id: 't2', lease: { id: 'L2', holder: 'w1', holder_role: 'worker', expired: false } }); // task.assign landed; compose has not messaged yet
  gate.resolve();
  const r = await run;
  assert.strictEqual(r.stopped, false);
  assert.match(r.reason, /holds the lease on task t2/);
  assert.strictEqual(f.stops.length, 0);
  assert.doesNotThrow(() => LC.refuseMessageDuringOp(f.w), 'the assign message is not refused as busy with stop');
});

test('a restart begun while the leases are read is waited out and the relaunched worker is not stopped', async () => {
  const gate = deferred();
  const restartDone = deferred();
  const f = fixture([gate]);
  const run = stopIfIdleDone(f.manager, f.ctx, done);
  await ticks();
  const restart = LC.runOp(f.w, 'restart', async () => { await restartDone.p; f.w.launches += 1; return { restarted: true }; });
  gate.resolve();
  await ticks();
  assert.strictEqual(f.stops.length, 0, 'the stop waits out the restart');
  restartDone.resolve();
  await restart;
  const r = await run;
  assert.strictEqual(r.stopped, false);
  assert.match(r.reason, /relaunched/);
  assert.strictEqual(f.stops.length, 0);
});

test('an idle worker with nothing else is still stopped', async () => {
  const f = fixture([]);
  const r = await stopIfIdleDone(f.manager, f.ctx, done);
  assert.deepStrictEqual([r.stopped, f.stops.length], [true, 1]);
});
