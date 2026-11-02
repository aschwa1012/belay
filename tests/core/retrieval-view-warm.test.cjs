'use strict';
// retrieval-view-warm.test.cjs — what a run's reranker warm-up records look like to belay status, the run receipt and the panel (pure view).

const { test } = require('node:test');
const assert = require('node:assert');
const RV = require('../../src/core/retrieval-view.cjs');

const row = (warmups, over = {}) => ({ epoch: 1, retrieval_routing: JSON.stringify({ v: 1, pinned_at: 1, routing: { run: { profile: 'gpu-balanced', embedder: 'emb', reranker: 'rr', device: 'gpu' }, tiers: {} }, notices: [], warmups, ...over }) });
const W = (o) => ({ id: 'x', model: 'rr', trigger: 'first_search', state: 'ready', started_at: 10, ended_at: 15, ms: 5, served_warming: 0, ...o });

test('a warm-up in progress is one short line and the reranker is warming', () => {
  const v = RV.describe(row([W({ state: 'loading', ended_at: undefined, ms: undefined })]));
  assert.deepStrictEqual(RV.lines(v).filter((l) => /warm/.test(l)), ['retrieval: reranker rr is warming (first search)']);
  assert.strictEqual(RV.models(v).find((m) => m.role === 'reranker').state, 'warming');
});

test('a finished warm-up gives its time, trigger and the count of searches served warming', () => {
  const v = RV.describe(row([W({ served_warming: 3 })]));
  assert.ok(RV.lines(v).includes('retrieval: reranker rr warmed in 5 ms (first search); 3 searches kept the fusion order meanwhile'));
  const m = RV.models(v).find((x) => x.role === 'reranker');
  assert.deepStrictEqual([m.state, m.warm.trigger, m.warm.served_warming], ['ready', 'first_search', 3]);
});

test('a failed warm-up names its error; the newest record of a model decides its state', () => {
  const v = RV.describe(row([W({ state: 'failed', error: 'model file missing', started_at: 1 }), W({ id: 'y', trigger: 'retry', started_at: 20, state: 'ready' })]));
  assert.strictEqual(RV.models(v).find((x) => x.role === 'reranker').state, 'ready');
  const f = RV.describe(row([W({ state: 'failed', error: 'model file missing' })]));
  assert.ok(RV.lines(f).some((l) => /warm-up failed after 5 ms \(first search\): model file missing/.test(l)));
  assert.strictEqual(RV.models(f).find((x) => x.role === 'reranker').state, 'failed');
});

test('a profile with no reranker shows it off, and a pin before the record existed still reads', () => {
  const v = RV.describe({ epoch: 1, retrieval_routing: JSON.stringify({ v: 1, pinned_at: 1, routing: { run: { profile: 'cpu-fast', embedder: 'nano', reranker: null, device: 'cpu' }, tiers: {} }, notices: [] }) });
  assert.deepStrictEqual(v.warmups, []);
  assert.deepStrictEqual(RV.models(v).map((m) => [m.role, m.state]), [['embedder', 'ready'], ['reranker', 'off']]);
  assert.deepStrictEqual(RV.models(null), []);
});

test('a fallback in force shows both models as fallback, whatever the last warm-up said', () => {
  const v = RV.describe(row([W({ served_warming: 1 })], { fallback: { epoch: 1, at: 5, cause: { code: 'E_MODEL_ABSENT', message: 'the GPU process exited' } } }));
  assert.deepStrictEqual(RV.models(v).map((m) => [m.role, m.state]), [['embedder', 'fallback'], ['reranker', 'fallback']]);
});

test('a warm-up still marked loading on an ended run is unfinished, never warming', () => {
  const r = row([W({ state: 'loading', ended_at: undefined, ms: undefined })]);
  const v = RV.describe({ ...r, ended_at: 99 });
  assert.ok(RV.lines(v).some((l) => /warm-up did not finish: the owner that started it stopped \(first search\)/.test(l)));
  assert.strictEqual(RV.models(v).find((x) => x.role === 'reranker').state, 'unfinished', 'a stop is a shutdown, not a failure');
});

test('a loading record from an owner that no longer serves is unfinished on a live run: no owner, a dead one, another pid, the same pid created later', () => {
  const live = row([W({ state: 'loading', ended_at: undefined, ms: undefined, owner_pid: 100, owner_created: 5 })]);
  const state = (owner) => RV.models(RV.describe(live, owner)).find((m) => m.role === 'reranker').state;
  assert.strictEqual(state(undefined), 'warming', 'owner unknown: the record stands');
  assert.strictEqual(state({ pid: 100, created: 5, alive: true }), 'warming', 'the same owner still serves');
  assert.strictEqual(state(null), 'unfinished');
  assert.strictEqual(state({ pid: 100, alive: false }), 'unfinished');
  assert.strictEqual(state({ pid: 200, alive: true }), 'unfinished');
  assert.strictEqual(state({ pid: 100, created: 9, alive: true }), 'unfinished');
});
