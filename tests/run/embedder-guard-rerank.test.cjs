'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// embedder-guard-rerank.test.cjs — ADR 0050 decision 6: a reranker failure under on_heavy_failure pause pauses the run whatever the
// embedder mode says. Under keyword an embedder failure never pauses, and under off it turns the run's memory off; a reranker failure
// does neither of those: it pauses and leaves memory on.

const { test } = require('node:test');
const assert = require('node:assert');
const { createEmbedderGuard } = require('../../src/run/embedder-guard.cjs');
const { err } = require('../../src/core/errors.cjs');

const rerankFailure = () => err('E_RERANK', 'the rerank stage failed (error): gpu gone', { reason: 'error', stage: 'rerank', embedder: true });
const embedderFailure = () => err('E_MODEL_ABSENT', 'the model is not in the cache', { embedder: true, cause: 'absent' });
const guardIn = (mode) => {
  const whys = [];
  const guard = createEmbedderGuard({ mode, pauseRun: async (why) => { whys.push(why); return {}; }, stopRun: async () => {} });
  return { guard, whys };
};

for (const mode of ['required', 'keyword', 'off']) {
  test(`under embedder mode ${mode}, a reranker failure pauses the run and leaves memory on`, async () => {
    const { guard, whys } = guardIn(mode);
    await guard.onFailure({ caller: { role: 'worker', worker_id: 'w1' }, call: 'memory.search', error: rerankFailure() });
    await guard.settled();
    assert.strictEqual(whys.length, 1, 'one pause');
    assert.match(whys[0], /E_RERANK/);
    assert.strictEqual(guard.memoryOff(), false, 'memory stays on');
    assert.strictEqual(guard.events()[0].action, 'pause');
  });
}

test('the contrast: under keyword and off an embedder failure still does not pause', async () => {
  for (const mode of ['keyword', 'off']) {
    const { guard, whys } = guardIn(mode);
    await guard.onFailure({ caller: { role: 'worker', worker_id: 'w1' }, call: 'memory.search', error: embedderFailure() });
    await guard.settled();
    assert.strictEqual(whys.length, 0, mode);
    assert.strictEqual(guard.memoryOff(), mode === 'off');
  }
});

test('the reranker failure message carries reranker advice, not the embedder fetch advice', async () => {
  const { search } = require('../../src/core/memory-search.cjs');
  const { setup, PROJECT } = require('../core/lifecycle-env.cjs');
  const provider = require('../../src/core/rerank-provider.cjs');
  const RP = require('../../src/core/retrieval-profiles.cjs');
  const { Engine } = require('../../src/core/engine.cjs');
  const T = await setup();
  try {
    T.note('guard fixture', { vec: [1, 0, 0] });
    const E = new Engine({ dataDir: T.dir, store: T.store, getEmbedder: null, owner: { opts: { onEmbedderFailure: () => {}, embedderMode: () => 'required' } }, establishedBy: 'test' });
    provider.register('fake/guard-rr', { rerank: async () => { throw new Error('gpu gone'); } });
    await assert.rejects(() => search(E, T.who.operator('plain'), { namespaces: [`project/${PROJECT}`], query: 'x', query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic' },
      { tier: { profile: 'custom', embedder: RP.NANO, reranker: 'fake/guard-rr', device: 'cpu', depth: 3 }, levers: { on_heavy_failure: 'pause' } }), (e) => {
      assert.strictEqual(e.code, 'E_RERANK');
      assert.match(e.message, /fix the reranker/);
      assert.doesNotMatch(e.message, /embedder fetch/);
      return true;
    });
  } finally { require('../../src/core/rerank-provider.cjs').unregister('fake/guard-rr'); T.close(); }
});
