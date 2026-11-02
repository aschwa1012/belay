'use strict';
// memory-search-tier.test.cjs — memory.search serves the caller's retrieval tier (ADR 0050 decisions 2 and 4, amendment 1): nano scans the
// resident inline vectors as it always did and asks the vector cache only for a row that lacks one; a heavy tier reads its own vectors
// from the cache, loaded once, and never serves a partial index; a request cannot name its tier.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { setup, PROJECT } = require('./lifecycle-env.cjs');
const MV = require('../../src/core/memory-vectors.cjs');
const RP = require('../../src/core/retrieval-profiles.cjs');
const ST = require('../../src/core/search-tier.cjs');
const { search } = require('../../src/core/memory-search.cjs');

let T, notes;
const FIX = [[1, 0, 0], [0.9, 0.436, 0], [0.7, 0.714, 0], [0.2, 0.98, 0], [0, 1, 0], [0.6, 0, 0.8]];
before(async () => { T = await setup(); notes = FIX.map((v, i) => T.note(`tier fixture ${i}`, { vec: v })); });
after(() => T.close());

const NS = `project/${PROJECT}`;
const blob = (v) => Buffer.from(new Float32Array(v).buffer);
const ask = (args = {}, internal) => search(T.E, T.who.operator('plain'), { namespaces: [NS], query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic', k: 20, ...args }, internal);
const ids = (r) => r.results.map(x => x.id);
const HEAVY = { profile: 'custom', embedder: 'heavy/x', reranker: null, device: 'gpu', depth: 0, dims: 3, revision: '' };
const drain = (vec = [0, 0, 1]) => {
  for (const r of T.store.db.prepare('SELECT * FROM memory_entries WHERE namespace = ?').all(NS)) {
    const t = MV.renderTemplateOf(r);
    MV.putVector(T.store.db, { model: 'heavy/x', revision: '', dims: 3, template: t }, MV.embedHashOf(r, t), blob(vec));
  }
};
const undrain = () => T.store.db.prepare("DELETE FROM memory_vectors WHERE model = 'heavy/x'").run();

// Counts the work a search does: sha256 hashing and memory_vectors statement calls.
function spy() {
  const n = { hashes: 0, vectorCalls: 0 };
  const createHash = crypto.createHash, prepare = T.store.db.prepare.bind(T.store.db);
  crypto.createHash = (...a) => { n.hashes++; return createHash(...a); };
  T.store.db.prepare = (sql) => {
    const st = prepare(sql);
    if (!/FROM memory_vectors/.test(sql)) return st; // reads of the table (its existence check is not one)
    return new Proxy(st, { get: (t, k) => (['get', 'all', 'iterate', 'run'].includes(k) ? (...a) => { n.vectorCalls++; return t[k](...a); } : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  };
  return { n, stop() { crypto.createHash = createHash; delete T.store.db.prepare; } };
}

test('the nano tier returns the inline scores in order, and a second search does no hashing and reads no memory_vectors', async () => {
  const first = await ask();
  assert.strictEqual(first.scanned, FIX.length);
  assert.deepStrictEqual(ids(first), notes.map((id, i) => ({ id, s: FIX[i][0] })).sort((a, b) => b.s - a.s).map(x => x.id));
  const s = spy();
  try {
    const second = await ask();
    assert.deepStrictEqual(ids(second), ids(first));
    assert.deepStrictEqual(s.n, { hashes: 0, vectorCalls: 0 }, 'every row has an inline vector: the fast path does no per-row work');
  } finally { s.stop(); }
});

test('a row with no inline vector but a cached content vector is still found (the cleared v2 note case)', async () => {
  const id = T.note('tier cleared inline', { vec: [1, 0, 0] });
  T.store.db.prepare('UPDATE memory_entries SET embedding = NULL, embedding_model = NULL, embedding_revision = NULL, dim = NULL WHERE id = ?').run(id);
  T.store.cache.clear();
  try {
    const r = await ask();
    assert.ok(ids(r).includes(id), 'found through the cache');
    assert.strictEqual(r.scanned, FIX.length + 1);
    assert.strictEqual(r.results.find(x => x.id === id).score, 1);
  } finally { T.store.delete(id); }
});

test('mixed revisions in one namespace: every inline vector is scanned, and the cache revision is the most common, ties by name', async () => {
  const ranked = ids(await ask());
  const set = (rev, list) => { for (const id of list) T.store.db.prepare('UPDATE memory_entries SET embedding_revision = ? WHERE id = ?').run(rev, id); T.store.cache.clear(); };
  const m = { embedding_model: 'm', dim: 3 };
  try {
    set('r2', notes.slice(0, 2));
    assert.deepStrictEqual(ids(await ask()), ranked, 'the same answer with two revisions');
    assert.strictEqual(ST.nanoKey(T.E, NS, m).revision, 'r', 'four rows of r beat two of r2');
    set('r2', notes.slice(0, 3));
    assert.strictEqual(ST.nanoKey(T.E, NS, m).revision, 'r', 'three and three: the smaller name');
    set('r2', notes.slice(0, 4));
    assert.strictEqual(ST.nanoKey(T.E, NS, m).revision, 'r2');
  } finally { set('r', notes); }
});

test('a request cannot name its tier: a tier field in the arguments is ignored', async () => {
  const r = await ask({ tier: { embedder: 'heavy/x', dims: 3, reranker: 'fake/rr', depth: 5 }, profile: 'gpu-balanced' });
  assert.strictEqual(r.tier, undefined, 'the default tier is not echoed');
  assert.strictEqual(r.rerank, undefined);
  assert.strictEqual(r.results.length, FIX.length);
});

test('a heavy tier with a backlog refuses with E_TIER_BEHIND and serves nothing; once drained it serves', async () => {
  const q = { embedding_model: 'heavy/x' };
  await assert.rejects(() => ask(q, { tier: HEAVY }), (e) => e.code === 'E_TIER_BEHIND' && e.detail.behind === FIX.length && e.detail.embedder === 'heavy/x');
  // all but one row: still behind, still refused (never a partial index)
  const all = T.store.db.prepare('SELECT * FROM memory_entries WHERE namespace = ?').all(NS);
  const put = (r) => { const t = MV.renderTemplateOf(r); MV.putVector(T.store.db, { model: 'heavy/x', revision: '', dims: 3, template: t }, MV.embedHashOf(r, t), blob([0, 0, 1])); };
  all.slice(1).forEach(put);
  await assert.rejects(() => ask(q, { tier: HEAVY }), (e) => e.code === 'E_TIER_BEHIND' && e.detail.behind === 1);
  put(all[0]);
  const served = await ask({ ...q, query_embedding: [0, 0, 1] }, { tier: HEAVY });
  assert.strictEqual(served.results.length, FIX.length);
  assert.deepStrictEqual(served.tier, { profile: 'custom', embedder: 'heavy/x', reranker: null, device: 'gpu' });
  assert.strictEqual(served.model, 'heavy/x');
  const kw = await search(T.E, T.who.operator('plain'), { namespaces: [NS], query: 'fixture', mode: 'keyword' }, { tier: HEAVY });
  assert.ok(kw.results.length > 0, 'keyword search uses no vectors, so a backlog does not refuse it');
  undrain();
});

test('a note written after the backlog check is refused by the scan itself, never served as a partial index', async () => {
  drain();
  const m = ST.binding(T.E, HEAVY, NS);
  const o = { filterSql: { where: '', params: [] }, includeSuperseded: false, hidden: null };
  try {
    ST.assertServable(T.E, HEAVY, [NS]); // passes: nothing is behind
    assert.strictEqual(ST.candidates(T.E, HEAVY, NS, m, o).length, FIX.length);
    const late = T.note('tier late note', { vec: [1, 0, 0] }); // written between the check and the scan
    assert.throws(() => ST.candidates(T.E, HEAVY, NS, m, o), (e) => e.code === 'E_TIER_BEHIND' && e.detail.ids.includes(late) && e.detail.behind === 1);
    T.store.delete(late);
  } finally { undrain(); }
});

test('a turn row is not behind a heavy tier: it is never embedded there, and a heavy scan leaves it out', async () => {
  drain();
  const m = ST.binding(T.E, HEAVY, NS);
  const o = { filterSql: { where: '', params: [] }, includeSuperseded: false, hidden: null };
  try {
    const turn = T.store.store({ namespace: NS, worker_id: 'w-turn', type: 'turn', text: 'the worker finished the loader change', embedding: [1, 0, 0], embedding_model: 'm', embedding_revision: 'r', dim: 3 });
    ST.assertServable(T.E, HEAVY, [NS]); // a note written the same way would be behind and refused
    const got = ST.candidates(T.E, HEAVY, NS, m, o);
    assert.strictEqual(got.length, FIX.length);
    assert.ok(!got.some((c) => c.id === turn.id));
    assert.deepStrictEqual(MV.backlog(T.store.db, { model: 'heavy/x', revision: '', dims: 3 }, { namespaces: [NS] }).map((r) => r.id), [], 'not in the heavy backlog');
    T.store.delete(turn.id);
  } finally { undrain(); }
});

test('a heavy tier loads its vectors once per namespace and reloads after a write', async () => {
  drain();
  const q = { embedding_model: 'heavy/x', query_embedding: [0, 0, 1] };
  try {
    await ask(q, { tier: HEAVY });
    const s = spy();
    try {
      await ask(q, { tier: HEAVY });
      assert.deepStrictEqual(s.n, { hashes: 0, vectorCalls: 0 }, 'the second heavy search reads the loaded vectors');
    } finally { s.stop(); }
    const late = T.note('tier reload note', { vec: [1, 0, 0] });
    await assert.rejects(() => ask(q, { tier: HEAVY }), (e) => e.code === 'E_TIER_BEHIND', 'the write dropped the loaded cache');
    T.store.delete(late);
    const s2 = spy();
    try { await ask(q, { tier: HEAVY }); assert.ok(s2.n.hashes >= FIX.length, 'a reload hashes each row once'); } finally { s2.stop(); }
  } finally { undrain(); }
});

test('a heavy tier on a store with no vector cache: a hybrid search answers from keywords with E_NO_INDEX in modes_failed', async () => {
  T.store.db.exec('DROP TABLE memory_vectors');
  try {
    const r = await ask({ mode: 'hybrid', query: 'fixture', embedding_model: 'heavy/x' }, { tier: HEAVY });
    assert.ok(r.results.length > 0, 'the keyword half answered');
    assert.deepStrictEqual(r.modes_failed.map(f => [f.mode, f.code]), [['semantic', 'E_NO_INDEX']]);
    await assert.rejects(() => ask({ embedding_model: 'heavy/x' }, { tier: HEAVY }), (e) => e.code === 'E_NO_INDEX', 'a semantic search is refused by name');
    // nano needs no cache table: it reads the inline vectors
    assert.strictEqual((await ask()).scanned, FIX.length);
  } finally { T.store.db.exec(MV.TABLE_SQL); MV.migrateVectors(T.store.db, {}); }
});

test('the nano tier is the default and the seam returns it', () => {
  const tier = ST.tierFor(T.E, T.who.operator('plain'));
  assert.strictEqual(tier.embedder, RP.NANO);
  assert.strictEqual(tier.reranker, null);
});

test('a vector written outside the Store after the heavy map was built is seen by the next search (write generation)', async () => {
  drain([0, 0, 1]);
  const q = { embedding_model: 'heavy/x', query_embedding: [1, 0, 0] };
  try {
    const before = await ask(q, { tier: HEAVY });
    assert.ok(before.results.every(r => r.score === 0), 'every heavy vector is orthogonal to the query');
    const row = T.row(notes[2]), t = MV.renderTemplateOf(row);
    MV.putVector(T.store.db, { model: 'heavy/x', revision: '', dims: 3, template: t }, MV.embedHashOf(row, t), blob([1, 0, 0])); // not through the Store
    const after = await ask(q, { tier: HEAVY });
    assert.strictEqual(after.results[0].id, notes[2]);
    assert.strictEqual(after.results[0].score, 1);
    // a sweep that removes a vector also drops the map: a note that lost its vector is behind again
    T.store.db.prepare("DELETE FROM memory_vectors WHERE model = 'heavy/x' AND embed_hash = ?").run(MV.embedHashOf(row, t));
    MV.bump(T.store.db); // a raw DELETE is outside the module; MV.sweep/sweepRows/catchUp bump on their own
    await assert.rejects(() => ask(q, { tier: HEAVY }), (e) => e.code === 'E_TIER_BEHIND');
  } finally { undrain(); }
});

test('patchBody drops a kept heavy map: a changed when re-hashes the rows', async () => {
  drain();
  const q = { embedding_model: 'heavy/x', query_embedding: [0, 0, 1] };
  try {
    await ask(q, { tier: HEAVY });
    const s = spy();
    try {
      await ask(q, { tier: HEAVY });
      assert.strictEqual(s.n.hashes, 0, 'kept');
      T.store.patchBody(notes[0], (b) => ({ ...b, when: 'when a patch changes the template' }));
      await ask(q, { tier: HEAVY });
      assert.ok(s.n.hashes >= FIX.length, 'rebuilt after the patch');
    } finally { s.stop(); }
    T.store.patchBody(notes[0], (b) => { const { when, ...rest } = b; return rest; });
  } finally { undrain(); }
});

test('an expired row that is not swept yet does not keep the heavy map from being kept', async () => {
  drain();
  const q = { embedding_model: 'heavy/x', query_embedding: [0, 0, 1] };
  let id;
  try {
    id = T.note('tier expired unswept', { vec: [1, 0, 0] });
    T.store.db.prepare('UPDATE memory_entries SET ttl_at = 1 WHERE id = ?').run(id);
    T.store.cache.clear();
    await ask(q, { tier: HEAVY }); // loads the map: the expired row has no heavy vector and is not in the backlog
    const s = spy();
    try {
      const r = await ask(q, { tier: HEAVY });
      assert.ok(!ids(r).includes(id));
      assert.deepStrictEqual(s.n, { hashes: 0, vectorCalls: 0 }, 'the second search reloads nothing');
    } finally { s.stop(); }
  } finally { if (id) T.store.delete(id); undrain(); }
});
