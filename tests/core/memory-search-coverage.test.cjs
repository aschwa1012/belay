'use strict';
// memory-search-coverage.test.cjs — a review of the first search build found absence_established true while a
// matching row existed: rows stored without a vector are invisible to the semantic scan, and keyword is an AND
// over every term, so a natural-language hybrid query missed them and absence rested on one mode. These tests
// pin that absence needs every in-scope row covered by both modes, then pin the argument checks the review
// asked for and the openCore-level fallbacks for a wedged owner and a hybrid timeout in the owner's process.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const { openCore } = core('index.cjs');

const orch = callerFor('orchestrator');
const embedder = async () => ({ embed: async () => ({ embedding: [1, 0, 0], embedding_model: 'm', dim: 3 }) });

function engineOver(dir) {
  const store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  return { store, E: new Engine({ dataDir: dir, store, getEmbedder: embedder, owner: null, establishedBy: 'test' }) };
}
const search = (E, args) => E.handle('memory.search', { caller: orch, ...args });

test('absence is not established while in-scope rows have no vector: the row count is named', async () => {
  const dir = sandbox();
  const { store, E } = engineOver(dir);
  try {
    // The embed:false shape: keyword-findable, semantic-invisible. No vector, so the namespace has no model binding.
    store.store({ namespace: 'n', worker_id: 'w', text: 'The owner pipe wedges when the loop blocks on CreateProcess' });
    store.store({ namespace: 'n', worker_id: 'w', text: 'Retry the ping twice before reporting the owner lost' });
    const r = await search(E, { namespace: 'n', query: 'zzzqqq xxxyyy', mode: 'hybrid' });
    assert.strictEqual(r.searched.rows_considered, 2);
    assert.strictEqual(r.scanned, 0);
    assert.strictEqual(r.absence_established, false, 'a semantic scan that saw no row cannot join in establishing absence');
    assert.strictEqual(r.searched.rows_without_vector, 2);
    assert.match(r.warning, /^2 in-scope rows have no vector/);
    assert.match(r.warning, /does not mean no such memory/);
    const k = await search(E, { namespace: 'n', query: 'CreateProcess', mode: 'keyword' });
    assert.strictEqual(k.results.length, 1, 'the row is findable by keyword');
    // One embedded row beside an unembedded one: the namespace is bound, yet the unembedded row is still uncovered.
    await E.handle('memory.store', { caller: orch, namespace: 'm', text: 'embedded row', embedding: [1, 0, 0], embedding_model: 'm', dim: 3 });
    store.store({ namespace: 'm', worker_id: 'w', text: 'plain unembedded row' });
    const mixed = await search(E, { namespaces: ['m'], query: 'zzzqqq', mode: 'hybrid' });
    assert.strictEqual(mixed.absence_established, false);
    assert.strictEqual(mixed.searched.rows_without_vector, 1);
    assert.strictEqual(mixed.warning, null, 'the embedded row answered, so the page is not empty and needs no empty-result warning');
  } finally { store.close(); cleanup(dir); }
});

test('absence is still established when every in-scope row was excluded or scanned by both modes', async () => {
  const dir = sandbox();
  const { store, E } = engineOver(dir);
  try {
    await E.handle('memory.store', { caller: orch, namespace: 'n', text: 'an embedded row about caches', embedding: [1, 0, 0], embedding_model: 'm', dim: 3 });
    const floor = await search(E, { namespace: 'n', query: 'zzzqqq', mode: 'hybrid', min_score: 0.5 });
    assert.strictEqual(floor.absence_established, false, 'a score floor narrows the search');
    const none = await search(E, { namespace: 'n', query: 'zzzqqq', mode: 'hybrid', filter: { types: ['nothing'] } });
    assert.strictEqual(none.absence_established, true, 'the filter excludes the row from both the count and the scan');
    assert.strictEqual(none.searched.rows_without_vector, undefined);
    assert.strictEqual(none.warning, null);
    // Every row embedded and scanned, none matching by keyword: the semantic scan is bounded by cosine only, so a
    // result exists here (cosine 1 against the stub vector), and absence stays false.
    const scanned = await search(E, { namespace: 'n', query: 'zzzqqq', mode: 'hybrid' });
    assert.strictEqual(scanned.results.length, 1);
    assert.strictEqual(scanned.absence_established, false);
  } finally { store.close(); cleanup(dir); }
});

test('min_score, dup_threshold and list limit are type-checked in core', async () => {
  const dir = sandbox();
  const { store, E } = engineOver(dir);
  const bad = (method, args) => assert.rejects(E.handle(method, { caller: orch, ...args }), e => e.code === 'E_ARGS', JSON.stringify(args));
  try {
    for (const min_score of ['x', NaN, 2, {}, true]) await bad('memory.search', { namespace: 'n', query: 'abc', min_score });
    for (const dup_threshold of ['x', -3]) await bad('memory.search', { namespace: 'n', query: 'abc', dup_threshold });
    for (const limit of [0, -1, 1.5, '5']) await bad('memory.list', { namespace: 'n', limit });
    assert.deepStrictEqual((await E.handle('memory.list', { caller: orch, namespace: 'n', limit: 3 })).rows, []);
  } finally { store.close(); cleanup(dir); }
});

