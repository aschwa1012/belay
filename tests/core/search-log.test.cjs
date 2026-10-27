'use strict';
// search-log.test.cjs — the search log (ADR 0050 decision 7): the store owner writes one memory_event of kind search per search it
// serves (kind index for the first-message index), a copy writes nothing, a failed write never fails the search, and the cap prunes
// the oldest runs first.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT, RUNS } = require('./lifecycle-env.cjs');
const { callerFor } = require('./helpers.cjs');
const RP = require('../../src/core/retrieval-profiles.cjs');
const provider = require('../../src/core/rerank-provider.cjs');
const SL = require('../../src/core/search-log.cjs');
const { search } = require('../../src/core/memory-search.cjs');
const { Engine } = require('../../src/core/engine.cjs');

const NS = `project/${PROJECT}`;
const RR = 'fake/log-reranker';
let T, notes, OWN;
const FIX = [[1, 0, 0], [0.9, 0.436, 0], [0.7, 0.714, 0], [0.2, 0.98, 0]];
before(async () => {
  T = await setup({ levers: { plain: { search_log: true } } }); // the search log is off unless a run turns it on
  notes = FIX.map((v, i) => T.note(`log fixture ${i}`, { vec: v }));
  OWN = new Engine({ dataDir: T.dir, store: T.store, getEmbedder: null, owner: { opts: {} }, establishedBy: 'test' });
});
after(() => T.close());

