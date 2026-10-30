'use strict';
// heavy-guard.test.cjs — ADR 0050 decision 6: a heavy-embedder failure (stage heavy_embed) pauses the run whatever nano's embedder mode is, never
// turns nano memory off, and is never fatal (a GPU that is gone is fixed, or on_heavy_failure is set to fallback; it does not end the run).

const { test } = require('node:test');
const assert = require('node:assert');
const { createEmbedderGuard } = require('../../src/run/embedder-guard.cjs');
const { err } = require('../../src/core/errors.cjs');

const heavyFailure = (code = 'E_INTERNAL', cause = 'load_failed') => err(code, 'the heavy embedder failed: gpu gone', { embedder: true, heavy: true, stage: 'heavy_embed', cause });
const guardIn = (mode, extra = {}) => {
  const whys = [], stops = [];
  const guard = createEmbedderGuard({ mode, pauseRun: async (why) => { whys.push(why); return {}; }, stopRun: async (why) => { stops.push(why); }, ...extra });
  return { guard, whys, stops };
};

for (const mode of ['required', 'keyword', 'off']) {
  test(`under embedder mode ${mode}, a heavy-embedder failure pauses the run and leaves nano memory on`, async () => {
    const { guard, whys, stops } = guardIn(mode);
    await guard.onFailure({ caller: { role: 'worker', worker_id: 'w1' }, call: 'memory.search', error: heavyFailure() });
    await guard.settled();
    assert.strictEqual(whys.length, 1, 'one pause');
    assert.match(whys[0], /E_INTERNAL/);
    assert.strictEqual(guard.memoryOff(), false, 'nano memory stays on, even under off');
    assert.strictEqual(guard.events()[0].action, 'pause');
    assert.deepStrictEqual(stops, []);
  });
}

test('a heavy failure is never fatal: even a code the embedder guard would end a run on only pauses it', async () => {
  const { guard, whys, stops } = guardIn('required');
  await guard.onFailure({ caller: { role: 'orchestrator' }, call: 'memory.store', error: heavyFailure('E_MODEL_CHANGED', 'canary') });
  await guard.settled();
  assert.strictEqual(whys.length, 1);
  assert.deepStrictEqual(stops, [], 'the run is not ended');
  assert.strictEqual(guard.events()[0].action, 'pause');
});

test('the contrast: the same code from nano itself is fatal under required', async () => {
  const { guard, stops } = guardIn('required');
  await guard.onFailure({ caller: { role: 'orchestrator' }, call: 'memory.store', error: err('E_MODEL_CHANGED', 'the model changed', { embedder: true, cause: 'canary' }) });
  await guard.settled();
  assert.strictEqual(stops.length, 1);
});
