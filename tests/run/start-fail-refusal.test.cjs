'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// start-fail-refusal.test.cjs — two rules meet in start-fail.cjs. A resume whose start fails for want of luck (a row write, a ready
// window) goes back to parked; a launch the guard REFUSES (native memory: a folder, a settings.json that disagrees) is a standing
// condition and settles dead, so worker_wait answers dead. The refusal wins whichever way the caller asked for parking.

const { test } = require('node:test');
const assert = require('node:assert');
const { createStartFail } = require('../../src/run/start-fail.cjs');

function fixture(over = {}) {
  const rows = [];
  const w = { id: 'w1', state: 'paused', pid: null, settled: false, queue: Promise.resolve(), stderr: '', bindId: null, ...over };
  const sf = createStartFail({ core: {}, writeRow: async (_w, state) => { rows.push(state); w.state = state; return { state }; } });
  return { w, rows, sf };
}
const refusal = (code = 'E_NATIVE_MEMORY_MISMATCH') => Object.assign(new Error('the worker settings.json disagrees'), { code });

test('a transient failure inside the start of a resume parks the worker again and writes no dead row', async () => {
  const { w, rows, sf } = fixture();
  await assert.rejects(sf.guarded(w, async () => { throw Object.assign(new Error('simulated row write failure'), { code: 'E_TIMEOUT' }); }, { parkOnFailure: true }), (e) => e.code === 'E_TIMEOUT');
  assert.strictEqual(w.parkRequested, 'start-failed');
  assert.deepStrictEqual(rows, []);
  assert.strictEqual(w.state, 'paused');
});

test('a guard refusal that surfaces inside the start settles dead even though the caller asked for parking (error code)', async () => {
  const { w, rows, sf } = fixture();
  await assert.rejects(sf.guarded(w, async () => { throw refusal(); }, { parkOnFailure: true }), (e) => e.code === 'E_NATIVE_MEMORY_MISMATCH');
  assert.notStrictEqual(w.parkRequested, 'start-failed');
  assert.deepStrictEqual(rows, ['dead']);
  assert.strictEqual(w.state, 'dead');
});

test('a worker the guard has already marked refused settles dead whatever the error is (flag)', async () => {
  const { w, rows, sf } = fixture({ nativeMemoryRefused: true });
  await assert.rejects(sf.guarded(w, async () => { throw Object.assign(new Error('anything'), { code: 'E_SUBSTRATE' }); }, { parkOnFailure: true }), (e) => e.code === 'E_SUBSTRATE');
  assert.notStrictEqual(w.parkRequested, 'start-failed');
  assert.deepStrictEqual(rows, ['dead']);
});

test('without parkOnFailure a failed start is dead, as before', async () => {
  const { w, rows, sf } = fixture();
  await assert.rejects(sf.guarded(w, async () => { throw new Error('boom'); }));
  assert.deepStrictEqual(rows, ['dead']);
});