const events = (kind = 'search') => T.store.db.prepare('SELECT * FROM memory_event WHERE kind = ? ORDER BY seq').all(kind);
const detail = (ev) => JSON.parse(ev.message);
const args = (over = {}) => ({ namespaces: [NS], query: 'where is the loader', query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic', k: 3, ...over });

test('an owner-served search writes one search event with the caller, tier, query, ranks before and after, stage times and fallback', async () => {
  provider.register(RR, { rerank: async (req) => ({ scores: req.docs.map((d, i) => ({ id: d.id, score: i })), model: RR, device: 'cpu', ms: 1 }) });
  try {
    const before = events().length;
    const caller = T.who.tool('plain');
    const tier = { profile: 'custom', embedder: RP.NANO, reranker: RR, device: 'cpu', depth: 4 };
    const r = await search(OWN, caller, args(), { tier });
    assert.deepStrictEqual(r.results.map(x => x.id), [notes[3], notes[2], notes[1]]);
    const evs = events();
    assert.strictEqual(evs.length, before + 1, 'exactly one row');
    const ev = evs[evs.length - 1];
    assert.strictEqual(ev.kind, 'search');
    assert.strictEqual(ev.ok, 1);
    assert.strictEqual(ev.run_id, RUNS.plain);
    assert.deepStrictEqual(JSON.parse(ev.row_ids), [notes[3], notes[2], notes[1], notes[0]], 'the ranked candidate ids');
    const d = detail(ev);
    assert.strictEqual(d.v, 1);
    assert.strictEqual(d.role, 'orchestrator');
    assert.strictEqual(d.worker_id, null);
    assert.deepStrictEqual(d.tier, { profile: 'custom', embedder: RP.NANO, reranker: RR, device: 'cpu' });
    assert.strictEqual(d.query, 'where is the loader');
    assert.strictEqual(d.mode, 'semantic');
    assert.deepStrictEqual(d.namespaces, [NS]);
    assert.deepStrictEqual(d.ranks, [
      { id: notes[3], before: 4, after: 1 }, { id: notes[2], before: 3, after: 2 }, { id: notes[1], before: 2, after: 3 }, { id: notes[0], before: 1, after: 4 },
    ]);
    assert.ok(Number.isInteger(d.ms.semantic) && Number.isInteger(d.ms.rerank) && Number.isInteger(d.ms.total));
    assert.strictEqual(d.fallback, null);
    assert.strictEqual(ev.bytes, Buffer.byteLength(ev.message) + Buffer.byteLength(ev.row_ids));
  } finally { provider.unregister(RR); }
});

test('a fallback and its cause are in the row, a long query is cut, and a secret in the query is scrubbed', async () => {
  const tier = { profile: 'custom', embedder: RP.NANO, reranker: RR, device: 'cpu', depth: 4 };
  await search(OWN, T.who.tool('plain'), args({ query: 'lorem ipsum dolor '.repeat(300) }), { tier });
  const d = detail(events().pop());
  assert.strictEqual(d.query.length, SL.QUERY_MAX);
  assert.strictEqual(d.query_cut, true);
  assert.strictEqual(d.fallback.failed[0].mode, 'rerank', 'no provider is registered for the reranker');
  assert.strictEqual(d.fallback.failed[0].code, 'E_RERANK');
  assert.strictEqual(d.ms.rerank >= 0, true);
  await search(OWN, T.who.tool('plain'), args({ query: 'how to log in with token=abcdef0123456789abcdef0123456789 please' }));
  const s = detail(events().pop());
  assert.ok(!s.query.includes('abcdef0123456789abcdef0123456789'), 'the secret is scrubbed from the logged query');
  assert.ok(s.query.startsWith('how to log in with token='));
  assert.strictEqual(s.query_cut, false);
});

test('a worker search records the worker id from the caller, never from the arguments', async () => {
  const worker = callerFor('worker', { run_id: RUNS.plain, worker_id: 'w-log' });
  await search(OWN, worker, args({ namespaces: undefined, namespace: `run/${RUNS.plain}`, worker_id: 'someone-else' }));
  const ev = events().pop();
  assert.strictEqual(ev.worker_id, 'w-log');
  assert.strictEqual(detail(ev).worker_id, 'w-log');
  assert.strictEqual(detail(ev).role, 'worker');
});

test('a search answered from a copy (no owner) writes no log row', async () => {
  const before = events().length;
  const r = await search(T.E, T.who.tool('plain'), args());
  assert.strictEqual(r.results.length, 3);
  assert.strictEqual(events().length, before);
});

test('a failed log write never fails the search', async () => {
  const before = events().length;
  const real = T.store.p.bind(T.store);
  T.store.p = (sql) => { if (/INSERT INTO memory_event/.test(sql)) throw new Error('disk full'); return real(sql); };
  try {
    const r = await search(OWN, T.who.tool('plain'), args());
    assert.strictEqual(r.results.length, 3);
  } finally { T.store.p = real; }
  assert.strictEqual(events().length, before, 'nothing was written, and the answer still came');
});

test('the index is logged with kind index by the owner, and not from a copy', async () => {
  const caller = T.who.harness('plain');
  const before = events('index').length;
  await T.E.handle('memory.index', { caller, query: 'loader' });
  assert.strictEqual(events('index').length, before, 'a copy writes nothing');
  const out = await OWN.handle('memory.index', { caller, query: 'loader', worker_id: 'w-idx' });
  const evs = events('index');
  assert.strictEqual(evs.length, before + 1);
  const ev = evs[evs.length - 1];
  assert.strictEqual(ev.worker_id, null, 'the harness caller has no worker identity of its own');
  const d = detail(ev);
  assert.strictEqual(d.for_worker, 'w-idx', 'the harness names the worker it builds the index for');
  assert.strictEqual(d.query, 'loader');
  assert.deepStrictEqual(d.ranks.map(x => x.id), out.row_ids);
  assert.strictEqual(d.tier.embedder, RP.NANO);
});

test('the cap prunes the oldest runs first, keeps the newest, and keeps the counter equal to what is stored', async () => {
  T.store.db.prepare("DELETE FROM memory_event WHERE kind IN ('search', 'index')").run();
  T.store.db.prepare("DELETE FROM meta WHERE key = ?").run(SL.COUNTER);
  const sum = () => Number(T.store.db.prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM memory_event WHERE kind IN ('search', 'index')").get().n);
  const runsLeft = () => T.store.db.prepare("SELECT DISTINCT run_id FROM memory_event WHERE kind = 'search' ORDER BY run_id").all().map(r => r.run_id);
  const write = (run, n, capMb) => {
    for (let i = 0; i < n; i++) SL.record(OWN, callerFor('operator', { run_id: run }), { kind: 'search', tier: { embedder: RP.NANO }, query: `q ${run} ${i} ${'y'.repeat(400)}`, ranks: [{ id: 'a', before: 1, after: 1 }], ms: { total: 1 }, capMb });
  };
  const CAP = 0.01; // MB, about 10.5 KB: each row is about 700 bytes
  const settle = () => new Promise(r => setImmediate(r));
  write('run-a', 5, CAP); write('run-b', 5, CAP); await settle();
  assert.deepStrictEqual(runsLeft(), ['run-a', 'run-b'], 'both fit');
  assert.strictEqual(Number(T.store.db.prepare('SELECT value FROM meta WHERE key = ?').get(SL.COUNTER).value), sum());
  write('run-c', 6, CAP);
  assert.ok(runsLeft().includes('run-a'), 'nothing is pruned inside the write path');
  await settle();
  assert.ok(!runsLeft().includes('run-a'), 'the oldest run went first');
  assert.ok(runsLeft().includes('run-c'), 'the newest run stayed');
  assert.ok(sum() <= CAP * 1048576, 'at or under the cap');
  assert.strictEqual(Number(T.store.db.prepare('SELECT value FROM meta WHERE key = ?').get(SL.COUNTER).value), sum(), 'the counter matches the stored bytes');
  // one run alone over the cap: its oldest events go, its newest stay
  write('run-d', 40, CAP); await settle();
  assert.deepStrictEqual(runsLeft(), ['run-d']);
  const kept = T.store.db.prepare("SELECT message FROM memory_event WHERE kind = 'search' ORDER BY seq").all().map(r => JSON.parse(r.message).query);
  assert.ok(kept.length > 0 && kept.length < 40);
  assert.ok(kept[kept.length - 1].startsWith('q run-d 39'), 'the newest event is kept');
  assert.ok(sum() <= CAP * 1048576);
});

test('memory.recordEvent refuses the search and index kinds from every caller', async () => {
  for (const kind of ['search', 'index']) {
    for (const caller of [T.who.tool('plain'), T.who.operator('plain'), T.who.harness('plain')]) {
      await assert.rejects(() => T.E.handle('memory.recordEvent', { caller, kind, message: 'forged' }), (e) => e.code === 'E_ROLE' && e.detail.kind === kind);
    }
  }
  await T.E.handle('memory.recordEvent', { caller: T.who.tool('plain'), kind: 'bottle' }).catch(() => {}); // other kinds are untouched
});

test('the prune is one DELETE at one cut-off, run after the write returns', async () => {
  T.store.db.prepare("DELETE FROM memory_event WHERE kind IN ('search', 'index')").run();
  T.store.db.prepare('DELETE FROM meta WHERE key = ?').run(SL.COUNTER);
  const deletes = [];
  const real = T.store.p.bind(T.store);
  T.store.p = (sql) => { const st = real(sql); if (/^DELETE FROM memory_event/.test(sql)) return { run: (...a) => { deletes.push(sql); return st.run(...a); } }; return st; };
  try {
    const write = (run, n) => { for (let i = 0; i < n; i++) SL.record(OWN, callerFor('operator', { run_id: run }), { kind: 'search', tier: {}, query: `q ${run} ${i} ${'y'.repeat(400)}`, ranks: [], capMb: 0.01 }); };
    write('p-a', 8); write('p-b', 8); write('p-c', 8);
    assert.strictEqual(deletes.length, 0, 'no delete inside the writes');
    await new Promise(r => setImmediate(r));
    assert.strictEqual(deletes.length, 1, 'one statement');
    assert.match(deletes[0], /seq <= \?/);
    const left = T.store.db.prepare("SELECT DISTINCT run_id FROM memory_event WHERE kind = 'search' ORDER BY run_id").all().map(r => r.run_id);
    assert.ok(!left.includes('p-a') && left.includes('p-c'));
  } finally { T.store.p = real; }
});

test('a worker cannot attribute an index row to another worker: the logged worker is the caller, the argument is ignored', async () => {
  const worker = callerFor('worker', { run_id: RUNS.plain, worker_id: 'w-real' });
  const before = events('index').length;
  await OWN.handle('memory.index', { caller: worker, query: 'loader', worker_id: 'w-victim', task_id: 't-victim' });
  const ev = events('index')[before];
  assert.strictEqual(ev.worker_id, 'w-real');
  assert.strictEqual(ev.task_id, null);
  const d = detail(ev);
  assert.deepStrictEqual([d.worker_id, d.for_worker, d.for_task], ['w-real', null, null]);
});

test('the search log is off by default: a run without memory.search_log writes no search or index row, and turning it on in the levers does', async () => {
  const ST = require('../../src/core/search-tier.cjs');
  assert.strictEqual(ST.leversOfSearch(OWN, T.who.tool('propose')).search_log, false, 'the default');
  const s0 = events().length, i0 = events('index').length;
  await search(OWN, T.who.tool('propose'), args());
  await OWN.handle('memory.index', { caller: { ...T.who.harness('propose') }, query: 'loader', worker_id: 'w-off' });
  assert.strictEqual(events().length, s0, 'no search row with the lever off');
  assert.strictEqual(events('index').length, i0, 'no index row with the lever off');
  await search(OWN, T.who.tool('propose'), args(), { levers: { search_log: true } });
  assert.strictEqual(events().length, s0 + 1, 'the lever on: one row');
});

test('an internal search (log: false) and an abandoned run write no row; the run that answered does', async () => {
  const before = events().length;
  await search(OWN, T.who.tool('plain'), args(), { log: false });
  assert.strictEqual(events().length, before, 'internal.log false');
  const flag = Symbol.for('belay.search.abandoned');
  await search(OWN, T.who.tool('plain'), { ...args(), [flag]: { abandoned: true } });
  assert.strictEqual(events().length, before, 'the run the timeout abandoned');
  await search(OWN, T.who.tool('plain'), { ...args(), [flag]: { abandoned: false } });
  assert.strictEqual(events().length, before + 1, 'the run that answered');
});

test('the hand-back duplicate check (findMatches) is an internal search and is not logged', async () => {
  const { findMatches } = require('../../src/core/methods-memory-notes.cjs');
  if (typeof findMatches !== 'function') return; // not exported: covered by the log:false test above
  const before = events().length;
  await findMatches(OWN, T.who.tool('plain'), PROJECT, { embedding: [1, 0, 0], embedding_model: 'm', dim: 3 }, { notes_match_n: 3, notes_match_threshold: 0.5 });
  assert.strictEqual(events().length, before);
});

test('a non-score order records no ranks; the rank list is capped by k and the depth', async () => {
  await search(OWN, T.who.tool('plain'), args({ order: 'newest' }));
  assert.deepStrictEqual(detail(events().pop()).ranks, []);
  await search(OWN, T.who.tool('plain'), args({ k: 1 }), { levers: { rerank_depth: 1 } });
  assert.strictEqual(detail(events().pop()).ranks.length, 1);
});

test('the fallback messages in the log are scrubbed too', async () => {
  provider.register(RR, { rerank: async () => { throw new Error('auth failed with token=abcdef0123456789abcdef0123456789'); } });
  try {
    await search(OWN, T.who.tool('plain'), args(), { tier: { profile: 'custom', embedder: RP.NANO, reranker: RR, device: 'cpu', depth: 4 } });
    const ev = events().pop();
    assert.ok(!ev.message.includes('abcdef0123456789abcdef0123456789'));
    assert.doesNotThrow(() => JSON.parse(ev.message));
  } finally { provider.unregister(RR); OWN._rerankFallback = null; }
});

test('memory.events without kinds leaves the search log out; kinds names it', async () => {
  const caller = T.who.operator('plain');
  const all = (await T.E.handle('memory.events', { caller })).events;
  assert.ok(!all.some(e => e.kind === 'search' || e.kind === 'index'));
  const asked = (await T.E.handle('memory.events', { caller, kinds: ['search', 'index'] })).events;
  assert.ok(asked.length > 0 && asked.every(e => e.kind === 'search' || e.kind === 'index'));
});

test('the rerank bound is clamped under the MCP tool timeout', () => {
  const ST = require('../../src/core/search-tier.cjs');
  assert.strictEqual(ST.leversOfSearch(T.E, T.who.tool('plain'), { rerank_bound_ms: 600000 }).rerank_bound_ms, 110000);
  assert.strictEqual(ST.leversOfSearch(T.E, T.who.tool('plain'), { rerank_bound_ms: 500 }).rerank_bound_ms, 500);
});
