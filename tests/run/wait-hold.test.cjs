'use strict';
// wait-hold.test.cjs — a worker_wait that would answer a turn_end whose hand-back is under release evaluation holds that answer until
// the evaluation settles and returns the turn with its result in one call. Stub worker records follow the real order of onTurnEnd:
// the hand-back's ids are noted and the waiters resolve first, and the evaluation starts only after the turn's row is written (the
// worker's queue settles then). The test settles each step, so every ordering is forced and nothing is timed.

const test = require('node:test');
const assert = require('node:assert');
const { createWait } = require('../../src/run/wait.cjs');

function deferred() { let res; const p = new Promise((r) => { res = r; }); return { p, res }; }
function stub(id) {
  return { id, turns: 0, turnEnded: false, settled: false, readyWaiters: [], turnWaiters: [], exitWaiters: [], queue: Promise.resolve(), launches: 1, state: 'running', evaluation: null, lastEvaluation: null };
}
// The turn ends with a hand-back to evaluate: ids noted, waiters resolved, the evaluation not yet started. Returns the later steps.
function turnEnds(w, handBack = true) {
  w.turns += 1; w.turnEnded = true;
  w.releaseIds = handBack ? { turn: w.turns, ids: ['T1'] } : null;
  const q = deferred();
  w.queue = q.p;
  for (const r of w.turnWaiters.splice(0)) r({ usage: null });
  const d = deferred();
  return {
    // startRelease: refused while a stop or park holds the worker, else the evaluation begins; the row write is done either way.
    begin() {
      w.releaseIds = null;
      if (w.stopRequested || w.parkRequested) { q.res(); return; }
      const ev = { turn: w.turns, task_ids: ['T1'], next: 0, done: false, cancelled: null, promise: null, cancelSignal: null };
      ev.cancelSignal = new Promise((r) => { ev.signalCancel = r; });
      ev.promise = d.p.then((out) => { ev.done = true; if (!ev.cancelled) { w.turnEvaluated = out; w.turnEvaluatedTurn = ev.turn; } return out; }).finally(() => { if (w.evaluation === ev) w.evaluation = null; });
      w.evaluation = ev; w.lastEvaluation = ev;
      q.res();
    },
    end: d.res,
  };
}
// cancelEvaluation of release-eval.cjs, as a lifecycle operation calls it.
function cancel(w, by) { const ev = w.evaluation; if (!ev) return; w.evaluation = null; ev.cancelled = by; ev.signalCancel(); }
function settle(w, state) {
  Object.assign(w, { settled: true, settledState: state, exitCode: 0, deathEstablishedBy: 'exit event' });
  for (const r of w.exitWaiters.splice(0)) r({ code: 0 });
}
const waitOf = (...ws) => { const m = new Map(ws.map((w) => [w.id, w])); return createWait({ workers: m, get: (id) => m.get(id) }); };
const tick = () => new Promise((r) => setImmediate(r));
async function answeredNow(p) { const NONE = Symbol('none'); let got = NONE; p.then((v) => { got = v; }); await tick(); await tick(); await tick(); return got === NONE ? null : got; }

test('a hand-back under evaluation is answered once, the turn with its result', { timeout: 20000 }, async () => {
  const w = stub('w1');
  const p = waitOf(w)({ worker_ids: ['w1'], timeout_ms: 10000 });
  await tick();
  const t = turnEnds(w);
  assert.strictEqual(await answeredNow(p), null, 'the turn end is held while the evaluation is noted but not started');
  t.begin();
  assert.strictEqual(await answeredNow(p), null, 'and while it runs');
  const result = [{ task_id: 'T1', state: 'done', passed: true }];
  t.end(result);
  const got = await p;
  assert.deepStrictEqual([got.event, got.turn, got.timed_out, got.already, got.evaluating, got.evaluation], ['turn_end', 1, false, undefined, undefined, undefined]);
  assert.deepStrictEqual(got.evaluated, result);
});

test('a timeout mid-evaluation answers the turn as it stood, still evaluating', { timeout: 20000 }, async () => {
  const w = stub('w1');
  const p = waitOf(w)({ worker_ids: ['w1'], timeout_ms: 300 });
  await tick();
  turnEnds(w).begin();
  const got = await p;
  assert.deepStrictEqual([got.event, got.timed_out, got.evaluating, got.evaluated], ['turn_end', false, ['T1'], undefined]);
  assert.ok(got.waited_ms >= 250, 'the wait held until its bound, not answered at once');
});

test('a death during the hold is answered at once', { timeout: 20000 }, async () => {
  const w = stub('w1');
  const p = waitOf(w)({ worker_ids: ['w1'], timeout_ms: 10000 });
  await tick();
  const t = turnEnds(w);
  t.begin();
  await tick();
  Object.assign(w, { settled: true, settledState: 'dead', exitCode: 1, deathEstablishedBy: 'exit event' });
  for (const r of w.exitWaiters.splice(0)) r({ code: 1 });
  const early = await answeredNow(p);
  t.end([{ task_id: 'T1', state: 'done' }]);
  await p;
  assert.ok(early, 'the death is not held for the evaluation');
  assert.deepStrictEqual([early.event, early.exit_code], ['dead', 1]);
});

test('a second worker\'s turn end during the hold is answered at once', { timeout: 20000 }, async () => {
  const a = stub('a');
  const b = stub('b');
  const p = waitOf(a, b)({ timeout_ms: 10000 });
  await tick();
  const t = turnEnds(a);
  t.begin();
  await tick();
  turnEnds(b, false);
  const early = await answeredNow(p);
  t.end([{ task_id: 'T1', state: 'done' }]);
  await p;
  assert.ok(early, 'the other worker is not held behind a\'s evaluation');
  assert.deepStrictEqual([early.worker_id, early.event], ['b', 'turn_end']);
});

// A stop or park during the hold answers the turn with `evaluation: 'cancelled'` once the worker settles, never a bare turn_end and
// never only the settled state. Three orders: the evaluation was running, the stop came before it started, and a park instead.
for (const [name, run] of [
  ['a stop that cancels the running evaluation', (w, t) => { t.begin(); w.stopRequested = true; cancel(w, 'stop of worker w1'); }],
  ['a stop that arrives before the evaluation starts', (w, t) => { w.stopRequested = true; t.begin(); }],
  ['a park that arrives before the evaluation starts', (w, t) => { w.parkRequested = { by: 'pause', at: 1 }; t.begin(); }],
]) {
  test(`${name}: the turn is answered as cancelled once the worker settles`, { timeout: 20000 }, async () => {
    const w = stub('w1');
    const p = waitOf(w)({ worker_ids: ['w1'], timeout_ms: 10000 });
    await tick();
    const t = turnEnds(w);
    await tick(); // the turn end is read by the wait before the stop or park arrives
    run(w, t);
    assert.strictEqual(await answeredNow(p), null, 'not answered before the stop or park settles');
    settle(w, w.parkRequested ? 'paused' : 'stopped');
    const got = await p;
    assert.deepStrictEqual([got.event, got.evaluation, got.evaluating, got.evaluated, got.turn], ['turn_end', 'cancelled', undefined, undefined, 1]);
  });
}
