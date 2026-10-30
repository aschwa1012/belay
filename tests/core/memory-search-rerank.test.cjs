'use strict';
// memory-search-rerank.test.cjs — the rerank stage of memory.search (ADR 0050 decision 5 and 6): the provider reorders the top of the
// fused list, a row's fusion rank is the tiebreak, the page is cut after it; a provider that times out, throws, is absent or answers
// badly is a loud fallback to the fusion order, or, under on_heavy_failure pause, goes through the embedder-failure hook.

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT } = require('./lifecycle-env.cjs');
const RP = require('../../src/core/retrieval-profiles.cjs');
const provider = require('../../src/core/rerank-provider.cjs');
const { search } = require('../../src/core/memory-search.cjs');
const { Engine } = require('../../src/core/engine.cjs');
const rows = require('../../src/core/rows.cjs');
const ST = require('../../src/core/search-tier.cjs');

const NS = `project/${PROJECT}`;
const RR = 'fake/reranker';
let T, notes, E2;
const hooked = [];
const FIX = [[1, 0, 0], [0.95, 0.31, 0], [0.8, 0.6, 0], [0.5, 0.866, 0], [0.2, 0.98, 0], [0, 1, 0]];
before(async () => {
  T = await setup();
  notes = FIX.map((v, i) => T.note(`rerank fixture ${i}`, { vec: v }));
  E2 = new Engine({ dataDir: T.dir, store: T.store, getEmbedder: null, owner: { opts: { onEmbedderFailure: (x) => { hooked.push(x); } } }, establishedBy: 'test' });
});
after(() => T.close());
afterEach(() => { provider.unregister(RR); hooked.length = 0; T.E._rerankFallback = null; E2._rerankFallback = null; });

