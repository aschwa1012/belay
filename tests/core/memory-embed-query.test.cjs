'use strict';
// memory-embed-query.test.cjs — memory.embedQuery: the first-message index's query vectors, made by the owner's embedder
// through the embedding phase memory.search uses, so a failure reaches the ADR 0034 hook. memory.index never embeds: the
// vectors are handed to it, several at once, each its own semantic ranking in the fusion. A stub embedder stands in for the
// model (no model is loaded), so the test runs anywhere.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const { err } = core('errors.cjs');
const rows = core('rows.cjs');
const { HYBRID_ALPHA, HYBRID_K, rrfMany, rrf } = core('fusion.cjs');
const R = core('memory-relevance.cjs');

// Texts about shipping sit at [0, 1, 0], texts about dates at [0, 0, 1], anything else at [1, 0, 0]: meaning, not words.
const vecOf = (text) => (/ship|release|deploy/i.test(text) ? [0, 1, 0] : /date|calendar/i.test(text) ? [0, 0, 1] : [1, 0, 0]);
let mode = 'ok';
let gate = null; // while set, every embed waits on it: a held embedder, released by the test, never by a clock
const running = new Set(); // the embeds the stub has started and not finished: the test waits on these, never on a sleep
const hookCalls = [];
const embedded = [];

let dir, store, E, harness, orch;
const call = (method, args, caller = harness) => E.handle(method, { ...args, caller });
const fakeRun = (id, levers) => {
  rows.append(store, 'run', { id, epoch: 1, started_at: Date.now(), adapter_pid: process.pid }, 'operator');
  if (levers !== undefined) store.p('UPDATE run SET memory_levers = ? WHERE id = ?').run(JSON.stringify(levers), id);
};

before(() => {
  dir = sandbox();
  store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  const owner = { opts: { embedderMode: 'required', onEmbedderFailure: (ev) => { hookCalls.push(ev); } } };
  const embedOne = async (text) => {
    embedded.push(text);
    if (gate) await gate;
    if (mode === 'embedder') throw err('E_TIMEOUT', 'the embedder did not answer', { embedder: true, cause: 'timeout' });
    if (mode === 'caller') throw err('E_TOO_LONG', 'past the window');
    return { embedding: vecOf(text), embedding_model: 'stub', embedding_revision: 'r', dim: 3 };
  };
  const embedder = { embed: (text) => { const p = embedOne(text); running.add(p); const done = () => running.delete(p); p.then(done, done); return p; } };
  const getEmbedder = async () => embedder;
  E = new Engine({ dataDir: dir, store, getEmbedder, owner, establishedBy: 'test' });
  harness = callerFor('orchestrator', { channel: 'harness' });
  orch = callerFor('orchestrator');
  rows.append(store, 'task', { id: 't-ship', run_id: 'test-run', spec: 'Work out how we ship the software to production', state: 'open' }, 'orchestrator');
});
after(() => { store.close(); cleanup(dir); });

test('memory.embedQuery embeds the task\'s own text, read from the task row, and reports the ms', async () => {
  mode = 'ok'; embedded.length = 0;
  const r = await call('memory.embedQuery', { task_id: 't-ship' });
  assert.strictEqual(r.queries.length, 1);
  const q = r.queries[0];
  assert.deepStrictEqual({ label: q.label, ok: q.ok, embedding_model: q.embedding_model, dim: q.dim, query_embedding: q.query_embedding }, { label: 'task', ok: true, embedding_model: 'stub', dim: 3, query_embedding: [0, 1, 0] });
  assert.ok(Number.isInteger(q.ms) && Number.isInteger(r.embed_ms));
  assert.deepStrictEqual(embedded, ['Work out how we ship the software to production'], 'the spec was embedded, nothing the caller sent');
  assert.strictEqual(r.on_embedder_failure, 'required');
});

test('extra texts ride along, labelled, and each text is cut to the embedder-sized cap', async () => {
  mode = 'ok'; embedded.length = 0;
  const r = await call('memory.embedQuery', { task_id: 't-ship', extra_texts: ['release checklist', { label: 'dates', text: `calendar ${'x'.repeat(5000)}` }] });
  assert.deepStrictEqual(r.queries.map((q) => [q.label, q.ok]), [['task', true], ['extra:1', true], ['dates', true]]);
  assert.strictEqual(embedded[2].length, 2048, 'the long text is cut to the cap');
  assert.deepStrictEqual(r.queries[2].query_embedding, [0, 0, 1]);
  // an unknown task and no extras: nothing to embed
  assert.deepStrictEqual((await call('memory.embedQuery', { task_id: 'no-such-task' })).queries, []);
});

