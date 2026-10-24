'use strict';
// memory-search-view.test.cjs — ADR 0057: the compact search row, the debug view, one relevance score across modes with its floor,
// and memory.list's truncation markers (C11). An Engine over a real stamped store with a fake embedder: no model, no owner.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const { RELEVANCE_FLOOR } = core('memory-search-view.cjs');

const VEC = { alpha: [1, 0, 0], beta: [0, 1, 0] };
const embedderFor = () => async () => ({ embed: async text => ({ embedding: VEC[String(text).split(' ')[0]] || [0, 0, 1], embedding_model: 'm', dim: 3 }) });

let dir, store, E, orch;
const call = (method, args) => E.handle(method, { ...args, caller: orch });
const rows = {};
before(async () => {
  dir = sandbox();
  store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: embedderFor(), owner: null, establishedBy: 'test' });
  orch = callerFor('orchestrator');
  const put = (text, vec, extra = {}) => call('memory.store', { namespace: 'n', text, embedding: vec, embedding_model: 'm', dim: 3, ...extra });
  rows.fact = await put('Retry the ping twice before reporting the owner lost', [1, 0, 0], { type: 'fact', created_at: 1000 });
  rows.far = await put('Ferries depart at noon from pier four, a keywordonly marker', [0, 1, 0], { type: 'fact', created_at: 2000 });
  const body = {
    kind: 'gotcha', basis: 'observed', when: 'add a migration', evidence: [{ where: 'src/a.cjs', saw: 'one' }, { where: 'evaluate:T1@3', saw: 'passed' }],
    evidence_checked: [{ index: 1, ok: true, by: 'evaluate', passed: true }], applies_to: ['src/a.cjs'], subjects: ['schema'],
    held: { row: 'h1', kind: 'wrong', reason: 'x'.repeat(400) }, reported_wrong: [{ id: 'r' }, { id: 's' }], seen_in: [], model: 'm',
  };
  rows.note = store.store({ namespace: 'n', worker_id: 'w1', type: 'note', text: 'Migrations need a version bump\nWhen: add a migration', title: 'Migrations need a version bump',
    body, embedding: [0.8, 0.6, 0], embedding_model: 'm', dim: 3, created_at: 3000 });
  for (let i = 0; i < 5; i++) store.store({ namespace: 'big', worker_id: 'w1', text: `${'long text '.repeat(30)} ${i}`, created_at: 10 + i });
});
after(() => { store.close(); cleanup(dir); });

test('compact: a plain row is id, type, title, status, relevance, created_at and text, nothing else', async () => {
  const r = await call('memory.search', { namespace: 'n', query: 'alpha', view: 'compact', k: 5 });
  const fact = r.results.find(x => x.id === rows.fact.id);
  assert.deepStrictEqual(Object.keys(fact).sort(), ['created_at', 'id', 'relevance', 'status', 'text', 'title', 'type']);
  assert.strictEqual(fact.relevance, 1);
  assert.deepStrictEqual(r.relevance, { by: 'cosine', model: 'm', floor: RELEVANCE_FLOOR });
  for (const k of ['scanned', 'model', 'dim', 'searched', 'fusion', 'score_kind']) assert.strictEqual(r[k], undefined, `${k} is debug only`);
  assert.deepStrictEqual(Object.keys(r).slice(0, 2), ['warning', 'results']);
  assert.deepStrictEqual(r.modes_run, ['semantic', 'keyword']);
});

test('compact: a note shows kind, when, basis, evidence with its checked entry, applies_to, held and reported, not its text', async () => {
  const r = await call('memory.search', { namespace: 'n', query: 'alpha', view: 'compact', k: 5 });
  const n = r.results.find(x => x.id === rows.note.id);
  assert.strictEqual(n.type, 'note', 'type stays, so the data notice still sees a note');
  assert.strictEqual(n.text, undefined);
  assert.strictEqual(n.kind, 'gotcha');
  assert.strictEqual(n.when, 'add a migration');
  assert.strictEqual(n.basis, 'observed');
  assert.deepStrictEqual(n.evidence, [{ where: 'src/a.cjs', saw: 'one' }, { where: 'evaluate:T1@3', saw: 'passed', checked: true, passed: true }]);
  assert.deepStrictEqual(n.applies_to, ['src/a.cjs']);
  assert.strictEqual(n.held.kind, 'wrong');
  assert.strictEqual(Buffer.byteLength(n.held.reason), 160);
  assert.strictEqual(n.reported, 2);
  assert.strictEqual(n.relevance, 0.8);
  for (const k of ['text_hash', 'embedding_model', 'dim', 'text_template', 'body', 'ranks', 'cosine', 'near_duplicate']) assert.strictEqual(n[k], undefined, k);
});