const tier = (over = {}) => ({ profile: 'custom', embedder: RP.NANO, reranker: RR, device: 'cpu', depth: 4, ...over });
const ask = (E, args = {}, internal = {}) => search(E, T.who.operator('plain'), { namespaces: [NS], query: 'rerank me', query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic', k: 20, ...args }, { tier: tier(), ...internal });
const ids = (r) => r.results.map(x => x.id);
// the fusion order of the fixture: by cosine to [1,0,0], i.e. notes[0..5]
const base = () => [...notes];
// a provider that scores by a function of the fixture index; the requests it gets are recorded
function fake(scoreOf) {
  const seen = [];
  provider.register(RR, { async rerank(req) { seen.push(req); return { scores: req.docs.map(d => ({ id: d.id, score: scoreOf(notes.indexOf(d.id), d) })), model: RR, device: 'cpu', ms: 3 }; } });
  return seen;
}

test('the reranker reorders the top depth, the rest keep their fusion order, and the page is cut to k', async () => {
  const seen = fake((i) => 10 - i); // prefers the earlier fixture rows' opposite: reverses the head
  const r = await ask(T.E, { k: 5 });
  assert.deepStrictEqual(ids(r), [notes[0], notes[1], notes[2], notes[3], notes[4]], 'a score falling with the index keeps the order');
  const rev = fake((i) => i);
  const r2 = await ask(T.E, { k: 5 });
  assert.deepStrictEqual(ids(r2), [notes[3], notes[2], notes[1], notes[0], notes[4]], 'the top 4 reversed, then the fifth in fusion order, cut to k = 5');
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(rev.length, 1);
  assert.strictEqual(rev[0].docs.length, 4, 'only the top depth is sent');
  assert.strictEqual(rev[0].depth, 4);
  assert.strictEqual(rev[0].query, 'rerank me');
  assert.ok(rev[0].docs[0].text.startsWith('rerank fixture 0'), 'the doc text is the row text');
  assert.strictEqual(r2.rerank.ran, true);
  assert.strictEqual(r2.rerank.reranked, 4);
  assert.strictEqual(r2.rerank.model, RR);
  assert.deepStrictEqual(r2.tier, { profile: 'custom', embedder: RP.NANO, reranker: RR, device: 'cpu' });
  assert.ok(r2.modes_run.includes('rerank'));
  assert.strictEqual(r2.results[0].rerank_score, 3);
  assert.deepStrictEqual(r2.modes_failed, []);
});

test('equal scores keep the fusion rank as the tiebreak', async () => {
  fake((i) => (i < 2 ? 1 : 0)); // two tied at the top, two tied below
  const r = await ask(T.E, { k: 4 });
  assert.deepStrictEqual(ids(r), [notes[0], notes[1], notes[2], notes[3]]);
  fake((i) => (i === 3 ? 5 : 1));
  assert.deepStrictEqual(ids(await ask(T.E, { k: 4 })), [notes[3], notes[0], notes[1], notes[2]]);
});

test('the depth lever and an offset: reranking happens before the page is cut', async () => {
  fake((i) => i);
  const r = await ask(T.E, { k: 2, offset: 1 }, { tier: tier({ depth: 0 }), levers: { rerank_depth: 3 } });
  assert.deepStrictEqual(ids(r), [notes[1], notes[0]], 'head 3 reversed is 2,1,0; the page from offset 1 is 1,0');
});

test('a provider that times out falls back to the fusion order, loudly', async () => {
  provider.register(RR, { rerank: () => new Promise(() => {}) });
  const r = await ask(T.E, {}, { levers: { rerank_bound_ms: 40, on_heavy_failure: 'fallback' } });
  assert.deepStrictEqual(ids(r), base());
  assert.strictEqual(r.rerank.skipped, true);
  assert.strictEqual(r.rerank.cause.code, 'E_RERANK');
  assert.strictEqual(r.rerank.cause.reason, 'timeout');
  assert.strictEqual(r.modes_failed.length, 1);
  assert.strictEqual(r.modes_failed[0].mode, 'rerank');
  assert.match(r.warning, /rerank did not run/);
  assert.strictEqual(Object.keys(r)[0], 'warning');
  assert.ok(!r.modes_run.includes('rerank'));
});

test('a provider that throws, answers short or answers without scores falls back, loudly, with its reason', async () => {
  provider.register(RR, { rerank: async () => { throw new Error('model file missing'); } });
  let r = await ask(T.E);
  assert.deepStrictEqual([ids(r).length, r.rerank.cause.reason, /model file missing/.test(r.rerank.cause.message)], [FIX.length, 'error', true]);
  T.E._rerankFallback = null; // each failure below is a first failure of its own
  provider.register(RR, { rerank: async (req) => ({ scores: req.docs.slice(1).map(d => ({ id: d.id, score: 1 })) }) });
  r = await ask(T.E);
  assert.strictEqual(r.rerank.cause.reason, 'malformed');
  T.E._rerankFallback = null;
  provider.register(RR, { rerank: async () => ({}) });
  r = await ask(T.E);
  assert.deepStrictEqual([r.rerank.skipped, r.rerank.cause.reason, r.modes_failed[0].mode], [true, 'malformed', 'rerank']);
  assert.deepStrictEqual(ids(r), base());
});

test('a reranker nobody provides is a failure, handled the same way', async () => {
  const r = await ask(T.E);
  assert.strictEqual(r.rerank.skipped, true);
  assert.strictEqual(r.rerank.cause.reason, 'absent');
  assert.deepStrictEqual(ids(r), base());
  assert.match(r.warning, /absent/);
});

test('a search with only a vector cannot be reranked: loud fallback, not a silent skip', async () => {
  fake((i) => i);
  const r = await search(T.E, T.who.operator('plain'), { namespaces: [NS], query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic' }, { tier: tier() });
  assert.strictEqual(r.rerank.cause.reason, 'no_query');
  assert.deepStrictEqual(ids(r), base());
});

test('on_heavy_failure pause tells the embedder-failure hook and refuses the search', async () => {
  provider.register(RR, { rerank: async () => { throw new Error('gpu gone'); } });
  await assert.rejects(() => ask(E2, {}, { levers: { on_heavy_failure: 'pause' } }), (e) => {
    assert.strictEqual(e.code, 'E_RERANK');
    assert.strictEqual(e.detail.embedder, true);
    assert.strictEqual(e.detail.stage, 'rerank');
    return true;
  });
  assert.strictEqual(hooked.length, 1);
  assert.strictEqual(hooked[0].call, 'memory.search');
  assert.strictEqual(hooked[0].error.code, 'E_RERANK');
  // an absent provider pauses the same way
  hooked.length = 0;
  provider.unregister(RR);
  await assert.rejects(() => ask(E2, {}, { levers: { on_heavy_failure: 'pause' } }), (e) => e.code === 'E_RERANK' && e.detail.reason === 'absent');
  assert.strictEqual(hooked.length, 1);
});

test('the default tier has no reranker: no rerank field, no provider call', async () => {
  const seen = fake((i) => -i);
  const r = await search(T.E, T.who.operator('plain'), { namespaces: [NS], query: 'x', query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic' });
  assert.strictEqual(seen.length, 0);
  assert.strictEqual(r.rerank, undefined);
  assert.strictEqual(r.tier, undefined);
  assert.deepStrictEqual(ids(r), base());
});

test('a provider failure is sticky for the rest of the run: later searches skip the provider and say so', async () => {
  provider.register(RR, { rerank: async () => { throw new Error('first failure'); } });
  const first = await ask(T.E);
  assert.strictEqual(first.rerank.cause.reason, 'error');
  const seen = fake((i) => i); // the reranker would work now, but the run is on the fallback
  const later = await ask(T.E);
  assert.strictEqual(seen.length, 0, 'the provider is not called again');
  assert.strictEqual(later.rerank.skipped, true);
  assert.strictEqual(later.rerank.cause.reason, 'fallback_sticky');
  assert.strictEqual(later.rerank.cause.first_cause.reason, 'error');
  assert.match(later.rerank.cause.first_cause.message, /first failure/);
  assert.strictEqual(later.modes_failed[0].mode, 'rerank');
  assert.match(later.warning, /rerank did not run/);
  assert.deepStrictEqual(ids(later), base());
  // another run is not on the fallback
  const other = await search(T.E, T.who.operator('propose'), { namespaces: [NS], query: 'rerank me', query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic', k: 20 }, { tier: tier() });
  assert.strictEqual(other.rerank.ran, true);
  assert.strictEqual(seen.length, 1);
});

test('a search with no query text never pauses the run, even with on_heavy_failure pause (the hand-back duplicate check is one)', async () => {
  fake((i) => i);
  const r = await search(T.E, T.who.operator('plain'), { namespaces: [NS], query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic' }, { tier: tier(), levers: { on_heavy_failure: 'pause' } });
  assert.strictEqual(r.rerank.cause.reason, 'no_query');
  assert.deepStrictEqual(ids(r), base());
});

test('a search with no query text is not a provider failure and does not make the run sticky', async () => {
  fake((i) => i);
  const vectorOnly = await search(T.E, T.who.operator('plain'), { namespaces: [NS], query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic' }, { tier: tier() });
  assert.strictEqual(vectorOnly.rerank.cause.reason, 'no_query');
  assert.strictEqual((await ask(T.E)).rerank.ran, true);
});

test('the reranker reads a v2 note as its title and its text (cut at 2,000 characters), and a v1 row as its text', async () => {
  const seen = fake((i) => -i);
  const id = T.note('v2 rerank title', { vec: [1, 0, 0] });
  const body = { ...T.body(id), when: 'when reranking v2 notes' };
  T.store.db.prepare('UPDATE memory_entries SET body = ?, text = ? WHERE id = ?').run(JSON.stringify(body), `body of the note ${'z'.repeat(3000)}`, id);
  T.store.cache.clear();
  try {
    await ask(T.E, {}, { tier: tier({ depth: 10 }) });
    const doc = seen[0].docs.find(d => d.id === id);
    assert.ok(doc.text.startsWith('v2 rerank title\nbody of the note'), 'title, then the note text, not the When line');
    assert.ok(!doc.text.includes('when reranking'));
    assert.strictEqual(doc.text.length, 2000);
    assert.ok(seen[0].docs.find(d => d.id === notes[0]).text.startsWith('rerank fixture 0'), 'a v1 row is its text');
  } finally { T.store.delete(id); }
});

// ---- the sticky fallback's scope (S9) ------------------------------------------------------------------------------
const failing = () => provider.register(RR, { rerank: async () => { throw new Error('boom'); } });
const asRun = (key, E = T.E, over = {}) => search(E, T.who.operator(key), { namespaces: [NS], query: 'rerank me', query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic', k: 20 }, { tier: tier(over) });
const runRow = (key) => rows.current(T.store, 'run', RUNS_[key]);
const RUNS_ = { propose: 'lc-propose', apply: 'lc-apply' };

test('the sticky fallback is per reranker: another reranker in the same run is tried', async () => {
  failing();
  assert.strictEqual((await asRun('propose')).rerank.cause.reason, 'error');
  assert.strictEqual((await asRun('propose')).rerank.cause.reason, 'fallback_sticky');
  const OTHER = 'fake/other-reranker';
  const seen = [];
  provider.register(OTHER, { rerank: async (req) => { seen.push(1); return { scores: req.docs.map((d, i) => ({ id: d.id, score: i })) }; } });
  try {
    const r = await asRun('propose', T.E, { reranker: OTHER });
    assert.strictEqual(r.rerank.ran, true);
    assert.strictEqual(seen.length, 1);
  } finally { provider.unregister(OTHER); }
});

test('a search with no run is never sticky: each retries the provider and reports its own failure, without saying "run"', async () => {
  let calls = 0;
  provider.register(RR, { rerank: async () => { calls++; throw new Error('provider unavailable'); } });
  const noRun = { role: 'operator', run_id: null, pid: process.pid };
  const call = () => search(T.E, noRun, { namespaces: [NS], query: 'rerank me', query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic' }, { tier: tier() });
  const a = await call(), b = await call();
  assert.deepStrictEqual([a.rerank.cause.reason, b.rerank.cause.reason, calls], ['error', 'error', 2]);
  assert.doesNotMatch(b.rerank.cause.message, /\brun\b/i);
  // a caller whose run has no run row is the same
  const ghost = { role: 'operator', run_id: 'no-such-run', pid: process.pid };
  await search(T.E, ghost, { namespaces: [NS], query: 'x', query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic' }, { tier: tier() });
  await search(T.E, ghost, { namespaces: [NS], query: 'x', query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic' }, { tier: tier() });
  assert.strictEqual(calls, 4);
});

test('a run that has ended, or been resumed since, is no longer on the fallback', async () => {
  failing();
  assert.strictEqual((await asRun('apply')).rerank.cause.reason, 'error');
  assert.strictEqual((await asRun('apply')).rerank.cause.reason, 'fallback_sticky');
  const cur = runRow('apply');
  // resumed: the run re-attaches under a new epoch
  rows.append(T.store, 'run', { ...cur, epoch: cur.epoch + 1 }, 'test', Date.now());
  assert.strictEqual((await asRun('apply')).rerank.cause.reason, 'error', 'a fresh failure of its own, not the old one');
  assert.strictEqual((await asRun('apply')).rerank.cause.reason, 'fallback_sticky');
  // ended
  rows.append(T.store, 'run', { ...runRow('apply'), ended_at: Date.now() }, 'test', Date.now());
  assert.strictEqual((await asRun('apply')).rerank.cause.reason, 'error');
  assert.strictEqual((await asRun('apply')).rerank.cause.reason, 'error', 'an ended run keeps no entry: each search retries');
});

test('the rerank bound is the lever clamped to what is left of the call budget', () => {
  assert.strictEqual(ST.boundFor(10000, 1000, 1500), 10000);
  assert.strictEqual(ST.boundFor(100000, 0, 30000), 80000, '110 s less the 30 s already spent');
  assert.strictEqual(ST.boundFor(600000, 0, 0), 110000);
  assert.strictEqual(ST.boundFor(5000, 0, 200000), 1, 'nothing left: fail at once');
});

test('the provider is handed the clamped bound', async () => {
  const seen = fake((i) => i);
  await ask(T.E, {}, { levers: { rerank_bound_ms: 600000 } });
  assert.ok(seen[0].boundMs <= 110000 && seen[0].boundMs > 100000);
});