test('it is the run manager\'s alone, a tool-channel refusal says it is a wiring fault, and bad input is refused', async () => {
  mode = 'ok'; embedded.length = 0;
  await assert.rejects(call('memory.embedQuery', { task_id: 't-ship' }, orch), (e) => e.code === 'E_ROLE' && /wiring fault, not an embedder failure/.test(e.message) && !(e.detail && e.detail.embedder));
  await assert.rejects(call('memory.embedQuery', { extra_texts: ['a', 'b', 'c', 'd', 'e'] }), (e) => e.code === 'E_ARGS');
  await assert.rejects(call('memory.embedQuery', { extra_texts: ['  '] }), (e) => e.code === 'E_ARGS');
  await assert.rejects(call('memory.embedQuery', { extra_texts: [{ text: 'x'.repeat(70000) }, { text: 'y' }] }), (e) => e.code === 'E_ARGS' && /at most 65536 bytes/.test(e.message));
  await assert.rejects(call('memory.embedQuery', { timeout_ms: 5 }), (e) => e.code === 'E_ARGS');
  await assert.rejects(call('memory.embedQuery', { task_id: 7 }), (e) => e.code === 'E_ARGS');
  assert.deepStrictEqual(embedded, [], 'nothing was embedded');
});

test('an embedder failure is that query\'s entry with its code and cause, and the hook hears the call name and the worker', async () => {
  mode = 'embedder'; hookCalls.length = 0;
  const r = await call('memory.embedQuery', { task_id: 't-ship', worker_id: 'coder-1' });
  assert.strictEqual(r.queries[0].ok, false);
  assert.strictEqual(r.queries[0].code, 'E_TIMEOUT');
  assert.strictEqual(r.queries[0].cause, 'timeout');
  assert.strictEqual(r.queries[0].embedder, true);
  assert.strictEqual(r.on_embedder_failure, 'required');
  assert.strictEqual(hookCalls.length, 1);
  assert.strictEqual(hookCalls[0].call, 'memory.embedQuery');
  assert.strictEqual(hookCalls[0].worker_id, 'coder-1');
  assert.strictEqual(hookCalls[0].error.detail.embedder, true);
});

test('an error that is not an embedder failure is that query\'s entry, flagged so', async () => {
  mode = 'caller'; hookCalls.length = 0;
  const r = await call('memory.embedQuery', { task_id: 't-ship' });
  assert.strictEqual(r.queries[0].code, 'E_TOO_LONG');
  assert.strictEqual(r.queries[0].embedder, false);
  assert.strictEqual(hookCalls.length, 1, 'the hook is told of every error and decides by detail.embedder itself');
});

// A held embedder: every embed waits on a gate the test opens, then the test waits on the stub's own promises.
async function held(fn) {
  let open;
  gate = new Promise((r) => { open = r; });
  try { return await fn(); } finally { gate = null; open(); await Promise.allSettled([...running]); }
}

test('the call has its own bound: past it a query is timed out and the hook is told once, as an embedder failure, and the late embed finishes on its own', async () => {
  mode = 'ok'; hookCalls.length = 0; embedded.length = 0;
  await held(async () => {
    const r = await call('memory.embedQuery', { task_id: 't-ship', timeout_ms: 500 });
    assert.deepStrictEqual(r.queries.map((q) => [q.label, q.ok, q.code, q.timed_out]), [['task', false, 'E_EMBED_BOUND', true]]);
    assert.strictEqual(running.size, 1, 'the abandoned embed is still running in the stub');
    assert.strictEqual(r.queries[0].embedder, true);
    assert.strictEqual(hookCalls.length, 1, 'the bound is an embedder failure (ADR 0034 amendment 1): under required it pauses the run');
    assert.deepStrictEqual([hookCalls[0].call, hookCalls[0].error.code, hookCalls[0].error.detail.embedder, hookCalls[0].error.detail.cause], ['memory.embedQuery', 'E_EMBED_BOUND', true, 'timeout']);
  });
  assert.strictEqual(running.size, 0, 'the abandoned embed finished by itself');
  assert.strictEqual(hookCalls.length, 1, 'finishing late told the hook nothing more');
});

test('an embed still in flight for the same text is joined, not started again, so abandoned embeds do not pile up', async () => {
  mode = 'ok'; embedded.length = 0;
  await held(async () => {
    const a = await call('memory.embedQuery', { task_id: 't-ship', timeout_ms: 500 });
    const b = await call('memory.embedQuery', { task_id: 't-ship', timeout_ms: 500 });
    assert.ok(a.queries[0].timed_out && b.queries[0].timed_out);
    assert.strictEqual(embedded.length, 1, 'the second call joined the first call\'s embed');
  });
  // joined, the late result serves the next caller at once
  const c = await call('memory.embedQuery', { task_id: 't-ship' });
  assert.strictEqual(c.queries[0].ok, true);
});

