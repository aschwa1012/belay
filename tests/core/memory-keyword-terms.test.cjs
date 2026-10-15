'use strict';
// memory-keyword-terms.test.cjs — the keyword half's one term extractor (memory-relevance pickTerms), shared by memory.search and
// memory.index: a published stopword list, the zero-IDF drop, identifiers kept whole, and the receipt that names every dropped
// term and why. Includes the review's junk case: a row that shares only a filler word must not beat the semantic best.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const R = core('memory-relevance.cjs');
const { ENGLISH_STOP_WORDS } = core('stopwords-en.cjs');
const { MAX_TERMS, DEFAULT_PAGE } = core('fts-query.cjs');

const orch = callerFor('orchestrator');

async function withStore(fn) {
  const dir = sandbox();
  const store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  const E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  try { await fn({ E, store, put: (text, extra = {}) => store.store({ namespace: 'n', worker_id: 'w', text, ...extra }) }); } finally { store.close(); cleanup(dir); }
}
const search = (E, args) => E.handle('memory.search', { caller: orch, namespace: 'n', ...args });
const reasonOf = (r, term) => (r.searched.keyword_terms_dropped || []).find((d) => d.term === term)?.reason;
// Ten rows, so the zero-IDF rule is in force (it starts at ZERO_IDF_MIN_ROWS).
const filler = (put, n = 10, extra = (i) => `filler row ${i}`) => { for (let i = 0; i < n; i++) put(extra(i)); };

test('the stopword list is the published Lucene set, verbatim, and the extractor uses it', () => {
  assert.strictEqual(ENGLISH_STOP_WORDS.length, 33);
  assert.deepStrictEqual(ENGLISH_STOP_WORDS.slice(0, 4), ['a', 'an', 'and', 'are']);
  for (const w of ENGLISH_STOP_WORDS) assert.ok(R.STOPWORDS.has(w), w);
  const dropped = [];
  R.termStats('this table, with their words', 128, dropped);
  assert.deepStrictEqual(dropped.filter((d) => d.reason === 'stopword').map((d) => d.term).sort(), ['their', 'this', 'with']);
});

test('the review junk case: a row sharing only "the" does not beat the semantic best', async () => {
  await withStore(async ({ E }) => {
    const store = (text, v) => E.handle('memory.store', { caller: orch, namespace: 'n', text, embedding: v, embedding_model: 'm', dim: 3 });
    const target = await store('Ferries depart at noon from pier four', [1, 0, 0]);
    const decoy = await store('Rotate the API key every quarter', [0.2, 1, 0]);
    await store('Unrelated vector row about caching', [0, 0, 1]);
    const r = await search(E, { query: 'when does the boat go', query_embedding: [1, 0.1, 0], embedding_model: 'm', k: 3 });
    assert.strictEqual(r.results[0].id, target.id, 'the semantic best stays first');
    const d = r.results.find((x) => x.id === decoy.id);
    assert.strictEqual(d.ranks.keyword, null, 'the "the"-only row earns no keyword rank');
    assert.strictEqual(reasonOf(r, 'the'), 'stopword');
  });
});

test('a term in half the rows or more is dropped as zero IDF, and a row matching only such terms matches nothing', async () => {
  await withStore(async ({ E, put }) => {
    for (let i = 0; i < 6; i++) put(`harbour log ${i}`);
    put('quokka sighting at the harbour');
    for (let i = 0; i < 5; i++) put(`unrelated entry ${i}`);
    const r = await search(E, { query: 'quokka harbour', mode: 'keyword' });
    assert.strictEqual(r.results.length, 1);
    assert.match(r.results[0].text, /quokka/);
    assert.strictEqual(reasonOf(r, 'harbour'), 'zero-idf', 'harbour is in 7 of 12 rows');
    const only = await search(E, { query: 'harbour', mode: 'keyword' });
    assert.deepStrictEqual(only.results, []);
    assert.strictEqual(only.modes_failed[0].code, 'E_QUERY_SHORT', 'a query with nothing left to rank did not run, it is not an empty match');
    assert.match(only.modes_failed[0].message, /harbour: zero-idf/);
    assert.strictEqual(only.absence_established, false);
  });
});

test('the zero-IDF rule starts at ZERO_IDF_MIN_ROWS rows and uses the rows of the namespaces searched', async () => {
  assert.strictEqual(R.ZERO_IDF_MIN_ROWS, DEFAULT_PAGE + 1, 'a store of at most one default page is one page: nothing to protect');
  await withStore(async ({ E, put }) => {
    for (let i = 0; i < DEFAULT_PAGE; i++) put(`harbour note ${i}`);
    const small = await search(E, { query: 'harbour', mode: 'keyword', k: 100 });
    assert.strictEqual(small.results.length, DEFAULT_PAGE, 'with one page of rows a term in every row is still searched');
    put('one more row');
    const over = await search(E, { query: 'harbour', mode: 'keyword' });
    assert.strictEqual(over.modes_failed[0].code, 'E_QUERY_SHORT', 'with 11 rows it is in 10 of them and nothing is left to rank');
    assert.match(over.modes_failed[0].message, /harbour: zero-idf/);
  });
});

test('three-letter plain words are searchable: API, SQL, key and TTL are not dropped as too short', async () => {
  const dropped = [];
  const t = R.termStats('rotate the API key, run the SQL with a TTL', 128, dropped);
  for (const w of ['api', 'key', 'sql', 'ttl']) assert.ok(t.some((x) => x.t === w), w);
  assert.ok(!dropped.some((d) => d.reason === 'too-short'), JSON.stringify(dropped));
  await withStore(async ({ E, put }) => {
    filler(put, 12);
    put('Rotate the API key every quarter');
    const r = await search(E, { query: 'API key', mode: 'keyword' });
    assert.strictEqual(r.results.length, 1);
    assert.strictEqual(r.searched.keyword_terms_dropped, undefined);
  });
});

