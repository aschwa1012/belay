'use strict';
// turn-wait.test.cjs — waitTurnOrLanded on stub worker records, no processes: a turn that has landed answers at
// once; one parsed but still recording waits for its own resolution; a settled worker answers its exit; a turn
// not yet ended waits, and a wait never sits behind the worker's queue.

const test = require('node:test');
const assert = require('node:assert');
const { waitTurnOrLanded } = require('../../src/run/turn-wait.cjs');

const stub = (over = {}) => ({
  turnEnded: false, pendingTurnEnd: null, settled: false, parkRequested: null, turnWaiters: [],
  lastTurnUsage: null, lastCheckpointId: null, exitCode: null, exitSignal: null, queue: Promise.resolve(), ...over,
});

test('a turn that has landed answers at once with its facts, marked already', async () => {
  const w = stub({ turnEnded: true, lastTurnUsage: { output_tokens: 3 }, lastCheckpointId: 'c1' });
  const v = await waitTurnOrLanded(w, 5000);
  assert.deepStrictEqual(v, { usage: { output_tokens: 3 }, checkpoint_id: 'c1', paused: false, already: true });
  assert.strictEqual(w.turnWaiters.length, 0);
});

test('a turn parsed but still recording registers a waiter, and its own resolution answers it', async () => {
  const w = stub({ turnEnded: true, pendingTurnEnd: { kind: 'turn_end' } });
  const p = waitTurnOrLanded(w, 5000);
  assert.strictEqual(w.turnWaiters.length, 1, 'registered in the same tick as the check');
  w.turnWaiters.splice(0)[0]({ usage: { output_tokens: 7 }, checkpoint_id: 'c2' });
  assert.deepStrictEqual(await p, { usage: { output_tokens: 7 }, checkpoint_id: 'c2' });
});

test('a settled worker with no turn in flight answers its exit at once', async () => {
  const v = await waitTurnOrLanded(stub({ settled: true, exitCode: 1 }), 5000);
  assert.deepStrictEqual(v, { exited: true, exit_code: 1, exit_signal: null, already: true });
});

test('a turn not yet ended waits, never behind the queue, and answers null at its bound', async () => {
  const w = stub({ queue: new Promise(() => {}) }); // a queue that never drains must not hold the wait
  const t0 = Date.now();
  const p = waitTurnOrLanded(w, 200);
  assert.strictEqual(w.turnWaiters.length, 1);
  assert.strictEqual(await p, null);
  assert.ok(Date.now() - t0 < 2000);
  assert.strictEqual(w.turnWaiters.length, 0, 'the timed-out waiter removes itself');
});