test('no more than eight embeds are in flight: a ninth text is not started, and says why', async () => {
  mode = 'ok'; embedded.length = 0;
  await held(async () => {
    const texts = (from) => Array.from({ length: 4 }, (_, i) => `distinct query ${from + i}`);
    for (const from of [0, 4]) await call('memory.embedQuery', { extra_texts: texts(from), timeout_ms: 500 });
    assert.strictEqual(embedded.length, 8);
    const r = await call('memory.embedQuery', { extra_texts: ['one more distinct query'], timeout_ms: 500 });
    assert.strictEqual(embedded.length, 8, 'nothing new was started');
    assert.strictEqual(r.queries[0].code, 'E_EMBED_BOUND');
    assert.match(r.queries[0].message, /still running in the owner's serial embedder/);
  });
});

test('the task and four extras share one bound: each is attempted, and the task\'s text has half of it', async () => {
  mode = 'ok'; embedded.length = 0;
  await held(async () => {
    const r = await call('memory.embedQuery', { task_id: 't-ship', extra_texts: ['e one', 'e two', 'e three', 'e four'], timeout_ms: 1000 });
    assert.strictEqual(embedded.length, 5, 'every text was started: the task did not eat the bound');
    assert.deepStrictEqual(r.queries.map((q) => q.label), ['task', 'extra:1', 'extra:2', 'extra:3', 'extra:4']);
    assert.ok(r.queries.every((q) => q.code === 'E_EMBED_BOUND'));
    assert.match(r.queries[0].message, /^the [45]\d\d ms share of the 1000 ms bound/, 'the task\'s share is half');
  });
});

test('a call that hit the bound writes one embed_bound event, and status counts it for the run', async () => {
  mode = 'ok';
  fakeRun('test-run');
  const before = (await call('memory.events', { kinds: ['embed_bound'] })).events.length;
  await held(async () => { await call('memory.embedQuery', { task_id: 't-ship', extra_texts: ['bound event query'], worker_id: 'coder-9', timeout_ms: 500 }); });
  const got = (await call('memory.events', { kinds: ['embed_bound'] })).events;
  assert.strictEqual(got.length, before + 1, 'one event for the call, not one per text');
  const ev = got[got.length - 1];
  assert.deepStrictEqual([ev.ok, ev.code, ev.worker_id, ev.task_id, ev.written_by], [0, 'E_EMBED_BOUND', 'coder-9', 't-ship', 'harness']);
  assert.deepStrictEqual(JSON.parse(ev.message), { labels: ['task', 'extra:1'], bound_ms: 500 });
  const st = await call('status.get', {});
  assert.strictEqual(st.run.embed_bounds, before + 1);
  // a call that embeds in time writes nothing
  await call('memory.embedQuery', { task_id: 't-ship' });
  assert.strictEqual((await call('memory.events', { kinds: ['embed_bound'] })).events.length, before + 1);
});

// ---- the index with several vectors ---------------------------------------------------------------------------
const put = (ns, text, embedding, at) => call('memory.store', { namespace: ns, text, type: 'decision', embedding, embedding_model: 'stub', dim: 3, created_at: at }).then((r) => r.id);

test('hybrid ranking changes the order where the meaning matches and the words do not', async () => {
  mode = 'ok';
  const ns = 'embq-rank';
  const release = await put(ns, 'the procedure for getting a build to production', vecOf('release'), 1);
  const other = await put(ns, 'notes about the office plants', vecOf('plants'), 2);
  const query = 'how do we ship the software';
  // keyword only: no row shares a term with the query, so the old order stands (newest first)
  const kwOnly = await call('memory.index', { namespaces: [ns], query });
  assert.deepStrictEqual(kwOnly.row_ids, [other, release]);
  assert.strictEqual(kwOnly.relevance.semantic, 'not_requested');
  assert.strictEqual(kwOnly.relevance.semantic_contributed, false);
  const e = await call('memory.embedQuery', { task_id: 't-ship' });
  const hybrid = await call('memory.index', { namespaces: [ns], query, query_embeddings: e.queries.map((q) => ({ vector: q.query_embedding, model: q.embedding_model, label: q.label })) });
  assert.deepStrictEqual(hybrid.row_ids, [release, other]);
  assert.strictEqual(hybrid.relevance.semantic, 'ran');
  assert.strictEqual(hybrid.relevance.semantic_contributed, true);
  assert.deepStrictEqual(hybrid.relevance.semantic_lists, [{ label: 'task', matched: 1 }]);
});

test('a note found by several queries ranks above one found by a single query', async () => {
  const ns = 'embq-many';
  const both = await put(ns, 'row near both queries', [0.7, 0.7, 0], 1);
  const onlyShip = await put(ns, 'row near the ship query only', [0, 1, 0], 2);
  const onlyDates = await put(ns, 'row near the dates query only', [1, 0, 0], 3);
  const q = (vector, label) => ({ vector, model: 'stub', label });
  const r = await call('memory.index', { namespaces: [ns], query_embeddings: [q([0, 1, 0], 'ship'), q([1, 0, 0], 'dates')] });
  assert.strictEqual(r.row_ids[0], both, `${r.row_ids}`);
  assert.deepStrictEqual(r.relevance.semantic_lists, [{ label: 'ship', matched: 2 }, { label: 'dates', matched: 2 }]);
  assert.strictEqual(r.relevance.fusion.lists, 2);
  assert.ok(r.row_ids.includes(onlyShip) && r.row_ids.includes(onlyDates));
});

test('the single query_embedding is still accepted as an alias and means one list', async () => {
  const ns = 'embq-alias';
  const a = await put(ns, 'alias row a', [0, 1, 0], 1);
  await put(ns, 'alias row b', [1, 0, 0], 2);
  const r = await call('memory.index', { namespaces: [ns], query_embedding: [0, 1, 0], embedding_model: 'stub' });
  assert.strictEqual(r.row_ids[0], a);
  assert.deepStrictEqual(r.relevance.semantic_lists, [{ label: 'query', matched: 1 }]);
  const none = await call('memory.index', { namespaces: [ns], query_embedding: [0, 0, 1], embedding_model: 'stub' });
  assert.strictEqual(none.relevance.semantic_contributed, false, 'a vector no row is near contributed nothing');
});

test('hybrid is not claimed when no embedded row exists: a project with no vectors is keyword-only', async () => {
  const ns = 'embq-novec';
  await call('memory.store', { namespace: ns, text: 'plain row about shipping', type: 'decision', embed: false, created_at: 1 });
  const r = await call('memory.index', { namespaces: [ns], query: 'shipping', query_embeddings: [{ vector: [0, 1, 0], model: 'stub', label: 'task' }] });
  assert.strictEqual(r.relevance.semantic, 'ran');
  assert.strictEqual(r.relevance.semantic_contributed, false);
});

test('a vector of another model fails only its own list; all failing is named', async () => {
  const ns = 'embq-model';
  const a = await put(ns, 'model row', [0, 1, 0], 1);
  const mixed = await call('memory.index', { namespaces: [ns], query_embeddings: [{ vector: [0, 1, 0], model: 'other', label: 'bad' }, { vector: [0, 1, 0], model: 'stub', label: 'good' }] });
  assert.strictEqual(mixed.relevance.semantic, 'ran');
  assert.strictEqual(mixed.relevance.semantic_failed[0].label, 'bad');
  assert.strictEqual(mixed.row_ids[0], a);
  const all = await call('memory.index', { namespaces: [ns], query_embeddings: [{ vector: [0, 1, 0], model: 'other' }] });
  assert.strictEqual(all.relevance.semantic.code, 'E_MODEL');
});

test('query_embeddings is validated', async () => {
  const bad = (args) => assert.rejects(call('memory.index', args), (e) => e.code === 'E_ARGS');
  await bad({ query_embeddings: [] });
  await bad({ query_embeddings: 'x' });
  await bad({ query_embeddings: [{ vector: [] }] });
  await bad({ query_embeddings: [{ vector: [1, 'a'] }] });
  await bad({ query_embeddings: [{ vector: [1], label: '' }] });
  await bad({ query_embeddings: Array.from({ length: R.QUERIES_MAX + 1 }, () => ({ vector: [1] })) });
});

test('rrfMany with one list is rrf, and the semantic weight is shared among the lists', () => {
  const sem = ['a', 'b', 'c'], kw = ['c', 'a'];
  assert.deepStrictEqual(rrfMany([sem], kw, { alpha: 0.3, k: 10 }).map((h) => [h.id, h.score]), rrf(sem, kw, { alpha: 0.3, k: 10 }).map((h) => [h.id, h.score]));
  const two = rrfMany([['a', 'b'], ['b', 'c']], [], { alpha: 0.3, k: 10 });
  assert.strictEqual(two[0].id, 'b', 'ranked by both lists');
  assert.ok(Math.abs(two[0].score - (0.15 / 12 + 0.15 / 11)) < 1e-12);
  assert.deepStrictEqual(rrfMany([], ['x']).map((h) => h.id), ['x']);
});

test('the index fuses with memory.search\'s weights: alpha 0.3 and k 10', async () => {
  const ns = 'embq-fuse';
  await put(ns, 'deploy checklist for the release', vecOf('release'), 1);
  await put(ns, 'dates use the TZ zone', vecOf('dates'), 2);
  const args = { namespaces: [ns], query: 'checklist', query_embeddings: [{ vector: [0, 1, 0], model: 'stub', label: 'task' }] };
  const r = await call('memory.index', args);
  assert.deepStrictEqual(r.relevance.fusion, { method: 'rrf', alpha: HYBRID_ALPHA, k: HYBRID_K, lists: 1 });
  assert.strictEqual(HYBRID_ALPHA, 0.3);
  assert.strictEqual(HYBRID_K, 10);
  const s = await call('memory.search', { namespace: ns, query: 'checklist', query_embedding: [0, 1, 0], embedding_model: 'stub', mode: 'hybrid' });
  assert.deepStrictEqual(s.fusion, { method: 'rrf', alpha: HYBRID_ALPHA, k: HYBRID_K }, 'the same fusion as memory.search');
});

test('the run\'s memory.alpha lever reaches the index, and a run without one gets the default', async () => {
  fakeRun('run-alpha', { alpha: 0.9 });
  fakeRun('run-plain', {});
  const ns = 'embq-alpha';
  await put(ns, 'deploy checklist for the release', vecOf('release'), 1);
  const args = { namespaces: [ns], query: 'checklist', query_embeddings: [{ vector: [0, 1, 0], model: 'stub', label: 'task' }] };
  const alphaOf = async (runId) => (await call('memory.index', args, callerFor('orchestrator', { run_id: runId, channel: 'harness' }))).relevance.fusion.alpha;
  assert.strictEqual(await alphaOf('run-alpha'), 0.9);
  assert.strictEqual(await alphaOf('run-plain'), HYBRID_ALPHA);
  assert.strictEqual(await alphaOf('no-such-run'), HYBRID_ALPHA);
});

test('query_embeddings cross the pipe as base64 and arrive as the same vectors', () => {
  const { encodeWire } = core('client.cjs');
  const { decodeWire } = core('owner.cjs');
  const sent = { query: 'x', query_embeddings: [{ vector: [0.25, -1, 3.5], model: 'stub', label: 'task' }, { vector: [1, 2, 3], label: 'extra:1' }] };
  const wire = encodeWire(sent);
  assert.ok(wire.query_embeddings.every((q) => typeof q.vector_b64 === 'string' && q.vector === undefined));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(decodeWire(JSON.parse(JSON.stringify(wire))))).query_embeddings.map((q) => [q.label, q.model || null, q.vector]),
    [['task', 'stub', [0.25, -1, 3.5]], ['extra:1', null, [1, 2, 3]]]);
});

