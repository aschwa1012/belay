'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// stop_idle_on_done decides at the moment of the stop, inside the stop's operation slot: work or a relaunch that landed while
// the leases were read is seen there. Real modules: idle-stop.cjs and lifecycle.cjs (runOp, refuseMessageDuringOp).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { stopIfIdleDone, markAssign } = require(path.join(__dirname, '../../src/run/idle-stop.cjs'));
const LC = require(path.join(__dirname, '../../src/run/lifecycle.cjs'));

const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const done = { id: 't1', state: 'done', handoff: { by: 'w1' } };

// `listAnswers[n]` is the gate the nth task.list call waits for (null: no wait); `listed[n].p` settles when that call has been made.
function fixture(listAnswers) {
  const store = { leases: [] };
  const w = { id: 'w1', turnEnded: true, settled: false, stopRequested: false, parkRequested: null, queue: Promise.resolve(), op: null, evaluation: null, launches: 1 };
  const stops = [];
  const listed = [deferred(), deferred(), deferred()];
  let lists = 0;
  const manager = {
    _worker: (id) => (id === 'w1' ? w : null),
    stop: ({ worker_id, guard }) => LC.runOp(w, guard ? 'idle-stop' : 'stop', async () => {
      if (guard && await guard()) return null;
      stops.push(worker_id);
      return { worker_id, graceful: true };
    }, { waitFor: guard ? LC.IDLE_STOP_WAIT : LC.STOP_WAIT }),
  };
  // each list call takes its snapshot of the store, then waits for its own gate (the answer in flight)
  const ctx = { stopIdleOnDone: true, core: { task: { list: async () => { const snap = store.leases.map((l) => ({ ...l })); const n = lists++; listed[n].resolve(); const g = listAnswers[n]; if (g) await g.p; return { tasks: snap }; } } } };
  return { store, w, stops, manager, ctx, listed };
}
const lease = { id: 't2', lease: { id: 'L2', holder: 'w1', holder_role: 'worker', expired: false } };

test('an assignment committed while the leases are read keeps the worker running and its message is not refused', async () => {
  const gate = deferred();
  const f = fixture([gate]);
  const run = stopIfIdleDone(f.manager, f.ctx, done);
  await f.listed[0].p;
  f.store.leases.push(lease); // task.assign landed; compose has not messaged yet
  gate.resolve();
  const r = await run;
  assert.strictEqual(r.stopped, false);
  assert.match(r.reason, /holds the lease on task t2/);
  assert.strictEqual(f.stops.length, 0);
  assert.doesNotThrow(() => LC.refuseMessageDuringOp(f.w), 'the assign message is not refused as busy with stop');
});

test('an assignment committed after the guard took its lease snapshot, inside the slot, is seen and the worker is not stopped', async () => {
  const gate = deferred();
  const f = fixture([null, gate]);
  const run = stopIfIdleDone(f.manager, f.ctx, done);
  await f.listed[1].p; // the guard inside the stop's slot has taken its snapshot and waits
  assert.strictEqual(f.w.op.name, 'idle-stop');
  const end = markAssign(f.w); // compose marks the worker before the core commits
  f.store.leases.push(lease); // committed after the snapshot
  end();
  gate.resolve();
  const r = await run;
  assert.strictEqual(r.stopped, false);
  assert.match(r.reason, /new work/);
  assert.strictEqual(f.stops.length, 0);
  assert.doesNotThrow(() => LC.refuseMessageDuringOp(f.w));
});

test('an assign still in flight when the guard decides keeps the worker running', async () => {
  const gate = deferred();
  const f = fixture([null, gate]);
  const run = stopIfIdleDone(f.manager, f.ctx, done);
  await f.listed[1].p;
  const end = markAssign(f.w); // the core has not answered yet
  gate.resolve();
  const r = await run;
  assert.strictEqual(r.stopped, false);
  assert.strictEqual(f.stops.length, 0);
  end();
});

test('an assign is refused once the guard has decided to stop, and while an explicit stop is in flight', async () => {
  const f = fixture([]);
  f.w.op = { name: 'idle-stop', promise: Promise.resolve() };
  assert.doesNotThrow(() => markAssign(f.w)(), 'the guard has not committed yet');
  f.w.stopCommitted = true;
  assert.throws(() => markAssign(f.w), (e) => e.code === 'E_BUSY');
  assert.throws(() => LC.refuseMessageDuringOp(f.w), (e) => e.code === 'E_BUSY');
  f.w.op = { name: 'stop', promise: Promise.resolve() };
  f.w.stopCommitted = false;
  assert.throws(() => markAssign(f.w), (e) => e.code === 'E_BUSY');
});

test('an explicit stop that arrives during a guarded idle stop whose guard skips still stops the worker', async () => {
  const gate = deferred();
  const f = fixture([null, gate]);
  const run = stopIfIdleDone(f.manager, f.ctx, done);
  await f.listed[1].p;
  const end = markAssign(f.w); // the assign wins: it marked the worker before the explicit stop took the slot (after it, the assign is refused)
  f.store.leases.push(lease);
  end();
  const explicit = f.manager.stop({ worker_id: 'w1' }); // worker_stop: no guard
  gate.resolve();
  const receipt = await explicit;
  const r = await run;
  assert.strictEqual(r.stopped, false, 'the idle stop skipped');
  assert.deepStrictEqual(receipt, { worker_id: 'w1', graceful: true }, 'the explicit stop returns its own proof');
  assert.deepStrictEqual(f.stops, ['w1']);
});

test('a Codex message relaunch in flight is not stopped', async () => {
  const f = fixture([]);
  f.w.relaunching = { text: 'hello' };
  const r = await stopIfIdleDone(f.manager, f.ctx, done);
  assert.strictEqual(r.stopped, false);
  assert.strictEqual(f.stops.length, 0);
});

test('a restart begun while the leases are read is waited out and the relaunched worker is not stopped', async () => {
  const gate = deferred();
  const restartDone = deferred();
  const f = fixture([gate]);
  const run = stopIfIdleDone(f.manager, f.ctx, done);
  await f.listed[0].p;
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
  assert.strictEqual(f.w.stopCommitted, false);
});