test('identifiers are kept whole and unstemmed, and found', async () => {
  const t = R.termsOf('call parseArgs from src/this.cjs and src/stores.cjs, then the stores');
  assert.ok(t.includes('parseargs') && t.includes('src/this.cjs') && t.includes('src/stores.cjs'), JSON.stringify(t));
  assert.ok(!t.includes('src/store.cjs') && !t.includes('stor'), 'an identifier is never stemmed');
  assert.ok(t.includes('store'), 'a plain plural is stemmed');
  await withStore(async ({ E, put }) => {
    filler(put);
    put('parseArgs rejects an unknown flag');
    put('src/this.cjs reads the lease file');
    const r = await search(E, { query: 'src/this.cjs parseArgs', mode: 'keyword' });
    assert.strictEqual(r.results.length, 2);
    assert.strictEqual(r.searched.keyword_terms_dropped, undefined);
  });
});

test('the receipt lists every dropped term with its reason: stopword, too-short, zero-idf, no-row, over-cap', async () => {
  await withStore(async ({ E, put }) => {
    for (let i = 0; i < 6; i++) put(`harbour entry ${i}`);
    for (let i = 0; i < 6; i++) put(`row ${i} carries lexeme${String(i * 8).padStart(2, '0')} lexeme${String(i * 8 + 1).padStart(2, '0')} lexeme${String(i * 8 + 2).padStart(2, '0')} lexeme${String(i * 8 + 3).padStart(2, '0')} lexeme${String(i * 8 + 4).padStart(2, '0')} lexeme${String(i * 8 + 5).padStart(2, '0')} lexeme${String(i * 8 + 6).padStart(2, '0')} lexeme${String(i * 8 + 7).padStart(2, '0')}`);
    const lex = Array.from({ length: 40 }, (_, i) => `lexeme${String(i).padStart(2, '0')}`);
    const r = await search(E, { query: `the ab harbour nomatchzz ${lex.join(' ')}`, mode: 'keyword' });
    const by = {};
    for (const d of r.searched.keyword_terms_dropped) (by[d.reason] ||= []).push(d.term);
    assert.deepStrictEqual(by.stopword, ['the']);
    assert.deepStrictEqual(by['too-short'], ['ab']);
    assert.deepStrictEqual(by['zero-idf'], ['harbour']);
    assert.deepStrictEqual(by['no-row'], ['nomatchzz']);
    assert.strictEqual(by['over-cap'].length, 40 - MAX_TERMS, 'the terms beyond the cap are named too');
    assert.strictEqual(r.results.length, 4, 'the 32 kept terms (lexeme00 to lexeme31) sit in the first four rows');
  });
});

test('a query whose informative terms are in no row ran and found nothing; one with no informative term did not run', async () => {
  await withStore(async ({ E, put }) => {
    filler(put);
    const none = await search(E, { query: 'nomatchzz', mode: 'keyword' });
    assert.deepStrictEqual(none.modes_run, ['keyword']);
    assert.deepStrictEqual(none.results, []);
    assert.strictEqual(reasonOf(none, 'nomatchzz'), 'no-row');
    const stop = await search(E, { query: 'the with this', mode: 'keyword' });
    assert.deepStrictEqual(stop.modes_run, []);
    assert.strictEqual(stop.modes_failed[0].code, 'E_QUERY_SHORT');
  });
});

test('memory.search and memory.index share one extractor: the search receipt is pickTerms\'s dropped list', async () => {
  await withStore(async ({ E, store, put }) => {
    filler(put);
    put('quokka sighting');
    const q = 'the quokka sighting nomatchzz ab';
    const r = await search(E, { query: q, mode: 'keyword' });
    const picked = R.pickTerms(store.db, q, ['n']);
    assert.deepStrictEqual(r.searched.keyword_terms_dropped, picked.dropped);
    assert.deepStrictEqual(picked.terms.map((x) => x.t).sort(), ['quokka', 'sight']);
  });
});

test('document frequencies count the rows of the namespaces searched, not of the store', async () => {
  await withStore(async ({ E, store, put }) => {
    for (let i = 0; i < 6; i++) put(`harbour note ${i}`);
    for (let i = 0; i < 6; i++) put(`unrelated entry ${i}`);
    // Another namespace holds zebra and a great many harbour rows; neither may change what 'n' reports.
    store.store({ namespace: 'other', worker_id: 'w', text: 'zebra crossing' });
    for (let i = 0; i < 30; i++) store.store({ namespace: 'other', worker_id: 'w', text: `harbour elsewhere ${i}` });
    const z = await search(E, { query: 'zebra', mode: 'keyword' });
    assert.strictEqual(reasonOf(z, 'zebra'), 'no-row', 'a term only another namespace holds is in no row of this one');
    const h = await search(E, { query: 'harbour', mode: 'keyword' });
    assert.strictEqual(h.modes_failed[0].code, 'E_QUERY_SHORT');
    assert.match(h.modes_failed[0].message, /harbour: zero-idf/, 'harbour is in 6 of the 12 rows of n');
    const both = await E.handle('memory.search', { caller: orch, query: 'zebra', mode: 'keyword', namespaces: ['n', 'other'] });
    assert.strictEqual(both.results.length, 1, 'searching both namespaces finds it (the store is then covered)');
  });
});
