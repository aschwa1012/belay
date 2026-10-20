'use strict';
// memory-search-tier.test.cjs — memory.search reads the vector cache for the caller's tier (ADR 0050 decisions 2 and 4, amendment 1):
// the cache answers as the inline column did, a store without the cache table falls back to the inline column, a request cannot name
// its tier, and a heavy tier with a backlog refuses by name instead of serving a partial index.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT } = require('./lifecycle-env.cjs');
const MV = require('../../src/core/memory-vectors.cjs');
const RP = require('../../src/core/retrieval-profiles.cjs');
const { search } = require('../../src/core/memory-search.cjs');

let T, notes;
const FIX = [[1, 0, 0], [0.9, 0.436, 0], [0.7, 0.714, 0], [0.2, 0.98, 0], [0, 1, 0], [0.6, 0, 0.8]];
before(async () => { T = await setup(); notes = FIX.map((v, i) => T.note(`tier fixture ${i}`, { vec: v })); });
after(() => T.close());

const NS = `project/${PROJECT}`;
const blob = (v) => Buffer.from(new Float32Array(v).buffer);
const ask = (args = {}, internal) => search(T.E, T.who.operator('plain'), { namespaces: [NS], query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic', k: 20, ...args }, internal);
const ids = (r) => r.results.map(x => x.id);

test('search through the vector cache returns what the inline column returns, ids and order', async () => {
  const viaCache = await ask();
  assert.strictEqual(viaCache.scanned, FIX.length);
  assert.ok(MV.hasTable(T.store.db));
  // the inline column is the reference: score every row by hand
  const expected = notes.map((id, i) => ({ id, s: FIX[i][0] })).sort((a, b) => b.s - a.s).map(x => x.id);
  assert.deepStrictEqual(ids(viaCache), expected);
  // proof the cache is what is read: change one cached vector (not the inline one) and the ranking follows the cache
  const row = T.row(notes[4]);
  const k = { model: 'm', revision: 'r', dims: 3, template: MV.renderTemplateOf(row) };
  MV.putVector(T.store.db, { ...k, template: row.text_template || 'v1' }, MV.embedHashOf(row, row.text_template || 'v1'), blob([1, 0, 0]));
  try {
    const moved = await ask();
    assert.strictEqual(moved.results[0].score > 0.99 && ids(moved).slice(0, 2).includes(notes[4]), true, 'the cached vector decides');
  } finally {
    MV.putVector(T.store.db, { ...k, template: row.text_template || 'v1' }, MV.embedHashOf(row, row.text_template || 'v1'), blob(FIX[4]));
  }
  assert.deepStrictEqual(ids(await ask()), expected);
});

test('a store without the cache table is read from the inline column, E_NO_INDEX territory', async () => {
  const withCache = ids(await ask());
  T.store.db.exec('DROP TABLE memory_vectors');
  T.store._vectors = false;
  try {
    const r = await ask();
    assert.deepStrictEqual(ids(r), withCache, 'the same ids in the same order');
    assert.strictEqual(r.scanned, FIX.length);
    assert.deepStrictEqual(r.modes_failed, []);
  } finally {
    T.store.db.exec(MV.TABLE_SQL);
    MV.migrateVectors(T.store.db, {});
    T.store._vectors = undefined;
  }
  assert.deepStrictEqual(ids(await ask()), withCache);
});

test('a request cannot name its tier: a tier field in the arguments is ignored', async () => {
  const r = await ask({ tier: { embedder: 'heavy/x', dims: 3, reranker: 'fake/rr', depth: 5 }, profile: 'gpu-balanced' });
  assert.strictEqual(r.tier, undefined, 'the default tier is not echoed');
  assert.strictEqual(r.rerank, undefined);
  assert.strictEqual(r.results.length, FIX.length);
});

test('a heavy tier with a backlog refuses with E_TIER_BEHIND and serves nothing; once drained it serves', async () => {
  const heavy = { profile: 'custom', embedder: 'heavy/x', reranker: null, device: 'gpu', depth: 0, dims: 3, revision: '' };
  const q = { embedding_model: 'heavy/x' };
  await assert.rejects(() => ask(q, { tier: heavy }), (e) => {
    assert.strictEqual(e.code, 'E_TIER_BEHIND');
    assert.strictEqual(e.detail.behind, FIX.length);
    assert.strictEqual(e.detail.embedder, 'heavy/x');
    return true;
  });
  // all but one row: still behind, still refused (never a partial index)
  const all = T.store.db.prepare('SELECT * FROM memory_entries WHERE namespace = ?').all(NS);
  const put = (r, v) => { const t = MV.renderTemplateOf(r); MV.putVector(T.store.db, { model: 'heavy/x', revision: '', dims: 3, template: t }, MV.embedHashOf(r, t), blob(v)); };
  all.slice(1).forEach((r) => put(r, [0, 0, 1]));
  await assert.rejects(() => ask(q, { tier: heavy }), (e) => e.code === 'E_TIER_BEHIND' && e.detail.behind === 1);
  put(all[0], [0, 0, 1]);
  const served = await ask({ ...q, query_embedding: [0, 0, 1] }, { tier: heavy });
  assert.strictEqual(served.results.length, FIX.length);
  assert.deepStrictEqual(served.tier, { profile: 'custom', embedder: 'heavy/x', reranker: null, device: 'gpu' });
  assert.strictEqual(served.model, 'heavy/x');
  // keyword search uses no vectors, so a heavy tier's backlog does not refuse it
  const kw = await search(T.E, T.who.operator('plain'), { namespaces: [NS], query: 'fixture', mode: 'keyword' }, { tier: { ...heavy, dims: 3 } });
  assert.ok(kw.results.length > 0);
  T.store.db.prepare("DELETE FROM memory_vectors WHERE model = 'heavy/x'").run();
});

test('the nano tier is the default and the seam returns it', () => {
  const ST = require('../../src/core/search-tier.cjs');
  const tier = ST.tierFor(T.E, T.who.operator('plain'));
  assert.strictEqual(tier.embedder, RP.NANO);
  assert.strictEqual(tier.reranker, null);
});
