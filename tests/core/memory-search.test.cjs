'use strict';
// memory-search.test.cjs — ADR 0040 §2: the three search modes, the index and full views, every filter key,
// the honesty contract, the near-duplicate veto, timeline, get_many and the rule that reading never writes.
// These run an Engine over a real stamped store with a fake embedder, so no model is loaded and no owner
// process is started.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Engine, METHODS } = core('engine.cjs');
const { Store } = core('store.cjs');
const { readTimeoutFor } = core('index.cjs');

const VEC = { alpha: [1, 0, 0], beta: [0, 1, 0], gamma: [0, 0, 1] };
const embedderFor = (table = VEC) => async () => ({
  embed: async text => ({ embedding: table[String(text).split(' ')[0]] || [1, 1, 1], embedding_model: 'm', dim: 3 }),
});

let dir, store, E, orch;
const call = (method, args, caller = orch) => E.handle(method, { ...args, caller });
const rejects = async (p, code) => assert.rejects(p, e => { assert.strictEqual(e.code, code, `${e.code}: ${e.message}`); return true; });
const put = (ns, text, vec, extra = {}) => call('memory.store', { namespace: ns, text, embedding: vec, embedding_model: 'm', dim: 3, ...extra }, extra.caller || orch);
const setCols = (id, cols) => {
  const keys = Object.keys(cols);
  store.db.prepare(`UPDATE memory_entries SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => cols[k]), id);
};
const ids = r => r.results.map(x => x.id);

const rows = {};
before(async () => {
  dir = sandbox();
  store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: embedderFor(), owner: null, establishedBy: 'test' });
  orch = callerFor('orchestrator');
  const w1 = callerFor('worker', { worker_id: 'w1' });
  // Namespace n1: the corpus most tests search.
  rows.pid = await put('n1', 'Retry policy for pidAlive checks raises E_OWNER_LOST on a wedged pipe', [1, 0, 0], { type: 'decision', created_at: 1000, worker_id: 'w1' });
  rows.lazy = await put('n1', 'The embedder loads lazily inside the owner process', [0, 1, 0], { type: 'fact', created_at: 2000 });
  rows.noOwner = await put('n1', 'E_NO_OWNER means no owner.lock exists in the data dir', [0.99, 0.1, 0], { type: 'fact', created_at: 3000 });
  rows.cold = await put('n1', 'Cold start costs a model load of several seconds', [0, 0, 1], { type: 'observation', created_at: 4000, worker_id: 'w1' });
  setCols(rows.pid.id, { status: 'verified', task_id: 'T1', run_id: 'run-a', title: 'Retry policy' });
  setCols(rows.lazy.id, { status: 'refuted', task_id: 'T2', run_id: 'run-a' });
  setCols(rows.cold.id, { tags: JSON.stringify(['T9', 'misc']) });
  // Namespace n2: a second corpus for multi-namespace search.
  rows.n2 = await put('n2', 'The pipe name derives from the data directory hash', [0.5, 0.5, 0], { type: 'fact', created_at: 5000 });
});
after(() => { store.close(); cleanup(dir); });

test('the default mode is hybrid with a query string and semantic with only a vector', async () => {
  const h = await call('memory.search', { namespace: 'n1', query: 'alpha', k: 3 });
  assert.deepStrictEqual(h.modes_run, ['semantic', 'keyword']);
  assert.deepStrictEqual(h.fusion, { method: 'rrf', alpha: 0.3, k: 10 });
  const v = await call('memory.search', { namespace: 'n1', query_embedding: [1, 0, 0], embedding_model: 'm', k: 3 });
  assert.deepStrictEqual(v.modes_run, ['semantic'], 'no query string, so no keyword half');
  assert.strictEqual(v.fusion, null);
  assert.strictEqual(v.results[0].id, rows.pid.id);
});

test('semantic mode returns today\'s rows plus the additive fields', async () => {
  const r = await call('memory.search', { namespace: 'n1', query: 'alpha', k: 3, mode: 'semantic' });
  assert.strictEqual(r.results[0].id, rows.pid.id);
  assert.ok(r.results[0].score > 0.99);
  assert.strictEqual(r.results[0].has_embedding, true);
  assert.strictEqual(r.results[0].embedding, undefined, 'a read never returns the vector');
  assert.strictEqual(r.results[0].status, 'verified');
  assert.strictEqual(r.results[0].title, 'Retry policy');
  assert.strictEqual(r.results[0].task_id, 'T1');
  assert.deepStrictEqual(r.modes_run, ['semantic']);
  assert.deepStrictEqual(r.modes_failed, []);
  assert.strictEqual(r.model, 'm');
  assert.strictEqual(r.dim, 3);
  assert.strictEqual(r.fusion, null);
  assert.deepStrictEqual(r.searched.namespaces, ['n1']);
  assert.strictEqual(r.searched.rows_considered, 4);
  assert.strictEqual(r.searched.fts, true);
});

test('keyword mode finds identifiers and substrings with no embedder and no vector', async () => {
  const noEmbed = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  const r = await noEmbed.handle('memory.search', { caller: orch, namespace: 'n1', query: 'pidAlive', mode: 'keyword' });
  assert.deepStrictEqual(ids(r), [rows.pid.id]);
  assert.deepStrictEqual(r.modes_run, ['keyword']);
  const sub = await noEmbed.handle('memory.search', { caller: orch, namespace: 'n1', query: 'NO_OWN', mode: 'keyword' });
  assert.deepStrictEqual(ids(sub), [rows.noOwner.id], 'a substring matches (trigram)');
  assert.strictEqual(sub.results[0].status, 'unverified', 'a null status reads as unverified');
  assert.ok(sub.results[0].score > 0, 'a keyword score is higher-is-better');
  assert.strictEqual(sub.results[0].near_duplicate, undefined, 'a keyword hit has no cosine to call a duplicate');
  assert.strictEqual(sub.scanned, 0);
  assert.strictEqual(sub.model, null);
});

test('hybrid fuses both lists and reports the fusion it used', async () => {
  const r = await call('memory.search', { namespace: 'n1', query: 'alpha pidAlive', mode: 'hybrid', k: 10 });
  // "alpha pidAlive" matches no row as a whole by keyword (both terms are required), so the keyword list is
  // empty and the semantic list leads; a one-term query makes the two lists meet.
  assert.deepStrictEqual(r.modes_run, ['semantic', 'keyword']);
  assert.deepStrictEqual(r.fusion, { method: 'rrf', alpha: 0.3, k: 10 });
  const q = await call('memory.search', { namespace: 'n1', query: 'alpha', mode: 'hybrid', k: 10 });
  assert.strictEqual(q.results[0].id, rows.pid.id, 'semantic rank 1 leads when keyword finds nothing');
  const one = await call('memory.search', { namespace: 'n1', query: 'pidAlive', mode: 'hybrid', k: 10 });
  assert.strictEqual(one.results[0].id, rows.pid.id, 'in both lists, so it outranks every semantic-only hit');
  assert.deepStrictEqual(one.results[0].ranks.keyword, 1);
  assert.ok(one.results[0].ranks.semantic >= 1);
  assert.ok(one.results[0].score > one.results[1].score);
});

test('alpha steers the fusion: 1 follows the semantic list, 0 the keyword list', async () => {
  // Query embedded as [0,0,1] (gamma): semantic best is cold. Keyword term "owner" matches lazy, noOwner and pid.
  const sem = await call('memory.search', { namespace: 'n1', query: 'gamma owner', mode: 'hybrid', alpha: 1, k: 10 });
  assert.strictEqual(sem.results[0].id, rows.cold.id);
  const kwOnly = await call('memory.search', { namespace: 'n1', query: 'owner', mode: 'hybrid', alpha: 0, k: 10 });
  assert.deepStrictEqual(ids(kwOnly).slice(0, 3).sort(), [rows.lazy.id, rows.noOwner.id, rows.pid.id].sort());
  await rejects(call('memory.search', { namespace: 'n1', query: 'owner', mode: 'hybrid', alpha: 2 }), 'E_ARGS');
});

test('the index view returns ids and titles only, with the fixed key set', async () => {
  const r = await call('memory.search', { namespace: 'n1', query: 'alpha', view: 'index', k: 2 });
  const h = r.results[0];
  // ADR 0057: a search's index row also carries its relevance (and low_relevance when below the floor).
  assert.deepStrictEqual(Object.keys(h).filter(k => k !== 'low_relevance').sort(), ['created_at', 'id', 'namespace', 'relevance', 'score', 'status', 'task_id', 'title', 'type', 'worker_id', 'written_by']);
  assert.strictEqual(h.title, 'Retry policy');
  assert.strictEqual(r.results[1].title.length > 0, true, 'a null title is derived from the first line');
  assert.strictEqual(h.text, undefined);
  assert.strictEqual(h.tags, undefined);
  const full = await call('memory.search', { namespace: 'n1', query: 'alpha', view: 'full', k: 1 });
  assert.ok(full.results[0].text.includes('pidAlive'));
  await rejects(call('memory.search', { namespace: 'n1', query: 'alpha', view: 'wide' }), 'E_ARGS');
});

test('every filter key narrows semantic and keyword alike', async () => {
  const both = async (filter, want, q = 'owner') => {
    const kw = await call('memory.search', { namespace: 'n1', query: q, mode: 'keyword', filter, k: 20 });
    assert.deepStrictEqual(ids(kw).sort(), want.slice().sort(), `keyword ${JSON.stringify(filter)}`);
    const sem = await call('memory.search', { namespace: 'n1', query: 'alpha', filter, k: 20 });
    assert.deepStrictEqual(ids(sem).sort(), (await allIds(filter)).sort(), `semantic ${JSON.stringify(filter)}`);
  };
  const allIds = async filter => (await call('memory.list', { namespace: 'n1', filter, limit: 50 })).rows.map(r => r.id);
  await both({ types: ['decision'] }, [rows.pid.id]);
  await both({ statuses: ['refuted'] }, [rows.lazy.id]);
  await both({ statuses: ['unverified'] }, [rows.noOwner.id], 'owner');
  await both({ worker_id: 'w1' }, [rows.pid.id]);
  await both({ task_id: 'T2' }, [rows.lazy.id]);
  await both({ run_id: 'run-a' }, [rows.pid.id, rows.lazy.id]);
  await both({ since_ms: 2000, until_ms: 3000 }, [rows.lazy.id, rows.noOwner.id]);
  const tagged = await call('memory.search', { namespace: 'n1', query: 'alpha', filter: { task_id: 'T9' } });
  assert.deepStrictEqual(ids(tagged), [rows.cold.id], 'task_id matches the tag for a row written before the column');
  await rejects(call('memory.search', { namespace: 'n1', query: 'owner', mode: 'keyword', filter: { colour: 'red' } }), 'E_ARGS');
  await rejects(call('memory.search', { namespace: 'n1', query: 'alpha', filter: { statuses: ['maybe'] } }), 'E_ARGS');
});

test('multi-namespace search covers every namespace named and no other', async () => {
  const r = await call('memory.search', { namespaces: ['n1', 'n2'], query: 'data', mode: 'keyword' });
  assert.deepStrictEqual(ids(r).sort(), [rows.noOwner.id, rows.n2.id].sort());
  assert.deepStrictEqual(r.searched.namespaces, ['n1', 'n2']);
  assert.strictEqual(r.searched.rows_considered, 5);
  const one = await call('memory.search', { namespaces: ['n2'], query: 'data', mode: 'keyword' });
  assert.deepStrictEqual(ids(one), [rows.n2.id]);
  const sem = await call('memory.search', { namespaces: ['n1', 'n2'], query: 'beta', k: 5 });
  assert.strictEqual(sem.results.length, 5, 'the semantic scan spans both namespaces');
  await rejects(call('memory.search', { namespaces: [], query: 'x' }), 'E_ARGS');
  await rejects(call('memory.search', { namespaces: Array.from({ length: 11 }, (_, i) => `n${i}`), query: 'x' }), 'E_ARGS');
  await rejects(call('memory.search', { namespace: 'n1', namespaces: ['n2'], query: 'x' }), 'E_ARGS');
});

test('absence_established is true only after both modes ran over the stated scope and nothing reached the floor', async () => {
  const none = await call('memory.search', { namespace: 'n1', query: 'zzzqqq', mode: 'hybrid', filter: { types: ['nothing'] } });
  assert.strictEqual(none.absence_established, true);
  assert.strictEqual(none.warning, null);
  assert.deepStrictEqual(none.modes_run, ['semantic', 'keyword']);
  for (const mode of ['semantic', 'keyword']) {
    const r = await call('memory.search', { namespace: 'n1', query: 'zzzqqq', mode, filter: { types: ['nothing'] } });
    assert.strictEqual(r.absence_established, false, `${mode} alone never establishes absence`);
    assert.ok(r.warning && r.warning.includes('does not mean no such entry'));
  }
  const found = await call('memory.search', { namespace: 'n1', query: 'pidAlive', mode: 'hybrid' });
  assert.strictEqual(found.absence_established, false, 'a non-empty result is not absence');
  // ADR 0057 decision 4: the claim is about every scanned row, so an offset page of an empty scope still establishes it.
  const paged = await call('memory.search', { namespace: 'n1', query: 'zzzqqq', mode: 'hybrid', filter: { types: ['nothing'] }, offset: 3 });
  assert.strictEqual(paged.absence_established, true, 'an offset narrows the page, not the claim');
  const floor = await call('memory.search', { namespace: 'n1', query: 'alpha', mode: 'hybrid', min_score: 0.999, filter: { types: ['fact'] } });
  assert.strictEqual(floor.results.length, 0);
  assert.strictEqual(floor.absence_established, false, 'a score floor narrows the search');
  assert.ok(floor.warning);
});

test('warning is the first key of the result, and names what did not run', async () => {
  const noEmbed = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  const r = await noEmbed.handle('memory.search', { caller: orch, namespace: 'n1', query: 'pidAlive', mode: 'hybrid' });
  assert.strictEqual(Object.keys(r)[0], 'warning');
  assert.strictEqual(r.warning, 'semantic search did not run (E_NO_EMBEDDER); these are keyword matches only; no match here does not mean no such entry');
  const ok = await call('memory.search', { namespace: 'n1', query: 'pidAlive', mode: 'hybrid' });
  assert.strictEqual(Object.keys(ok)[0], 'warning');
  assert.strictEqual(ok.warning, null);
  const empty = await call('memory.search', { namespace: 'n1', query: 'zzzqqq', mode: 'keyword' });
  assert.strictEqual(empty.warning, 'keyword search only; semantic search did not run; no match here does not mean no such entry');
});

test('hybrid with no embedder gives keyword results plus modes_failed; semantic still rejects', async () => {
  const noEmbed = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  const r = await noEmbed.handle('memory.search', { caller: orch, namespace: 'n1', query: 'pidAlive', mode: 'hybrid' });
  assert.deepStrictEqual(ids(r), [rows.pid.id]);
  assert.deepStrictEqual(r.modes_run, ['keyword']);
  assert.strictEqual(r.modes_failed.length, 1);
  assert.strictEqual(r.modes_failed[0].mode, 'semantic');
  assert.strictEqual(r.modes_failed[0].code, 'E_NO_EMBEDDER');
  assert.strictEqual(r.absence_established, false);
  assert.strictEqual(r.fusion, null);
  const d = await noEmbed.handle('memory.search', { caller: orch, namespace: 'n1', query: 'pidAlive' });
  assert.deepStrictEqual(d.modes_run, ['keyword'], 'the default mode is hybrid, so it answers from its keyword half');
  assert.strictEqual(d.modes_failed[0].code, 'E_NO_EMBEDDER');
  await assert.rejects(noEmbed.handle('memory.search', { caller: orch, namespace: 'n1', query: 'pidAlive', mode: 'semantic' }), e => e.code === 'E_NO_EMBEDDER');
});

test('a copy read that fell back from a wedged owner reports that cause as the failed semantic mode', async () => {
  const fell = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'copy', embedderFailure: { code: 'E_OWNER_LOST', message: 'the owner did not answer its ping' } });
  const r = await fell.handle('memory.search', { caller: orch, namespace: 'n1', query: 'pidAlive', mode: 'hybrid' });
  assert.deepStrictEqual(ids(r), [rows.pid.id]);
  assert.strictEqual(r.modes_failed[0].code, 'E_OWNER_LOST');
  assert.ok(r.modes_failed[0].message.includes('did not answer'));
  assert.ok(r.warning.startsWith('semantic search did not run (E_OWNER_LOST)'));
});

test('a query with no term of three characters is E_QUERY_SHORT by name, never an empty match', async () => {
  const k = await call('memory.search', { namespace: 'n1', query: 'ab', mode: 'keyword' });
  assert.deepStrictEqual(k.results, []);
  assert.deepStrictEqual(k.modes_run, []);
  assert.strictEqual(k.modes_failed[0].code, 'E_QUERY_SHORT');
  assert.strictEqual(k.absence_established, false);
  assert.ok(k.warning.includes('nothing was searched'));
  const h = await call('memory.search', { namespace: 'n1', query: 'ab', mode: 'hybrid' });
  assert.deepStrictEqual(h.modes_run, ['semantic']);
  assert.strictEqual(h.modes_failed[0].mode, 'keyword');
  assert.strictEqual(h.modes_failed[0].code, 'E_QUERY_SHORT');
  assert.strictEqual(h.absence_established, false);
  const mixed = await call('memory.search', { namespace: 'n1', query: 'ab pidAlive', mode: 'keyword' });
  assert.deepStrictEqual(ids(mixed), [rows.pid.id]);
  assert.deepStrictEqual(mixed.searched.keyword_terms_dropped, [{ term: 'ab', reason: 'too-short' }], 'a dropped short term is named');
});

test('FTS syntax characters in a query are searched as text and cannot inject', async () => {
  for (const q of ['"pidAlive', 'pidAlive*', 'title:pidAlive', 'NOT pidAlive', '(pidAlive', '^pidAlive -foo', 'pid" OR "x', "it's"]) {
    const r = await call('memory.search', { namespace: 'n1', query: q, mode: 'keyword' });
    assert.ok(Array.isArray(r.results), q);
    assert.ok(!r.modes_failed.some(f => f.code === 'E_INTERNAL'), q);
  }
});

test('a keyword search needs query text, and a store without the index says so', async () => {
  await rejects(call('memory.search', { namespace: 'n1', query_embedding: [1, 0, 0], mode: 'keyword' }), 'E_ARGS');
  await rejects(call('memory.search', { namespace: 'n1' }), 'E_ARGS');
  await rejects(call('memory.search', { namespace: 'n1', query: 'x', mode: 'fuzzy' }), 'E_ARGS');
  const bare = sandbox();
  const s = new Store(path.join(bare, 'memory.db')); // no stamp: a copy's shape, no keyword index
  try {
    s.db.prepare("INSERT INTO memory_entries(id, namespace, worker_id, type, text, text_hash, created_at, updated_at) VALUES ('x', 'n', 'w', 'fact', 'findable pidAlive text', 'h', 1, 1)").run();
    const e = new Engine({ dataDir: bare, store: s, getEmbedder: null, owner: null, establishedBy: 'copy' });
    const r = await e.handle('memory.search', { caller: orch, namespace: 'n', query: 'pidAlive', mode: 'keyword' });
    assert.deepStrictEqual(r.results, []);
    assert.strictEqual(r.modes_failed[0].code, 'E_NO_INDEX');
    assert.strictEqual(r.absence_established, false);
    assert.strictEqual(r.searched.fts, false);
    assert.ok(r.warning.includes('E_NO_INDEX'));
    const hy = await e.handle('memory.search', { caller: orch, namespace: 'n', query: 'pidAlive', mode: 'hybrid', query_embedding: [1, 0, 0] });
    // ADR 0057 decision 5: the one in-scope row has no vector, so the semantic half saw nothing and is degraded, not run.
    assert.deepStrictEqual(hy.modes_failed.map(f => f.code).sort(), ['E_NO_INDEX', 'E_NO_VECTORS']);
    assert.deepStrictEqual(hy.modes_run, []);
    assert.strictEqual(hy.absence_established, false);
  } finally { s.close(); cleanup(bare); }
});

test('the near-duplicate flag is vetoed when the rare tokens differ', async () => {
  // noOwner is cosine 0.995 to [1,0,0]: near by cosine. Its rare tokens (E_NO_OWNER, owner.lock) differ from the query's.
  const r = await call('memory.search', { namespace: 'n1', query: 'alpha E_OWNER_LOST pidAlive', k: 3, dup_threshold: 0.95 });
  const byId = Object.fromEntries(r.results.map(h => [h.id, h]));
  assert.strictEqual(byId[rows.noOwner.id].near_duplicate, false);
  assert.ok(byId[rows.noOwner.id].near_duplicate_veto.only_in_row.includes('E_NO_OWNER'));
  assert.ok(byId[rows.noOwner.id].near_duplicate_veto.only_in_query.includes('E_OWNER_LOST'));
  // The same text as the row itself has the same rare tokens: still a duplicate.
  const same = await call('memory.search', { namespace: 'n1', query: 'Retry policy for pidAlive checks raises E_OWNER_LOST on a wedged pipe', query_embedding: [1, 0, 0], k: 1 });
  assert.strictEqual(same.results[0].near_duplicate, true);
  assert.strictEqual(same.results[0].near_duplicate_veto, undefined);
  const noText = await call('memory.search', { namespace: 'n1', query_embedding: [1, 0, 0], k: 3 });
  assert.strictEqual(noText.results.find(h => h.id === rows.noOwner.id).near_duplicate, true, 'with no query text there is nothing to veto against');
});

test('order and offset page through the matches; expired and superseded rows are not matched', async () => {
  const newest = await call('memory.search', { namespace: 'n1', query: 'owner', mode: 'keyword', order: 'newest' });
  assert.deepStrictEqual(ids(newest), [rows.noOwner.id, rows.lazy.id, rows.pid.id]);
  const oldest = await call('memory.search', { namespace: 'n1', query: 'owner', mode: 'keyword', order: 'oldest', k: 2, offset: 1 });
  assert.deepStrictEqual(ids(oldest), [rows.lazy.id, rows.noOwner.id]);
  const page2 = await call('memory.search', { namespace: 'n1', query: 'alpha', k: 2, offset: 2 });
  const page1 = await call('memory.search', { namespace: 'n1', query: 'alpha', k: 2 });
  assert.strictEqual(page1.results.length + page2.results.length, 4);
  assert.strictEqual(new Set([...ids(page1), ...ids(page2)]).size, 4, 'pages do not overlap');
  await rejects(call('memory.search', { namespace: 'n1', query: 'alpha', offset: 1001 }), 'E_ARGS');

  const gone = await put('life', 'transient sentinelword stays here', [1, 0, 0]);
  const newer = await put('life', 'replacement for the sentinelword row', [1, 0, 0], { supersedes: gone.id });
  const k = await call('memory.search', { namespace: 'life', query: 'sentinelword', mode: 'keyword' });
  assert.deepStrictEqual(ids(k), [newer.id], 'a superseded row is not matched');
  const incl = await call('memory.search', { namespace: 'life', query: 'sentinelword', mode: 'keyword', include_superseded: true });
  assert.strictEqual(incl.results.length, 2);
  setCols(newer.id, { ttl_at: Date.now() - 10 });
  const exp = await call('memory.search', { namespace: 'life', query: 'sentinelword', mode: 'keyword', include_superseded: true });
  assert.deepStrictEqual(ids(exp), [gone.id], 'an expired row is not matched');
});

test('timeline returns neighbours in created_at, id order within the scope', async () => {
  const mk = (text, at, cols) => put('tl', text, [1, 0, 0], { created_at: at }).then(r => { if (cols) setCols(r.id, cols); return r; });
  const a = await mk('step one of the plan', 100, { task_id: 'TT', worker_id: 'wa', run_id: 'rr' });
  const b = await mk('step two of the plan', 200, { task_id: 'TT', worker_id: 'wb', run_id: 'rr' });
  const c = await mk('step three of the plan', 300, { task_id: 'TT', worker_id: 'wa', run_id: 'rr' });
  const d = await mk('unrelated note about caching', 350, { task_id: 'UU', worker_id: 'wa', run_id: 'rr' });
  const e = await mk('step four of the plan', 400, { task_id: 'TT', worker_id: 'wa', run_id: 'rr' });
  const f = await mk('no provenance row', 450);
  const byTask = await call('memory.timeline', { anchor_id: c.id, before: 5, after: 5 });
  assert.strictEqual(byTask.scope, 'task');
  assert.strictEqual(byTask.scope_key, 'TT');
  assert.deepStrictEqual(byTask.before.map(r => r.id), [a.id, b.id]);
  assert.deepStrictEqual(byTask.after.map(r => r.id), [e.id]);
  assert.strictEqual(byTask.anchor.id, c.id);
  assert.strictEqual(byTask.anchor.text, undefined, 'the default view is the index');
  const worker = await call('memory.timeline', { anchor_id: c.id, scope: 'worker', before: 1, after: 1 });
  assert.deepStrictEqual([worker.before.map(r => r.id), worker.after.map(r => r.id)], [[a.id], [d.id]]);
  const run = await call('memory.timeline', { anchor_id: b.id, scope: 'run', before: 0, after: 2, view: 'full' });
  assert.deepStrictEqual(run.before, []);
  assert.deepStrictEqual(run.after.map(r => r.id), [c.id, d.id]);
  assert.ok(run.after[0].text.startsWith('step three'));
  const ns = await call('memory.timeline', { anchor_id: f.id, before: 2, after: 2 });
  assert.strictEqual(ns.scope, 'namespace', 'no task on the anchor defaults to the namespace');
  assert.strictEqual(ns.scope_key, 'tl');
  assert.deepStrictEqual(ns.before.map(r => r.id), [d.id, e.id]);
  await rejects(call('memory.timeline', { anchor_id: f.id, scope: 'task' }), 'E_ARGS');
  await rejects(call('memory.timeline', { anchor_id: 'ghost' }), 'E_NOT_FOUND');
  await rejects(call('memory.timeline', { anchor_id: a.id, before: 51 }), 'E_ARGS');
  await rejects(call('memory.timeline', { anchor_id: a.id, scope: 'galaxy' }), 'E_ARGS');
  await rejects(call('memory.timeline', {}), 'E_ARGS');
});

test('get_many keeps the order asked and lists the missing ids; get accepts ids', async () => {
  const want = [rows.cold.id, 'ghost', rows.pid.id, rows.cold.id];
  const r = await call('memory.get_many', { ids: want });
  assert.deepStrictEqual(r.rows.map(x => x.id), want);
  assert.deepStrictEqual(r.rows.map(x => x.found), [true, false, true, true]);
  assert.strictEqual(r.found, 3);
  assert.deepStrictEqual(r.missing, ['ghost']);
  assert.ok(r.rows[0].text.includes('Cold start'));
  assert.strictEqual(r.rows[0].embedding, undefined);
  const idx = await call('memory.get_many', { ids: [rows.pid.id], view: 'index' });
  assert.strictEqual(idx.rows[0].text, undefined);
  assert.strictEqual(idx.rows[0].title, 'Retry policy');
  const g = await call('memory.get', { ids: [rows.pid.id, 'nope'] });
  assert.deepStrictEqual(g.missing, ['nope']);
  assert.strictEqual(g.rows.length, 2);
  const one = await call('memory.get', { id: rows.pid.id });
  assert.strictEqual(one.found, true);
  assert.strictEqual(one.status, 'verified');
  assert.deepStrictEqual(await call('memory.get', { id: 'nope' }), { id: 'nope', found: false });
  await rejects(call('memory.get_many', { ids: [] }), 'E_ARGS');
  await rejects(call('memory.get_many', { ids: Array.from({ length: 51 }, (_, i) => `i${i}`) }), 'E_ARGS');
  await rejects(call('memory.get_many', { ids: [7] }), 'E_ARGS');
  await rejects(call('memory.get', {}), 'E_ARGS');
});

test('list filters, pages, orders and takes a view', async () => {
  const all = await call('memory.list', { namespace: 'n1' });
  assert.strictEqual(all.total, 4);
  assert.deepStrictEqual(all.rows.map(r => r.id), [rows.cold.id, rows.noOwner.id, rows.lazy.id, rows.pid.id], 'newest first by default');
  assert.strictEqual(all.rows[3].title, 'Retry policy');
  assert.strictEqual(all.rows[1].status, 'unverified');
  assert.ok(all.rows[0].title.length > 0);
  const oldest = await call('memory.list', { namespace: 'n1', order: 'oldest', limit: 2, offset: 1 });
  assert.deepStrictEqual(oldest.rows.map(r => r.id), [rows.lazy.id, rows.noOwner.id]);
  assert.strictEqual(oldest.total, 4);
  const filt = await call('memory.list', { namespaces: ['n1', 'n2'], filter: { types: ['fact'] }, view: 'index' });
  assert.deepStrictEqual(filt.rows.map(r => r.id).sort(), [rows.lazy.id, rows.noOwner.id, rows.n2.id].sort());
  assert.strictEqual(filt.rows[0].text, undefined);
  assert.strictEqual(filt.rows[0].score, null);
  await rejects(call('memory.list', { namespace: 'n1', order: 'score' }), 'E_ARGS');
  await rejects(call('memory.list', { namespace: 'n1', filter: { nope: 1 } }), 'E_ARGS');
});

test('no read here stamps accessed_at or changes a row', async () => {
  const snap = () => JSON.stringify(store.db.prepare('SELECT id, accessed_at, updated_at, status, title FROM memory_entries ORDER BY id').all());
  const before = snap();
  const some = (await call('memory.list', { namespace: 'n1' })).rows.map(r => r.id);
  await call('memory.search', { namespace: 'n1', query: 'alpha' });
  await call('memory.search', { namespace: 'n1', query: 'owner', mode: 'hybrid', view: 'index' });
  await call('memory.get', { id: some[0] });
  await call('memory.get_many', { ids: some });
  await call('memory.timeline', { anchor_id: some[0] });
  assert.strictEqual(snap(), before);
  assert.ok(store.db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE accessed_at IS NOT NULL').get().n === 0);
});

test('an embedder failure reaches the run hook from a semantic or hybrid search, never from a keyword one', async () => {
  const calls = [];
  const owner = { opts: { onEmbedderFailure: x => calls.push(x.call) }, noteWrite() {}, pipe: 'p' };
  const boom = Object.assign(new Error('embedder is down'), { code: 'E_MODEL_ABSENT' });
  const e = new Engine({ dataDir: dir, store, getEmbedder: async () => { throw boom; }, owner, establishedBy: 'test' });
  await e.handle('memory.search', { caller: orch, namespace: 'n1', query: 'pidAlive', mode: 'keyword' });
  assert.deepStrictEqual(calls, [], 'keyword never calls the hook');
  const h = await e.handle('memory.search', { caller: orch, namespace: 'n1', query: 'pidAlive', mode: 'hybrid' });
  assert.strictEqual(h.modes_failed[0].code, 'E_MODEL_ABSENT');
  assert.deepStrictEqual(calls, ['memory.search']);
  await assert.rejects(e.handle('memory.search', { caller: orch, namespace: 'n1', query: 'pidAlive', mode: 'semantic' }), x => x === boom);
  assert.strictEqual(calls.length, 2);
});

test('the engine registers every memory method with its role and kind', () => {
  const read = ['memory.search', 'memory.get', 'memory.list', 'memory.timeline', 'memory.get_many', 'memory.events', 'usage.list'];
  for (const m of read) { assert.ok(METHODS[m], m); assert.strictEqual(METHODS[m].kind, 'read', m); assert.deepStrictEqual([...METHODS[m].roles].sort(), ['operator', 'orchestrator', 'worker'], m); }
  for (const m of ['memory.setStatus', 'memory.recordEvent', 'usage.record']) {
    assert.strictEqual(METHODS[m].kind, 'write', m);
    assert.deepStrictEqual(METHODS[m].roles, ['orchestrator', 'operator'], m);
  }
});

test('routing: keyword and supplied-vector reads take the 300 ms bound; vector reads wait on the owner', () => {
  assert.strictEqual(readTimeoutFor('memory.search', { mode: 'keyword', query: 'x' }), 300);
  assert.strictEqual(readTimeoutFor('memory.search', { query: 'x', query_embedding: [1] }), 300);
  assert.strictEqual(readTimeoutFor('memory.search', { query: 'x', mode: 'hybrid', query_embedding_b64: 'AAAA' }), 300);
  assert.ok(readTimeoutFor('memory.search', { query: 'x' }) > 5000);
  assert.ok(readTimeoutFor('memory.search', { query: 'x', mode: 'semantic' }) > 5000);
  assert.ok(readTimeoutFor('memory.search', { query: 'x', mode: 'hybrid' }) > 5000);
  assert.strictEqual(readTimeoutFor('memory.timeline', { anchor_id: 'x' }), 300);
  assert.strictEqual(readTimeoutFor('memory.get_many', { ids: ['x'] }), 300);
});
