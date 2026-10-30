'use strict';
// owner-stop-retrieval.test.cjs — a call that reaches a retrieval provider while the owner is stopping reads as a shutdown, not as a
// provider failure: no pause, no run hook, no sticky fallback (rerank and heavy embed), and a heavy drain stops at its next batch.

process.env.BELAY_TEST_MODE = '1';
require('../helpers/tmp.cjs'); // this file starts processes: its own spawn register (spawn-register-isolation.test.cjs)
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT } = require('./lifecycle-env.cjs');
const { core } = require('./helpers.cjs');
const { rig, EMB4 } = require('./fixtures/gpu-wire-rig.cjs');

const { Engine } = core('engine.cjs');
const RP = core('retrieval-profiles.cjs');
const HT = core('heavy-tier.cjs');
const HD = core('heavy-drain.cjs');
const EP = core('embed-provider.cjs');
const { search } = core('memory-search.cjs');

const NS = `project/${PROJECT}`;
let T, R;
before(async () => {
  R = rig(); R.install(); T = await setup();
  for (let i = 0; i < 40; i++) T.note('n'.repeat(i + 2), { vec: [1, i / 100, 0] }); // more than two drain batches of 16
});
after(async () => { await EP.closeAll(); await R.restore(); T.close(); });

// closeAll latches the shared GPU child closed (an owner's stop); a new owner reopens it
const fresh = async () => { await EP.closeAll(); core('gpu-shared.cjs').reopen(); };
const stopping = (hooked) => ({ stopped: true, opts: { onEmbedderFailure: (x) => hooked.push(x) } });
const engineOf = (owner) => new Engine({ dataDir: T.dir, store: T.store, getEmbedder: async () => ({ embed: async () => ({ embedding: [1, 0, 0], embedding_model: 'm' }) }), owner, establishedBy: 'test' });
const ask = (E, tier, args, internal) => search(E, T.who.operator('plain'), { namespaces: [NS], mode: 'semantic', k: 20, ...args }, { tier, ...internal });

for (const policy of ['pause', 'fallback']) {
  test(`a rerank on a stopping owner with no reranker built is a shutdown under on_heavy_failure ${policy}`, async () => {
    const hooked = [];
    const E = engineOf(stopping(hooked));
    const tier = { profile: 'custom', embedder: RP.NANO, reranker: 'org/not-built-reranker', device: 'cpu', depth: 4 };
    const r = await ask(E, tier, { query: 'n', query_embedding: [1, 0, 0], embedding_model: 'm' }, { levers: { on_heavy_failure: policy } });
    assert.strictEqual(r.rerank.cause.reason, 'shutdown');
    assert.deepStrictEqual(hooked, [], 'the run hook was not called');
    assert.strictEqual(E._rerankFallback ? E._rerankFallback.size : 0, 0, 'not sticky');
  });
}

test('memory.drainHeavy (belay memory embed --model) stops at a batch boundary once the owner is stopping', async () => {
  await fresh();
  // The owner reads as stopping once the first batch's vectors are in the store, so the stop arrives between two batches.
  const rows = () => T.store.db.prepare('SELECT COUNT(*) AS n FROM memory_vectors WHERE model = ?').get(EMB4).n;
  const base = rows();
  const owner = { opts: {}, get stopped() { return rows() > base; } };
  const E = engineOf(owner);
  const r = await E.handle('memory.drainHeavy', { caller: T.who.operator('plain'), model: EMB4, namespaces: [NS], bound_ms: 60000 });
  assert.strictEqual(r.done, false, 'the drain did not run to the end');
  assert.ok(r.written > 0 && r.written < r.total, `written ${r.written} of ${r.total}`);
});

test('a heavy drain stops at the next batch once the owner is stopping', async () => {
  await fresh();
  const owner = { stopped: false, opts: {} };
  const E = engineOf(owner);
  const r = await HD.drainHeavy(E, EMB4, { namespaces: [NS], batch: 2, cancelled: () => owner.stopped, onProgress: () => { owner.stopped = true; } });
  assert.strictEqual(r.written, 2, 'one batch written, then the drain saw the stop');
  assert.strictEqual(r.done, false);
});

test('the rest of the backlog drains once the owner is not stopping', async () => {
  await fresh();
  const E = engineOf({ stopped: false, opts: {} });
  const r = await HD.drainHeavy(E, EMB4, { namespaces: [NS] });
  assert.strictEqual(r.done, true);
});

for (const policy of ['pause', 'fallback']) {
  test(`a heavy query embed on a stopping owner with no provider built is a shutdown under on_heavy_failure ${policy}`, async () => {
    await fresh();
    const hooked = [];
    const E = engineOf(stopping(hooked));
    const tier = HT.withDims({ profile: 'custom', embedder: EMB4, reranker: null, device: 'gpu', depth: 0 });
    const orig = HT.setFallback; let sets = 0;
    HT.setFallback = (...a) => { sets++; return orig(...a); };
    try {
      const r = await ask(E, tier, { query: 'anything' }, { levers: { on_heavy_failure: policy } });
      assert.strictEqual(r.tier_fallback.cause.reason, 'shutdown');
    } finally { HT.setFallback = orig; }
    assert.strictEqual(sets, 0, 'no sticky fallback was written');
    assert.deepStrictEqual(hooked, [], 'the run hook was not called');
  });
}
