'use strict';
// rerank-provider-auto.test.cjs — the CPU rerank provider is built on demand, in the store owner only (ADR 0050 decision 5): the
// first get() for a pinned ONNX reranker id builds and registers one, a second get() returns the same instance, a non-owner (a copy
// read, a client) never builds one and the rerank stage says so loudly, a GPU or unknown id is not built, and the owner's shutdown
// closes what was built. The REAL rerank-worker.cjs runs on a stub transformers package: no model, no onnx runtime.

process.env.BELAY_TEST_MODE = '1';
require('../helpers/tmp.cjs'); // this file starts processes: its own spawn register (spawn-register-isolation.test.cjs)
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT } = require('./lifecycle-env.cjs');
const { core, sandbox, cleanup } = require('./helpers.cjs');
const { writeStubPackage, writeCache, fakeEntry } = require('./fixtures/rerank-stub-pkg.cjs');
const RP = core('retrieval-profiles.cjs');
const provider = core('rerank-provider.cjs');
const { search } = core('memory-search.cjs');
const { Engine } = core('engine.cjs');

const NS = `project/${PROJECT}`;
const entry = fakeEntry();
const RR = entry.id;
let T, E2, dir;
const FIX = [[1, 0, 0], [0.95, 0.31, 0], [0.8, 0.6, 0], [0.5, 0.866, 0]];
const TEXTS = ['colour palette for the settings page', 'release notes formatting guide', 'lunch order for friday', 'stop a worker process safely by its pid'];
let notes;
before(async () => {
  dir = sandbox();
  const table = { [RR]: entry };
  writeCache(`${dir}/cache`, table);
  provider.setAutoOptions({ pkg: writeStubPackage(`${dir}/pkg`), cacheDir: `${dir}/cache`, table });
  T = await setup();
  notes = TEXTS.map((t, i) => T.note(t, { vec: FIX[i] }));
  E2 = new Engine({ dataDir: T.dir, store: T.store, getEmbedder: null, owner: { opts: {} }, establishedBy: 'test' });
});
after(async () => { await provider.closeAll(); provider.setAutoOptions(null); await T.close(); cleanup(dir); });
afterEach(async () => { await provider.closeAll(); T.E._rerankFallback = null; E2._rerankFallback = null; });

const tier = (over = {}) => ({ profile: 'custom', embedder: RP.NANO, reranker: RR, device: 'cpu', depth: 4, ...over });
const ask = (E, internal = {}) => search(E, T.who.operator('plain'), { namespaces: [NS], query: 'stop a worker by its pid', query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic', k: 4 }, { tier: tier(), ...internal });

test('the owner builds the provider on the first get, the same instance on the second, and registers it', () => {
  assert.strictEqual(provider.get(tier()), null, 'without the owner fact nothing is built');
  const a = provider.get(tier(), { owner: true });
  assert.ok(a && typeof a.rerank === 'function' && typeof a.close === 'function');
  assert.strictEqual(provider.get(tier(), { owner: true }), a);
  assert.strictEqual(provider.get(tier()), a, 'once registered, any caller gets it');
});

test('a non-owner gets none, and the rerank stage reports the absent provider loudly', async () => {
  assert.strictEqual(provider.get(tier(), { owner: false }), null);
  const r = await ask(T.E);
  assert.strictEqual(r.rerank.ran, false);
  assert.ok(r.modes_failed.some(m => m.mode === 'rerank'), JSON.stringify(r.modes_failed));
  assert.strictEqual(provider.get(tier()), null, 'the failed search built nothing');
});

test('a GPU, unknown or missing reranker id is not auto-built', () => {
  for (const id of ['Qwen/Qwen3-Reranker-0.6B-GGUF', 'no/such-reranker', null]) assert.strictEqual(provider.get(tier({ reranker: id }), { owner: true }), null, String(id));
});

test('an end-to-end search in the owner builds the provider and reorders the rows', async () => {
  const r = await ask(E2);
  assert.strictEqual(r.rerank.ran, true, JSON.stringify(r.rerank));
  assert.strictEqual(r.rerank.reranked, 4);
  assert.strictEqual(r.results[0].id, notes[3], 'the note sharing words with the query rises from last to first');
  assert.deepStrictEqual(r.modes_failed, []);
});

test('closeAll closes the child, forgets the provider, and a later owner builds a fresh one', async () => {
  const a = provider.get(tier(), { owner: true });
  await a.rerank({ query: 'stop worker pid', docs: [{ id: 'x', text: 'stop the worker by pid' }] });
  await provider.closeAll(5000);
  assert.strictEqual(provider.get(tier()), null, 'closed providers are forgotten');
  await assert.rejects(a.rerank({ query: 'q', docs: [{ id: 'x', text: 'y' }] }), /closed/);
  const b = provider.get(tier(), { owner: true });
  assert.notStrictEqual(b, a);
});

test('the owner\'s stop closes the registered providers and does not throw when one cannot close', async () => {
  const { Owner } = core('owner.cjs');
  const d = sandbox();
  let closed = 0;
  provider.register('stop/closes', { rerank: async () => ({ scores: [] }), close: async () => { closed += 1; } });
  provider.register('stop/throws', { rerank: async () => ({ scores: [] }), close: async () => { throw new Error('cannot close'); } });
  try {
    const o = new Owner(d, { embed: false });
    await o.start();
    await o.stop();
    assert.strictEqual(closed, 1);
    assert.strictEqual(provider.get({ reranker: 'stop/closes' }), null, 'a closed provider is forgotten');
  } finally { provider.unregister('stop/closes'); provider.unregister('stop/throws'); cleanup(d); }
});