// ---- openCore level -------------------------------------------------------------------------------------------

const snap = d => fs.readdirSync(d, { recursive: true }).sort().map(f => { const s = fs.statSync(path.join(d, f)); return `${f}:${s.size}:${s.mtimeMs}`; }).join('|');

test('a wedged owner (live pid, no pipe): hybrid answers from the copy naming E_OWNER_LOST, semantic is refused, no file changes', async (tcx) => {
  const dir = sandbox();
  let c;
  try {
    const store = new Store(path.join(dir, 'memory.db'), { stamp: true });
    tcx.after(() => Promise.resolve().then(() => store.db.isOpen !== false && store.close()));
    store.store({ namespace: 'run/r', worker_id: 'w', text: 'The owner pipe wedges when the loop blocks on CreateProcess' });
    store.close();
    // owner.json names this live process as the listening owner, and nothing serves the pipe.
    fs.mkdirSync(path.join(dir, 'owner.lock'));
    fs.writeFileSync(path.join(dir, 'owner.lock', 'owner.json'), JSON.stringify({ pid: process.pid, listening: true }));
    const before = snap(dir);
    c = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: 'r' }), embed: true });
    const h = await c.memory.search({ query: 'owner pipe', mode: 'hybrid' });
    assert.strictEqual(h.results.length, 1, 'the keyword half answered from the copy');
    assert.deepStrictEqual(h.modes_run, ['keyword']);
    assert.deepStrictEqual(h.modes_failed.map(f => [f.mode, f.code]), [['semantic', 'E_OWNER_LOST']]);
    assert.strictEqual(h.absence_established, false);
    assert.strictEqual(Object.keys(h)[0], 'warning');
    await assert.rejects(c.memory.search({ query: 'owner pipe', mode: 'semantic' }), e => e.code === 'E_OWNER_LOST');
    const k = await c.memory.search({ query: 'CreateProcess', mode: 'keyword' });
    assert.strictEqual(k.results.length, 1);
    assert.strictEqual(k.modes_failed.length, 0);
    await c.close(); c = null;
    assert.strictEqual(snap(dir), before, 'reading wrote nothing to the data dir');
  } finally { if (c) await c.close(); cleanup(dir); }
});

test("the owner's own hybrid search that times out answers from keyword with E_TIMEOUT in modes_failed", async () => {
  const dir = sandbox();
  let c, store;
  try {
    store = new Store(path.join(dir, 'memory.db'), { stamp: true });
    store.store({ namespace: 'run/r', worker_id: 'w', text: 'The owner pipe wedges when the loop blocks on CreateProcess' });
    const hung = async () => ({ embed: () => new Promise(() => {}) }); // a load that never finishes
    const engine = new Engine({ dataDir: dir, store, getEmbedder: hung, owner: null, establishedBy: 'owner' });
    c = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: 'r' }), embed: false });
    c.owner = { stopped: false, engine };
    c.vectorLimitMs = 200; // the in-process limit; production sets it under BELAY_TEST_MODE only
    const h = await c.memory.search({ query: 'owner pipe', mode: 'hybrid' });
    assert.strictEqual(h.results.length, 1);
    assert.deepStrictEqual(h.modes_failed.map(f => [f.mode, f.code]), [['semantic', 'E_TIMEOUT']]);
    assert.deepStrictEqual(h.modes_run, ['keyword']);
    assert.strictEqual(h.absence_established, false);
    assert.strictEqual(Object.keys(h)[0], 'warning');
    assert.match(h.warning, /^semantic search did not run \(E_TIMEOUT\)/);
    await assert.rejects(c.memory.search({ query: 'owner pipe', mode: 'semantic' }), e => e.code === 'E_TIMEOUT');
  } finally { if (c) { c.owner = null; await c.close(); } if (store) store.close(); cleanup(dir); }
});

test('a natural keyword query matches a row holding only some of its terms and ranks the row with more of them first', async () => {
  const dir = sandbox();
  const { store, E } = engineOver(dir);
  try {
    store.store({ namespace: 'n', worker_id: 'w', text: 'The owner pipe wedges when the loop blocks on CreateProcess' });
    store.store({ namespace: 'n', worker_id: 'w', text: 'Retry the ping twice before reporting the owner lost' });
    store.store({ namespace: 'n', worker_id: 'w', text: 'Unrelated note about cache eviction order' });
    const k = await search(E, { namespace: 'n', query: 'why does the owner pipe wedge when CreateProcess blocks', mode: 'keyword' });
    assert.strictEqual(k.results.length, 2, 'the row with only "owner" matches too');
    assert.match(k.results[0].text, /CreateProcess/, 'the row with more of the rare terms leads');
  } finally { store.close(); cleanup(dir); }
});