test('debug is the full row of before, plus the relevance and the score label', async () => {
  const d = await call('memory.search', { namespace: 'n', query: 'alpha', view: 'debug', k: 5 });
  const f = await call('memory.search', { namespace: 'n', query: 'alpha', view: 'full', k: 5 });
  assert.deepStrictEqual(d, f, 'full is debug\'s old name');
  const n = d.results.find(x => x.id === rows.note.id);
  assert.ok(n.body && n.text_hash && n.ranks, 'every field of the full row');
  assert.strictEqual(d.score_kind, 'rrf');
  assert.ok(d.searched && d.fusion);
});

test('one relevance across modes: a keyword-only hit of a hybrid search has its cosine; keyword mode says it has none', async () => {
  const h = await call('memory.search', { namespace: 'n', query: 'alpha keywordonly', view: 'compact', k: 5, min_score: 0.5 });
  const far = h.results.find(x => x.id === rows.far.id);
  assert.ok(far, 'the keyword half found it though the semantic half cut it at min_score');
  assert.strictEqual(far.relevance, 0, 'its cosine, from the same scan');
  assert.strictEqual(far.low_relevance, true);
  assert.strictEqual(h.below_floor, 1);
  const s = await call('memory.search', { namespace: 'n', query: 'alpha', mode: 'semantic', view: 'compact', k: 5 });
  assert.strictEqual(s.results.find(x => x.id === rows.fact.id).relevance, 1, 'the same number in semantic mode');
  const k = await call('memory.search', { namespace: 'n', query: 'keywordonly', mode: 'keyword', view: 'compact' });
  assert.strictEqual(k.results[0].relevance, null);
  assert.strictEqual(k.relevance.by, 'none');
  const d = await call('memory.search', { namespace: 'n', query: 'keywordonly', mode: 'keyword', view: 'debug' });
  assert.strictEqual(d.score_kind, 'bm25');
});

test('the floor flags and never cuts; absence is about every scanned row', async () => {
  const r = await call('memory.search', { namespace: 'n', query: 'beta', view: 'compact', k: 5 }); // [0,1,0]: far is 1, note 0.6, fact 0
  assert.strictEqual(r.results.length, 3, 'nothing is cut');
  assert.deepStrictEqual(r.results.filter(x => x.low_relevance).map(x => x.id), [rows.fact.id]);
  assert.strictEqual(r.absence_established, false);
  const none = await call('memory.search', { namespace: 'n', query: 'gamma', view: 'compact', k: 5 }); // [0,0,1]: every cosine 0
  assert.strictEqual(none.results.length, 3);
  assert.ok(none.results.every(x => x.low_relevance));
  assert.strictEqual(none.absence_established, true);
  assert.match(none.warning, /no result reaches the relevance floor/);
});

test('memory.list says when its page is not the whole, when it capped the limit, and which texts it cut', async () => {
  const p = await call('memory.list', { namespace: 'big', limit: 2 });
  assert.strictEqual(p.total, 5);
  assert.strictEqual(p.truncated, true);
  assert.strictEqual(p.next_offset, 2);
  assert.ok(p.rows.every(r => r.text_truncated === true && r.text.length === 200));
  const last = await call('memory.list', { namespace: 'big', limit: 2, offset: 4 });
  assert.strictEqual(last.truncated, undefined, 'the last page is the end');
  assert.strictEqual(last.next_offset, undefined);
  const capped = await call('memory.list', { namespace: 'n', limit: 900 });
  assert.strictEqual(capped.limit_capped, 500);
  assert.ok(capped.rows.every(r => r.text_truncated === undefined), 'a short text is whole');
});

// ---- the review's cases: a keyword hit, a mixed scope, the floor's exact edge, superseded rows --------------------------------------

const putIn = (namespace, text, vec, extra = {}) => call('memory.store', { namespace, text, ...(vec ? { embedding: vec, embedding_model: 'm', dim: 3 } : { embed: false }), ...extra });

