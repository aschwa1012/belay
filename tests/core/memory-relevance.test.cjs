'use strict';
// memory-relevance.test.cjs — memory.index ranks rows by relevance to the task text (ADR 0042 decision 2,
// amendment "relevance"): BM25 over the trigram index with the text's salient terms joined by OR, cosine
// over stored vectors only when the caller supplies a query embedding, inside the unchanged tiers. The
// store is G2's: the fourteen rows of docs/research/memory-value/seed-relevant.jsonl, all verified, none
// carrying a file under the task's files_owned or the task's id, so without relevance every task saw the
// same newest rows. No model is loaded: rows are stored without vectors, or with supplied ones.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const R = core('memory-relevance.cjs');

const SEEDS = path.join(__dirname, '..', '..', 'docs', 'research', 'memory-value', 'seed-relevant.jsonl');
const seedRows = () => fs.readFileSync(SEEDS, 'utf8').split('\n').filter((l) => l.trim()).slice(1).map((l) => JSON.parse(l));

let dir, store, E, orch;
const call = (method, args, caller = orch) => E.handle(method, { ...args, caller });
const verify = (id) => store.db.prepare("UPDATE memory_entries SET status = 'verified' WHERE id = ?").run(id);
const titleOf = (id) => store.db.prepare('SELECT title FROM memory_entries WHERE id = ?').get(id).title;
let ns = 0;
const fresh = () => `rel${++ns}`;

// The G2 seed rows in their own namespace, created in file order one millisecond apart, every row verified.
async function g2Store() {
  const name = fresh();
  const ids = [];
  let at = 5000;
  for (const r of seedRows()) {
    const got = await call('memory.store', { namespace: name, text: r.text, title: r.title, type: r.type, body: r.body, tags: r.tags, embed: false, created_at: at++ });
    verify(got.id);
    ids.push(got.id);
  }
  return { name, ids };
}
const byMarker = (ids, re) => ids.filter((id) => { const r = store.db.prepare('SELECT title, text FROM memory_entries WHERE id = ?').get(id); return re.test(r.title) || re.test(r.text); });

before(() => {
  dir = sandbox();
  store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  orch = callerFor('orchestrator');
});
after(() => { store.close(); cleanup(dir); });

test('a task about dates and the TZ zone surfaces the dates row first', async () => {
  const { name, ids } = await g2Store();
  const [dates] = byMarker(ids, /process\.env\.TZ/);
  const r = await call('memory.index', { namespaces: [name], query: 'Report entries since a given date. Day boundaries depend on the TZ zone that src/dates.cjs reads at load.' });
  assert.strictEqual(r.row_ids[0], dates, titleOf(r.row_ids[0]));
  assert.strictEqual(r.relevance.keyword, 'ran');
  assert.strictEqual(r.relevance.semantic, 'not_requested');
  assert.strictEqual(r.relevance.source, 'query');
  assert.ok(r.relevance.matched > 0 && r.relevance.terms.includes('src/dates.cjs'), JSON.stringify(r.relevance));
});

test('a task about CSV export surfaces the two money rows (format and cents) first', async () => {
  const { name, ids } = await g2Store();
  const [format] = byMarker(ids, /toFixed\(2\)/);
  const [cents] = byMarker(ids, /money\.parse/);
  const t = await call('task.create', { spec: 'Add tally export --csv: one line per entry, the amount printed as a decimal such as 12.50.' });
  const r = await call('memory.index', { namespaces: [name], task_id: t.id });
  assert.deepStrictEqual(new Set(r.row_ids.slice(0, 2)), new Set([format, cents]), r.row_ids.slice(0, 3).map(titleOf).join(' | '));
  assert.strictEqual(r.relevance.source, 'task.spec', 'the task spec is the text when no query is given');
  // A query adds to the spec: both are the text.
  const both = await call('memory.index', { namespaces: [name], task_id: t.id, query: 'toFixed' });
  assert.strictEqual(both.relevance.source, 'query+task.spec');
  assert.strictEqual(both.row_ids[0], format, titleOf(both.row_ids[0]));
});

test('with no overlap the order is the old one: verified, newest, id; matched 0', async () => {
  const { name } = await g2Store();
  const plain = await call('memory.index', { namespaces: [name], max_bytes: 4096 });
  assert.strictEqual(plain.relevance, undefined, 'no text and no vector: no relevance field, the result is as before');
  const none = await call('memory.index', { namespaces: [name], max_bytes: 4096, query: 'zebra quagga okapi giraffe' });
  assert.deepStrictEqual(none.row_ids, plain.row_ids);
  assert.strictEqual(none.text, plain.text);
  assert.strictEqual(none.relevance.matched, 0);
  assert.deepStrictEqual(none.relevance.terms, [], 'no term occurs in the store, so none is used');
  // Newest first is the old order: the last seed row was stored last.
  const created = plain.row_ids.map((id) => store.db.prepare('SELECT created_at FROM memory_entries WHERE id = ?').get(id).created_at);
  assert.deepStrictEqual(created, [...created].sort((a, b) => b - a));
});

