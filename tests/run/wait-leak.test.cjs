'use strict';
// A wait that times out leaves no waiter on the worker record, and a wait holding for a release evaluation that a stop cancels
// answers as the stop, while one cancelled any other way says so. Plain records through createWait: nothing here is timed.

const test = require('node:test');
const assert = require('node:assert');
const { createWait } = require('../../src/run/wait.cjs');
const RE = require('../../src/run/release-eval.cjs');

const deferred = () => { let res; const p = new Promise((r) => { res = r; }); return { p, res }; };
const tick = () => new Promise((r) => setImmediate(r));
const rec = (id) => ({ id, turns: 1, turnEnded: true, settled: false, readyWaiters: [], turnWaiters: [], exitWaiters: [], queue: Promise.resolve(), launches: 1, state: 'running' });
function startEv(w, d) {
  const ev = { key: 'k', ctx: { core: {} }, turn: w.turns, task_ids: ['T1'], next: 0, done: false, cancelled: null };
  ev.cancelSignal = new Promise((r) => { ev.signalCancel = r; });
  ev.promise = d.p.then((o) => { ev.done = true; if (!ev.cancelled) { w.turnEvaluated = o; w.turnEvaluatedTurn = ev.turn; } return o; }).finally(() => { if (w.evaluation === ev) w.evaluation = null; });
  w.evaluation = ev;
  return ev;
}
const mk = (w) => { const m = new Map([[w.id, w]]); return createWait({ workers: m, get: (id) => m.get(id) }); };

test('500 timed-out waits leave no turn or exit waiter, held for an evaluation or mid-turn', async () => {
  const held = rec('w1'); startEv(held, deferred());
  const busy = rec('w2'); busy.turnEnded = false;
  for (const w of [held, busy]) {
    const wait = mk(w);
    for (let i = 0; i < 500; i += 1) assert.strictEqual((await wait({ worker_ids: [w.id], timeout_ms: 1 })).timed_out, true);
    assert.strictEqual(w.turnWaiters.length, 0, `${w.id} turn waiters`);
    assert.strictEqual(w.exitWaiters.length, 0, `${w.id} exit waiters`);
  }
});

test('a stop that cancels the evaluation is answered as the stop, not as a finished turn', async () => {
  const w = rec('w1'); startEv(w, deferred());
  const p = mk(w)({ worker_ids: ['w1'], timeout_ms: 5000 });
  await tick();
  w.stopRequested = true;
  RE.cancelEvaluation(w, 'stop of worker w1');
  await tick(); await tick();
  w.settled = true; w.settledState = 'stopped'; w.exitCode = 0; w.deathEstablishedBy = 'exit event';
  for (const r of w.exitWaiters.splice(0)) r({ code: 0 });
  const r = await p;
  assert.strictEqual(r.event, 'stopped');
  assert.notStrictEqual(r.event, 'turn_end');
});

test('an evaluation cancelled for another reason is named in the turn_end answer', async () => {
  const w = rec('w1'); startEv(w, deferred());
  const p = mk(w)({ worker_ids: ['w1'], timeout_ms: 5000 });
  await tick();
  RE.cancelEvaluation(w, 'a relaunch');
  const r = await p;
  assert.strictEqual(r.event, 'turn_end');
  assert.strictEqual(r.evaluation, 'cancelled');
});