test('the task query is the spec\'s opening paragraph, up to the first blank line, and not the whole spec', async () => {
  mode = 'ok'; embedded.length = 0;
  const spec = `

Add a migration that numbers the users table
by its filename, and ship it

Constraints: do not touch the deploy scripts.
Files: db/migrate/, db/schema.sql
Acceptance: npm test exits 0`;
  rows.append(store, 'task', { id: 't-multi', run_id: 'test-run', spec, state: 'open' }, 'orchestrator');
  const r = await call('memory.embedQuery', { task_id: 't-multi', extra_texts: ['dedupe email addresses'] });
  assert.deepStrictEqual(embedded, ['Add a migration that numbers the users table by its filename, and ship it', 'dedupe email addresses']);
  assert.deepStrictEqual(r.queries.map((q) => q.label), ['task', 'extra:1']);
  // one paragraph with no blank line is itself, still cut to the cap
  rows.append(store, 'task', { id: 't-one', run_id: 'test-run', spec: `ship ${'y'.repeat(5000)}`, state: 'open' }, 'orchestrator');
  embedded.length = 0;
  await call('memory.embedQuery', { task_id: 't-one' });
  assert.strictEqual(embedded[0].length, 2048);
  const { openingParagraph } = core('methods-embed-query.cjs');
  assert.strictEqual(openingParagraph('a\r\nb\r\n\r\nc'), 'a b', 'CRLF is a line break too');
});