test('rows with no relevance stay eligible, after the relevant ones', async () => {
  const { name, ids } = await g2Store();
  const r = await call('memory.index', { namespaces: [name], max_bytes: 4096, query: 'CRLF line endings in crlf.tally' });
  assert.strictEqual(r.row_ids.length, ids.length, 'every lasting row is still ranked');
  assert.strictEqual(r.row_ids[0], byMarker(ids, /crlf\.tally/)[0]);
  assert.ok(r.relevance.matched > 0 && r.relevance.matched < ids.length, `${r.relevance.matched} matched`);
});

test('the tiers stay first: a row under files_owned outranks a more relevant row', async () => {
  const name = fresh();
  const t = await call('task.create', { spec: 'fix the timezone handling of dates', files_owned: ['lib/owned'] });
  const owned = await call('memory.store', { namespace: name, text: 'an unrelated note about lib/owned', type: 'decision', body: { files_read: ['lib/owned/a.cjs'] }, embed: false, created_at: 1 });
  const relevant = await call('memory.store', { namespace: name, text: 'dates use the timezone read at load', type: 'decision', embed: false, created_at: 2 });
  const other = await call('memory.store', { namespace: name, text: 'nothing in common', type: 'decision', embed: false, created_at: 3 });
  const r = await call('memory.index', { namespaces: [name], task_id: t.id });
  assert.deepStrictEqual(r.row_ids, [owned.id, relevant.id, other.id]);
});

test('identical inputs give identical bytes, under two clocks', async () => {
  const { name } = await g2Store();
  const args = { namespaces: [name], query: 'Add a --since <date> option to tally report; YYYY-MM-DD days' };
  const realNow = Date.now;
  let a, b;
  try {
    Date.now = () => 1_700_000_000_000; a = await call('memory.index', args);
    Date.now = () => 1_900_000_000_000; b = await call('memory.index', args);
  } finally { Date.now = realNow; }
  assert.strictEqual(a.text, b.text);
  assert.strictEqual(a.sha256, b.sha256);
  assert.deepStrictEqual(a.relevance, b.relevance);
});

test('equal relevance breaks by the old keys, ending with the id', async () => {
  const name = fresh();
  const mk = async (text) => (await call('memory.store', { namespace: name, text, type: 'decision', embed: false, created_at: 7 })).id;
  const x = await mk('the parser splits fields on pipes');
  const y = await mk('the writer splits fields on pipes');
  const r = await call('memory.index', { namespaces: [name], query: 'splits fields on pipes' });
  assert.deepStrictEqual(r.row_ids, [x, y].sort());
});

test('reading writes nothing and never loads the embedder', async () => {
  const { name } = await g2Store();
  const snap = () => JSON.stringify([
    store.db.prepare('SELECT id, accessed_at, updated_at, created_at, status FROM memory_entries ORDER BY id').all(),
    store.db.prepare('SELECT COUNT(*) AS n FROM memory_event').get(),
  ]);
  const before0 = snap();
  const r = await call('memory.index', { namespaces: [name], query: 'dates and TZ' }, callerFor('worker', { worker_id: 'w1' }));
  assert.ok(r.row_ids.length > 0);
  assert.strictEqual(snap(), before0);
  const loaded = Object.keys(require.cache).filter((k) => /[\\/]src[\\/]core[\\/]embedder\.cjs$|@huggingface|onnxruntime/i.test(k));
  assert.deepStrictEqual(loaded, []);
});

test('a store without the keyword index names what did not run and keeps the old order', async () => {
  const d2 = sandbox();
  const s2 = new Store(path.join(d2, 'memory.db'), { stamp: true });
  const E2 = new Engine({ dataDir: d2, store: s2, getEmbedder: null, owner: null, establishedBy: 'test' });
  try {
    const c = (m, a) => E2.handle(m, { ...a, caller: orch });
    await c('memory.store', { namespace: 'n', text: 'dates use the TZ zone', type: 'decision', embed: false, created_at: 1 });
    await c('memory.store', { namespace: 'n', text: 'something newer', type: 'decision', embed: false, created_at: 2 });
    const plain = await c('memory.index', { namespaces: ['n'] });
    s2.db.prepare("DELETE FROM meta WHERE key = 'memory_fts_version'").run();
    const r = await c('memory.index', { namespaces: ['n'], query: 'dates and the TZ zone' });
    assert.strictEqual(r.relevance.keyword.code, 'E_NO_INDEX');
    assert.deepStrictEqual(r.row_ids, plain.row_ids);
  } finally { s2.close(); cleanup(d2); }
});

