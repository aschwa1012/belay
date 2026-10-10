'use strict';
// memory-search-mutation.test.cjs — claims of memory-search.cjs that a mutation run showed no other test pins
// down: the model-binding refusal, the exact-scan ceiling and allow_slow, the named keyword failures, the
// depth of a deep page, the echoed filter, list offsets, and the failure wrapper's merge.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const { withSemanticFailure } = core('memory-search.cjs');

let dir, store, E, orch;
const call = (method, args, caller = orch) => E.handle(method, { ...args, caller });
const put = (ns, text, vec, extra = {}) => call('memory.store', { namespace: ns, text, embedding: vec, embedding_model: 'm', dim: 3, ...extra });
const setCols = (id, cols) => {
  const keys = Object.keys(cols);
  store.db.prepare(`UPDATE memory_entries SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => cols[k]), id);
};
const rejects = (p, code, check) => assert.rejects(p, (e) => { assert.strictEqual(e.code, code, `${e.code}: ${e.message}`); if (check) check(e); return true; });

before(async () => {
  dir = sandbox();
  store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  orch = callerFor('orchestrator');
  await put('mm', 'alpha model bound row', [1, 0, 0], { created_at: 1 });
  await put('kw', 'keyword needle row E_SOME_CODE', [0, 1, 0], { created_at: 1 });
});
after(() => { store.close(); cleanup(dir); });

test('a row whose tags are not JSON is returned with the raw text rather than hiding the row', async () => {
  const r = await put('rawtags', 'tags row', [1, 0, 0], { created_at: 1 });
  setCols(r.id, { tags: 'not json {' });
  const got = await call('memory.get', { id: r.id });
  assert.strictEqual(got.tags, 'not json {');
  assert.strictEqual(got.found, true);
});

test('a query embedded with another model than the namespace is bound to is refused by name', async () => {
  await rejects(call('memory.search', { namespace: 'mm', query_embedding: [1, 0, 0], embedding_model: 'other', mode: 'semantic' }), 'E_MODEL', (e) => {
    assert.strictEqual(e.detail.namespace, 'mm');
    assert.strictEqual(e.detail.bound, 'm');
    assert.match(e.message, /other/);
  });
  const h = await call('memory.search', { namespace: 'mm', query: 'alpha', query_embedding: [1, 0, 0], embedding_model: 'other', mode: 'hybrid' });
  assert.deepStrictEqual(h.modes_run, ['keyword']);
  assert.strictEqual(h.modes_failed[0].mode, 'semantic');
  assert.strictEqual(h.modes_failed[0].code, 'E_MODEL');
  assert.strictEqual(h.absence_established, false);
  const ok = await call('memory.search', { namespace: 'mm', query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic' });
  assert.strictEqual(ok.results.length, 1);
});

test('a namespace above the exact-scan ceiling is refused with its name and counts, and allow_slow scans it anyway', async () => {
  const real = store._loadNs.bind(store);
  const ceiling = Math.floor(50000 * 384 / 3);
  store._loadNs = (ns) => (ns === 'mm' ? { rows: { length: ceiling + 1, [Symbol.iterator]: function* () { /* no rows with a vector */ } }, superseded: new Set() } : real(ns));
  try {
    await rejects(call('memory.search', { namespace: 'mm', query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic' }), 'E_NAMESPACE_TOO_LARGE', (e) => {
      assert.deepStrictEqual(e.detail, { namespace: 'mm', rows: ceiling + 1, ceiling });
    });
    const slow = await call('memory.search', { namespace: 'mm', query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic', allow_slow: true });
    assert.strictEqual(slow.scanned, 0);
    const exactly = ceiling;
    store._loadNs = (ns) => (ns === 'mm' ? { rows: { length: exactly, [Symbol.iterator]: function* () { /* none */ } }, superseded: new Set() } : real(ns));
    const at = await call('memory.search', { namespace: 'mm', query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic' });
    assert.strictEqual(at.scanned, 0, 'a namespace exactly at the ceiling is scanned');
  } finally { store._loadNs = real; }
});

test('a store with no keyword index names the cause in the failed mode and covers nothing', async () => {
  const d2 = sandbox();
  const s2 = new Store(path.join(d2, 'memory.db'), { stamp: true });
  try {
    const E2 = new Engine({ dataDir: d2, store: s2, getEmbedder: null, owner: null, establishedBy: 'test' });
    await E2.handle('memory.store', { namespace: 'x', text: 'findable text', embedding: [1, 0, 0], embedding_model: 'm', dim: 3, caller: orch });
    s2.db.prepare("DELETE FROM meta WHERE key = 'memory_fts_version'").run();
    const r = await E2.handle('memory.search', { namespace: 'x', query: 'findable', mode: 'keyword', caller: orch });
    assert.deepStrictEqual(r.results, []);
    assert.deepStrictEqual(r.modes_run, []);
    assert.strictEqual(r.modes_failed.length, 1);
    assert.strictEqual(r.modes_failed[0].code, 'E_NO_INDEX');
    assert.match(r.modes_failed[0].message, /no keyword index/);
    assert.strictEqual(r.absence_established, false);
    assert.strictEqual(r.searched.fts, false);
    assert.match(r.warning, /keyword search did not run \(E_NO_INDEX\)/);
    assert.match(r.warning, /nothing was searched/);
  } finally { s2.close(); cleanup(d2); }
});

test('a keyword query that fails inside SQLite is a named failure, not a thrown error or an empty match', async () => {
  const real = store.db;
  const failing = (message) => new Proxy(real, {
    get(t, p) {
      const v = t[p];
      if (p === 'prepare') return (sql) => { if (/bm25/.test(sql)) throw new Error(message); return t.prepare(sql); };
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  try {
    store.db = failing('no such table: memory_fts');
    const a = await call('memory.search', { namespace: 'kw', query: 'needle', mode: 'keyword' });
    assert.strictEqual(a.modes_failed[0].code, 'E_NO_INDEX');
    assert.match(a.modes_failed[0].message, /the keyword index could not be read: no such table: memory_fts/);
    assert.deepStrictEqual(a.results, []);
    assert.strictEqual(a.absence_established, false);
    store.db = failing('disk I/O error');
    const b = await call('memory.search', { namespace: 'kw', query: 'needle', mode: 'keyword' });
    assert.strictEqual(b.modes_failed[0].code, 'E_INTERNAL');
    assert.match(b.modes_failed[0].message, /disk I\/O error/);
    store.db = failing('database disk image is malformed');
    const c = await call('memory.search', { namespace: 'kw', query: 'needle', mode: 'keyword' });
    assert.strictEqual(c.modes_failed[0].code, 'E_NO_INDEX');
  } finally { store.db = real; }
});

test('the result echoes the filter and namespaces searched, and the dropped keyword terms', async () => {
  const filter = { types: ['fact'] };
  const r = await call('memory.search', { namespace: 'kw', query: 'needle ab', mode: 'keyword', filter });
  assert.deepStrictEqual(r.searched.filter, filter);
  assert.deepStrictEqual(r.searched.namespaces, ['kw']);
  assert.deepStrictEqual(r.searched.keyword_terms_dropped, ['ab']);
  assert.strictEqual(r.searched.fts, true);
  const none = await call('memory.search', { namespace: 'kw', query: 'needle', mode: 'keyword' });
  assert.deepStrictEqual(none.searched.filter, {});
  assert.strictEqual(none.searched.keyword_terms_dropped, undefined);
});

test('a deep page reaches past the first sixty hits', async () => {
  for (let i = 0; i < 100; i++) await put('deep', `deep row number ${i}`, [1, 0, 0], { created_at: 100 + i });
  const r = await call('memory.search', { namespace: 'deep', query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic', k: 50, offset: 40 });
  assert.strictEqual(r.results.length, 50);
  const first = await call('memory.search', { namespace: 'deep', query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic', k: 50, offset: 0 });
  assert.strictEqual(first.results.length, 50);
  const overlap = first.results.slice(40).map(x => x.id);
  assert.deepStrictEqual(r.results.slice(0, 10).map(x => x.id), overlap);
});

test('list refuses a negative offset, a zero limit and a bad order, naming the field', async () => {
  await rejects(call('memory.list', { namespace: 'kw', offset: -1 }), 'E_ARGS', (e) => assert.strictEqual(e.detail.field, 'offset'));
  await rejects(call('memory.list', { namespace: 'kw', limit: 0 }), 'E_ARGS', (e) => assert.strictEqual(e.detail.field, 'limit'));
  await rejects(call('memory.list', { namespace: 'kw', order: 'score' }), 'E_ARGS', (e) => assert.strictEqual(e.detail.field, 'order'));
  const ok = await call('memory.list', { namespace: 'kw', offset: 0, limit: 1 });
  assert.strictEqual(ok.rows.length, 1);
  assert.strictEqual(ok.total, 1);
  assert.deepStrictEqual(ok.searched, { namespaces: ['kw'], filter: {}, rows_considered: 1 });
});

test('withSemanticFailure puts the failure first, keeps earlier failures and clears absence', () => {
  const earlier = { mode: 'keyword', code: 'E_NO_INDEX', message: 'x' };
  const merged = withSemanticFailure({ warning: 'old', results: [], modes_run: ['keyword'], modes_failed: [earlier], absence_established: true }, { code: 'E_TIMEOUT', message: 'slow' });
  assert.deepStrictEqual(Object.keys(merged)[0], 'warning');
  assert.match(merged.warning, /semantic search did not run \(E_TIMEOUT\)/);
  assert.deepStrictEqual(merged.modes_failed, [{ mode: 'semantic', code: 'E_TIMEOUT', message: 'slow' }, earlier]);
  assert.strictEqual(merged.absence_established, false);
  const bare = withSemanticFailure({ warning: null, results: [] }, { code: 'E_OWNER_LOST', message: 'gone' });
  assert.deepStrictEqual(bare.modes_failed, [{ mode: 'semantic', code: 'E_OWNER_LOST', message: 'gone' }]);
  assert.strictEqual(bare.absence_established, false);
});
