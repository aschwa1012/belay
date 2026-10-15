'use strict';
// memory-off.test.cjs — on_embedder_failure `off` (ADR 0034 amendment 1): once the run memory is off, the memory methods that read or
// write rows refuse by name, memory.index answers an empty block, memory.embedQuery embeds nothing, and nothing is written; the run's
// own receipts and every non-memory method are untouched. While memory is on, nothing changes.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');

let dir, store, E, off = false, embeds = 0;
const call = (method, args) => E.handle(method, { ...args, caller: callerFor('orchestrator', { channel: 'harness' }) });
const rowCount = () => store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n;

before(() => {
  dir = sandbox();
  store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  const owner = { opts: { embedderMode: () => (off ? 'off' : 'required'), memoryOff: () => off } };
  const embedder = { embed: async () => { embeds++; return { embedding: [1, 0, 0], embedding_model: 'stub', embedding_revision: 'r', dim: 3 }; } };
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => embedder, owner, establishedBy: 'test' });
});
after(() => { store.close(); cleanup(dir); });

test('with memory on, memory works as it did', async () => {
  const r = await call('memory.store', { namespace: 'n', text: 'a row', type: 'decision' });
  assert.ok(r.id);
  assert.strictEqual(rowCount(), 1);
  assert.ok(Array.isArray((await call('memory.search', { namespace: 'n', query: 'row', mode: 'keyword' })).results));
});

test('with memory off: stores, searches and reads are refused by name, nothing is written, and receipts and other methods still work', async () => {
  off = true;
  const rowsBefore = rowCount();
  for (const [m, a] of [['memory.store', { namespace: 'n', text: 'after off' }], ['memory.search', { namespace: 'n', query: 'x', mode: 'keyword' }], ['memory.list', { namespace: 'n' }], ['memory.get', { id: 'x' }]]) {
    await assert.rejects(call(m, a), (e) => e.code === 'E_LEVER_OFF' && e.detail.lever === 'on_embedder_failure' && /memory is off for this run/.test(e.message), m);
  }
  assert.strictEqual(rowCount(), rowsBefore, 'nothing was written');
  const idx = await call('memory.index', { namespaces: ['n'], query: 'row' });
  assert.deepStrictEqual([idx.text, idx.bytes, idx.row_ids, idx.memory_off], ['', 0, [], true]);
  const ev = await call('memory.recordEvent', { kind: 'index_injected', ok: 1, worker_id: 'w1', message: '{"memory":"off"}' });
  assert.strictEqual(ev.kind, 'index_injected', 'the run records that memory is off');
  assert.ok((await call('memory.events', { kinds: ['index_injected'] })).events.length >= 1);
  assert.ok(await call('status.get', {}), 'a non-memory method is untouched');
});

test('with memory off, memory.embedQuery embeds nothing and says so', async () => {
  off = true; embeds = 0;
  const r = await call('memory.embedQuery', { extra_texts: ['a query'] });
  assert.deepStrictEqual([r.queries, r.memory_off, r.on_embedder_failure], [[], true, 'off']);
  assert.strictEqual(embeds, 0);
  off = false;
  assert.strictEqual((await call('memory.embedQuery', { extra_texts: ['a query'] })).queries.length, 1, 'and on again it embeds');
});
