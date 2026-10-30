'use strict';
// wait-hold.test.cjs — a worker_wait that would answer a turn_end whose hand-back is under release evaluation holds that answer until
// the evaluation settles and returns the turn with its result in one call. Stub worker records and an evaluation promise the test
// settles, so each ordering is forced and nothing is timed.

const test = require('node:test');
const assert = require('node:assert');
const { createWait } = require('../../src/run/wait.cjs');

function deferred() { let res; const p = new Promise((r) => { res = r; }); return { p, res }; }
function stub(id) {
  return { id, turns: 0, turnEnded: false, settled: false, readyWaiters: [], turnWaiters: [], exitWaiters: [], queue: Promise.resolve(), launches: 1, state: 'running', evaluation: null };
}
// The worker's turn ends at once with its hand-back evaluation in flight; `end` settles the evaluation with `out`.
function handBack(w) {
  const d = deferred();
  const ev = { turn: w.turns + 1, task_ids: ['T1'], next: 0, done: false, promise: null };
  ev.promise = d.p.then((out) => { ev.done = true; w.turnEvaluated = out; w.turnEvaluatedTurn = ev.turn; return out; }).finally(() => { if (w.evaluation === ev) w.evaluation = null; });
  w.evaluation = ev;
  return d.res;
}
function endTurn(w) { w.turns += 1; w.turnEnded = true; for (const r of w.turnWaiters.splice(0)) r({ usage: null }); }
const waitOf = (...ws) => { const m = new Map(ws.map((w) => [w.id, w])); return createWait({ workers: m, get: (id) => m.get(id) }); };
const tick = () => new Promise((r) => setImmediate(r));
async function answeredNow(p) { const NONE = Symbol('none'); let got = NONE; p.then((v) => { got = v; }); await tick(); await tick(); return got === NONE ? null : got; }

test('a hand-back under evaluation is answered once, the turn with its result', { timeout: 20000 }, async () => {
  const w = stub('w1');
  const end = handBack(w);
  const p = waitOf(w)({ worker_ids: ['w1'], timeout_ms: 10000 });
  await tick();
  endTurn(w);
  assert.strictEqual(await answeredNow(p), null, 'the turn end is held while the evaluation runs');
  const result = [{ task_id: 'T1', state: 'done', passed: true }];
  end(result);
  const got = await p;
  assert.deepStrictEqual([got.event, got.turn, got.timed_out, got.already, got.evaluating], ['turn_end', 1, false, undefined, undefined]);
  assert.deepStrictEqual(got.evaluated, result);
});

test('a timeout mid-evaluation answers the turn as it stood, still evaluating', { timeout: 20000 }, async () => {
  const w = stub('w1');
  handBack(w);
  const p = waitOf(w)({ worker_ids: ['w1'], timeout_ms: 300 });
  await tick();
  endTurn(w);
  const got = await p;
  assert.deepStrictEqual([got.event, got.timed_out, got.evaluating, got.evaluated], ['turn_end', false, ['T1'], undefined]);
  assert.ok(got.waited_ms >= 250, 'the wait held until its bound, not answered at once');
});

test('a death during the hold is answered at once', { timeout: 20000 }, async () => {
  const w = stub('w1');
  const end = handBack(w);
  const p = waitOf(w)({ worker_ids: ['w1'], timeout_ms: 10000 });
  await tick();
  endTurn(w);
  await tick();
  Object.assign(w, { settled: true, settledState: 'dead', exitCode: 1, deathEstablishedBy: 'exit event' });
  for (const r of w.exitWaiters.splice(0)) r({ code: 1 });
  const early = await answeredNow(p);
  end([{ task_id: 'T1', state: 'done' }]);
  await p;
  assert.ok(early, 'the death is not held for the evaluation');
  assert.deepStrictEqual([early.event, early.exit_code], ['dead', 1]);
});

test('a second worker\'s turn end during the hold is answered at once', { timeout: 20000 }, async () => {
  const a = stub('a');
  const b = stub('b');
  const end = handBack(a);
  const p = waitOf(a, b)({ timeout_ms: 10000 });
  await tick();
  endTurn(a);
  await tick();
  endTurn(b);
  const early = await answeredNow(p);
  end([{ task_id: 'T1', state: 'done' }]);
  await p;
  assert.ok(early, 'the other worker is not held behind a\'s evaluation');
  assert.deepStrictEqual([early.worker_id, early.event], ['b', 'turn_end']);
});
