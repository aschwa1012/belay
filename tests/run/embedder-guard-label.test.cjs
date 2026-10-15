'use strict';
// embedder-guard-label.test.cjs — the ADR 0034 hook is told the call name and, for a run-manager call, the worker the call is
// for, so a pause caused by embedding a spawn's index query names memory.embedQuery and that worker in paused_by.

const test = require('node:test');
const assert = require('node:assert');
const { createEmbedderGuard } = require('../../src/run/embedder-guard.cjs');

const embedderError = () => Object.assign(new Error('the embedder did not answer'), { code: 'E_TIMEOUT', detail: { embedder: true, cause: 'timeout' } });

test('a failure of memory.embedQuery pauses the run naming the call and the worker the call is for', async () => {
  const whys = [];
  const guard = createEmbedderGuard({ mode: 'stop', pauseRun: async (why) => { whys.push(why); return {}; }, stopRun: async () => {} });
  guard.onFailure({ caller: { role: 'orchestrator' }, by: 'harness', call: 'memory.embedQuery', error: embedderError(), worker_id: 'coder-3' });
  await guard.settled();
  assert.deepStrictEqual(whys, ['embedder-failure (coder-3, memory.embedQuery, E_TIMEOUT, timeout)']);
  assert.strictEqual(guard.events()[0].worker, 'coder-3');
  assert.strictEqual(guard.events()[0].call, 'memory.embedQuery');
});

test('without a worker id the label is what it was: the caller\'s worker, else the writer, else the role', async () => {
  const whys = [];
  const guard = createEmbedderGuard({ mode: 'stop', pauseRun: async (why) => { whys.push(why); return {}; }, stopRun: async () => {} });
  guard.onFailure({ caller: { role: 'worker', worker_id: 'w9' }, by: 'worker:w9', call: 'memory.search', error: embedderError() });
  guard.onFailure({ caller: { role: 'orchestrator' }, by: 'harness', call: 'memory.store', error: embedderError() });
  await guard.settled();
  assert.deepStrictEqual(whys, ['embedder-failure (w9, memory.search, E_TIMEOUT, timeout)', 'embedder-failure (harness, memory.store, E_TIMEOUT, timeout)']);
});

test('a caller\'s error and a failure under continue do not pause', async () => {
  let paused = 0;
  const stop = createEmbedderGuard({ mode: 'stop', pauseRun: async () => { paused++; }, stopRun: async () => {} });
  stop.onFailure({ caller: { role: 'orchestrator' }, call: 'memory.embedQuery', error: Object.assign(new Error('too long'), { code: 'E_TOO_LONG' }), worker_id: 'w1' });
  const cont = createEmbedderGuard({ mode: 'continue', pauseRun: async () => { paused++; }, stopRun: async () => {} });
  cont.onFailure({ caller: { role: 'orchestrator' }, call: 'memory.embedQuery', error: embedderError(), worker_id: 'w1' });
  await Promise.all([stop.settled(), cont.settled()]);
  assert.strictEqual(paused, 0);
  assert.strictEqual(cont.events()[0].action, 'continue');
});