test('the floor is 0.35, pinned by value', () => {
  assert.strictEqual(RELEVANCE_FLOOR, 0.35);
});

test('an exact keyword hit blocks absence whatever its cosine', async () => {
  await putIn('k', 'killByIdentity checks the pid creation time before it kills', [1, 0, 0]);
  const r = await call('memory.search', { namespace: 'k', query: 'beta killByIdentity', view: 'compact' }); // the query embeds as [0,1,0]
  assert.deepStrictEqual(r.modes_run, ['semantic', 'keyword']);
  assert.strictEqual(r.results.length, 1);
  assert.strictEqual(r.results[0].relevance, 0);
  assert.strictEqual(r.results[0].low_relevance, true, 'far by cosine');
  assert.strictEqual(r.absence_established, false, 'but the keyword half found the identifier the query names');
});

test('a mixed scope: absence needs every namespace covered and far, and one near row in either namespace denies it', async () => {
  await putIn('mixA', 'ferries depart at noon', [0, 0, 1]);
  await putIn('mixB', 'the harbour closes in winter', [0, 0, 1]);
  const far = await call('memory.search', { namespaces: ['mixA', 'mixB'], query: 'alpha', view: 'compact' });
  assert.strictEqual(far.results.length, 2);
  assert.strictEqual(far.absence_established, true, 'both namespaces scanned, nothing near, no keyword hit');
  await putIn('mixB', 'pier four has the ticket office', null); // a row the semantic scan cannot see
  const gap = await call('memory.search', { namespaces: ['mixA', 'mixB'], query: 'alpha', view: 'compact' });
  assert.strictEqual(gap.rows_without_vector, 1);
  assert.strictEqual(gap.absence_established, false, 'an uncovered row in one namespace leaves the claim unmade');
  await putIn('mixA2', 'ferries depart at noon', [0, 0, 1]);
  await putIn('mixB2', 'retries need a backoff', [0.9, 0.1, 0]);
  const near = await call('memory.search', { namespaces: ['mixA2', 'mixB2'], query: 'alpha', view: 'compact' });
  assert.strictEqual(near.absence_established, false, 'the near row is in the second namespace');
});

test('at exactly the floor a row reaches it; just below, it does not, here and in the absence claim', async () => {
  const at = Math.sqrt(1 - 0.35 * 0.35), below = Math.sqrt(1 - 0.3499 * 0.3499);
  assert.deepStrictEqual(Object.keys(require('../../src/core/memory-search-view.cjs').relevanceFields(0.35)), ['relevance']);
  assert.strictEqual(require('../../src/core/memory-search-view.cjs').relevanceFields(0.34994).low_relevance, true);
  await putIn('edgeAt', 'ferries depart at noon', [0.35, at, 0]);
  const r = await call('memory.search', { namespace: 'edgeAt', query: 'alpha', view: 'compact' });
  assert.strictEqual(r.results[0].relevance, 0.35);
  assert.strictEqual(r.results[0].low_relevance, undefined);
  assert.strictEqual(r.absence_established, false, 'a row at the floor is something relevant');
  await putIn('edgeBelow', 'ferries depart at noon', [0.3499, below, 0]);
  const b = await call('memory.search', { namespace: 'edgeBelow', query: 'alpha', view: 'compact' });
  assert.strictEqual(b.results[0].relevance, 0.3499);
  assert.strictEqual(b.results[0].low_relevance, true);
  assert.strictEqual(b.absence_established, true);
});

test('compact keeps supersedes, and marks a superseded row when include_superseded brings it back', async () => {
  const old = await putIn('sup', 'the retry limit is three', [1, 0, 0]);
  const neu = await putIn('sup', 'the retry limit is five', [1, 0, 0], { supersedes: old.id });
  const live = await call('memory.search', { namespace: 'sup', query: 'alpha', view: 'compact' });
  assert.deepStrictEqual(live.results.map(x => [x.id, x.supersedes, x.superseded]), [[neu.id, old.id, undefined]]);
  const all = await call('memory.search', { namespace: 'sup', query: 'alpha', view: 'compact', include_superseded: true });
  const o = all.results.find(x => x.id === old.id);
  assert.strictEqual(o.superseded, true);
  assert.strictEqual(all.results.find(x => x.id === neu.id).superseded, undefined);
});
