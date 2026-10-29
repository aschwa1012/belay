'use strict';
// rerank-warm.test.cjs — the reranker's cold load runs outside the rerank bound. An owner that has not loaded a pinned reranker starts the
// load in the background on the first search that needs it; that search and any other during the load keep the fusion order and say
// 'warming' (never sticky, never a pause); a warm-up that failed lets the next search try the reranker itself; a rerank failure drops the
// state so the next search warms again. Fakes only: no model, no child.

process.env.BELAY_TEST_MODE = '1';
require('../helpers/tmp.cjs');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const RW = require('../../src/core/retrieval-warm.cjs');
const ST = require('../../src/core/search-tier.cjs');
const provider = require('../../src/core/rerank-provider.cjs');

const MODEL = 'fake/warm-reranker';
const tier = { profile: 'custom', embedder: 'nano', reranker: MODEL, device: 'cpu', depth: 4 };
const ranked = [{ id: 'a' }, { id: 'b' }];
const lv = { rerank_depth: 4, rerank_bound_ms: 1000, on_heavy_failure: 'fallback' };
const ownerE = () => ({ owner: { opts: {}, stopped: false }, store: null });
const ask = (E, over) => ST.rerankHead(E, { run_id: null }, { tier, order: 'score', query: 'q', t0: Date.now() }, ranked, () => new Map([['a', { text: 'x' }], ['b', { text: 'y' }]]), { ...lv, ...over });
const settle = () => new Promise((r) => setTimeout(r, 20));
let gate, calls;
const deferred = () => { let res; const p = new Promise((a) => { res = a; }); return { p, res }; };

// A registered fake, marked as built by the module itself (the seam), stands in for the owner's auto-built provider.
const install = (rerank) => { provider.unregister(MODEL); provider.register(MODEL, { rerank }); provider.__asBuilt(MODEL); };
beforeEach(() => {
  gate = deferred(); calls = 0;
  install(async () => { calls += 1; await gate.p; return { scores: [{ id: 'w', score: 1 }] }; });
});
afterEach(() => { gate.res(); provider.unregister(MODEL); });

test('a caller-registered provider is ready at once: nothing is warmed', () => {
  provider.unregister(MODEL);
  provider.register(MODEL, { rerank: async () => { calls += 1; return { scores: [] }; } });
  assert.strictEqual(RW.rerankerState(ownerE(), tier), 'ready');
  assert.strictEqual(calls, 0);
});

test('a non-owner, a stopped owner and a tier with no reranker are ready: nothing is started', () => {
  assert.strictEqual(RW.rerankerState({ owner: false }, tier), 'ready');
  assert.strictEqual(RW.rerankerState(ownerE(), { reranker: null }), 'ready');
  assert.strictEqual(RW.rerankerState({ owner: { stopped: true } }, tier), 'ready');
});

test('an unregistered, unbuildable reranker is ready: the stage reports the absent provider itself', () => {
  provider.unregister(MODEL);
  assert.strictEqual(RW.rerankerState(ownerE(), tier), 'ready');
});

test('the first state call starts one background warm-up and answers loading; it becomes ready when the load ends', async () => {
  const E = ownerE();
  assert.strictEqual(RW.rerankerState(E, tier), 'loading');
  assert.strictEqual(RW.rerankerState(E, tier), 'loading');
  await settle();
  assert.strictEqual(calls, 1, 'one warm-up call, however many searches meet it');
  gate.res();
  await settle();
  assert.strictEqual(RW.rerankerState(E, tier), 'ready');
  assert.strictEqual(calls, 1);
});

test('a search that meets a loading reranker keeps the fusion order, says warming, and never pauses', async () => {
  const E = ownerE();
  const r = await ask(E);
  assert.strictEqual(r.ranked, ranked);
  assert.strictEqual(r.info.ran, false);
  assert.strictEqual(r.info.cause.reason, 'warming');
  assert.strictEqual(r.failed.mode, 'rerank');
  const again = await ask(E, { on_heavy_failure: 'pause' });
  assert.strictEqual(again.info.cause.reason, 'warming');
});

test('a failed warm-up lets the next search try the reranker itself, and a failed rerank drops the state so the next search warms again', async () => {
  const E = ownerE();
  install(async () => { throw new Error('model file missing'); });
  assert.strictEqual(RW.rerankerState(E, tier), 'loading');
  await settle();
  assert.strictEqual(RW.rerankerState(E, tier), 'failed');
  const r = await ask(E);
  assert.strictEqual(r.info.cause.reason, 'error');
  assert.match(r.info.cause.message, /model file missing/);
  assert.strictEqual(E._rerankWarm.has(MODEL), false);
});

test('the pin-time warm-up marks a reranker ready, so the first search reranks at once', async () => {
  const E = ownerE();
  gate.res();
  const w = await RW.warmUp(E, { run: { reranker: MODEL, embedder: require('../../src/core/retrieval-profiles.cjs').NANO }, tiers: {} });
  assert.strictEqual(w.ok, true, JSON.stringify(w));
  assert.strictEqual(RW.rerankerState(E, tier), 'ready');
  assert.strictEqual(calls, 1);
});