test('a supplied query embedding ranks by cosine; a model mismatch is named, never silent', async () => {
  const name = fresh();
  const put = async (text, embedding, at) => (await call('memory.store', { namespace: name, text, type: 'decision', embedding, embedding_model: 'm', dim: 3, created_at: at })).id;
  const near = await put('alpha note', [0, 1, 0], 1);
  const far = await put('beta note', [1, 0, 0], 2);
  const r = await call('memory.index', { namespaces: [name], query_embedding: [0.1, 0.9, 0], embedding_model: 'm' });
  assert.deepStrictEqual(r.row_ids, [near, far]);
  assert.strictEqual(r.relevance.semantic, 'ran');
  assert.strictEqual(r.relevance.keyword, 'not_requested');
  // Both signals: fused by reciprocal rank; the keyword lifts "beta" level with "alpha", and the tie breaks
  // by the old keys (newest first).
  const both = await call('memory.index', { namespaces: [name], query: 'beta', query_embedding: [0.1, 0.9, 0] });
  assert.strictEqual(both.relevance.semantic, 'ran');
  assert.strictEqual(both.relevance.keyword, 'ran');
  assert.deepStrictEqual(both.row_ids, [far, near]);
  const wrong = await call('memory.index', { namespaces: [name], query_embedding: [0, 1, 0], embedding_model: 'other' });
  assert.strictEqual(wrong.relevance.semantic.code, 'E_MODEL');
  const dim = await call('memory.index', { namespaces: [name], query_embedding: [0, 1] });
  assert.strictEqual(dim.relevance.semantic.code, 'E_MODEL');
  assert.deepStrictEqual(wrong.row_ids, [far, near], 'nothing compared: the old order');
});

test('arguments are checked', async () => {
  const bad = (args) => assert.rejects(call('memory.index', args), (e) => e.code === 'E_ARGS');
  await bad({ query: 7 });
  await bad({ query: '   ' });
  await bad({ query: 'x'.repeat(R.QUERY_MAX + 1) });
  await bad({ query_embedding: [] });
  await bad({ query_embedding: [1, 'a'] });
  await bad({ query_embedding: [1, Infinity] });
  await bad({ embedding_model: '' });
});

test('terms: function and framing words dropped, short plain words dropped, identifiers kept whole, plurals stemmed', () => {
  const t = R.termsOf('You are working in the repository. Add `tally export --csv` to src/cmd-export.cjs; the dates and amounts, run the tests. TZ day');
  assert.ok(t.includes('--csv') === false && t.includes('csv'), 'a flag is kept, without its dashes');
  assert.ok(t.includes('src/cmd-export.cjs'));
  assert.ok(t.includes('date') && t.includes('amount') && t.includes('test'), JSON.stringify(t));
  for (const gone of ['you', 'the', 'are', 'working', 'repository', 'run', 'day', 'tz']) assert.ok(!t.includes(gone), gone);
  assert.deepStrictEqual(R.termsOf(''), []);
  assert.ok(R.termsOf('word '.repeat(5) + Array.from({ length: 300 }, (_, i) => `term${i}`).join(' ')).length <= 128);
  assert.strictEqual(R.termsOf('dates dates dates zones')[0], 'date', 'the more often the text repeats a term, the earlier');
});

test('the OR expression quotes every term, and unit weights give the OR query its own bm25', async () => {
  assert.strictEqual(R.orMatch(['alpha', 'beta"x', 'NOT']), '"alpha" OR "beta" OR "NOT"', 'an operator is a quoted phrase; a quote splits a term');
  assert.strictEqual(R.orMatch([]), null);
  const { name, ids } = await g2Store();
  const db = store.db;
  const terms = R.selectTerms(db, R.termStats('dates zone ledger').map((s) => ({ ...s, count: 1 })), [name]);
  assert.ok(terms.length >= 2);
  for (let i = 1; i < terms.length; i++) assert.ok(terms[i - 1].rows.length <= terms[i].rows.length, 'rarest first');
  const summed = R.keywordScores(terms, new Set(ids));
  const or = db.prepare(`SELECT e.id AS id, bm25(memory_fts) AS bm FROM memory_fts JOIN memory_entries e ON e.rowid = memory_fts.rowid
    WHERE memory_fts MATCH ? AND e.namespace = ?`).all(R.orMatch(terms.map((x) => x.t)), name);
  assert.strictEqual(or.length, summed.size);
  for (const r of or) assert.ok(Math.abs(summed.get(r.id) + r.bm) < 1e-9, `${r.id}: ${summed.get(r.id)} vs ${-r.bm}`);
});
