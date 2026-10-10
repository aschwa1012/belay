'use strict';
// memory-write.test.cjs — the write side of ADR 0040 §2: title and body bounds, `embed: false`, the harness-only
// fields, provenance derived from the caller and the store (never the call), the added return fields, a dedup
// update that keeps what the row already is, and the stats additions. In-process Engine over a real Store.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');
const rows = core('rows.cjs');

let dir, store, E, embedCalls = 0;
const orch = callerFor('orchestrator');
const operator = callerFor('operator');
const worker = callerFor('worker', { worker_id: 'w-1' });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const rejected = (p, code, field) => assert.rejects(p, e => {
  assert.strictEqual(e.code, code, `${e.code}: ${e.message}`);
  if (field) assert.strictEqual(e.detail && e.detail.field, field);
  return true;
});
const getEmbedder = async () => { embedCalls += 1; return { embed: async () => ({ embedding: [1, 0], embedding_model: 'fake', embedding_revision: 'r', dim: 2 }) }; };
const dbRow = id => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);

before(() => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder, owner: null, establishedBy: 'test' });
});
after(() => { store.close(); cleanup(dir); });

test('a worker passing task_id, turn or source gets E_ARGS naming the field, and nothing is written', async () => {
  const before = store.count();
  for (const [k, v] of [['task_id', 't-9'], ['turn', 3], ['source', 'harness']]) {
    await rejected(call('memory.store', worker, { text: `worker ${k}`, [k]: v, embed: false }), 'E_ARGS', k);
  }
  assert.strictEqual(store.count(), before);
});

test('run_id, status and the other core-set fields are refused from every role', async () => {
  for (const caller of [worker, orch, operator]) {
    for (const k of ['run_id', 'status', 'status_by', 'redactions']) {
      await rejected(call('memory.store', caller, { text: `forge ${k}`, [k]: 'x', embed: false }), 'E_ARGS', k);
    }
  }
});

test('the run id is the caller\'s argv value, and a worker\'s task_id is derived from the one lease it holds', async () => {
  const none = await call('memory.store', worker, { text: 'worker with no lease', embed: false });
  assert.strictEqual(none.run_id, 'test-run');
  assert.strictEqual(none.task_id, null);
  assert.strictEqual(none.source, 'model');
  assert.strictEqual(none.worker_id, 'w-1');

  const lease = (task, over = {}) => rows.append(store, 'lease', {
    id: rows.newId(), task_id: task, run_id: 'test-run', holder: 'w-1', holder_role: 'worker', granted_at: Date.now(),
    expires_at: Date.now() + 60000, ttl_ms: 60000, released_at: null, ...over,
  }, 'orchestrator');
  lease('t-held');
  const held = await call('memory.store', worker, { text: 'worker holding t-held', embed: false });
  assert.strictEqual(held.task_id, 't-held');
  assert.strictEqual(dbRow(held.id).task_id, 't-held');

  lease('t-second'); // two live leases: the call names no task, so none is claimed
  const two = await call('memory.store', worker, { text: 'worker holding two', embed: false });
  assert.strictEqual(two.task_id, null);

  const rel = rows.currentLeaseForTask(store, 't-held');
  rows.append(store, 'lease', { ...rel, released_at: Date.now() }, 'worker');
  rows.append(store, 'lease', { ...rows.currentLeaseForTask(store, 't-second'), expires_at: Date.now() - 1 }, 'worker');
  const gone = await call('memory.store', worker, { text: 'worker after release and expiry', embed: false });
  assert.strictEqual(gone.task_id, null, 'a released or expired lease is not held');
});

test('the orchestrator and operator pass task_id, turn and source; source defaults by role', async () => {
  const h = await call('memory.store', orch, { text: 'harness row', embed: false, task_id: 't-5', turn: 4, source: 'harness' });
  assert.deepStrictEqual([h.task_id, h.turn, h.source], ['t-5', 4, 'harness']);
  assert.strictEqual((await call('memory.store', operator, { text: 'operator row', embed: false })).source, 'operator');
  assert.strictEqual((await call('memory.store', orch, { text: 'orchestrator row', embed: false })).source, 'model');
  await rejected(call('memory.store', orch, { text: 'bad source', embed: false, source: 'worker' }), 'E_ARGS', 'source');
  await rejected(call('memory.store', orch, { text: 'bad turn', embed: false, turn: -1 }), 'E_ARGS', 'turn');
});

test('embed: false never calls getEmbedder, stores no vector, and says so', async () => {
  const before = embedCalls;
  const r = await call('memory.store', orch, { text: 'keyword-only row', embed: false });
  assert.strictEqual(embedCalls, before);
  assert.strictEqual(r.has_embedding, false);
  assert.strictEqual(dbRow(r.id).embedding, null);
  assert.strictEqual(store.stats().unembedded >= 1, true);
  await rejected(call('memory.store', orch, { text: 'x', embed: false, embedding: [1, 0], embedding_model: 'm', dim: 2 }), 'E_ARGS', 'embed');
  await rejected(call('memory.store', orch, { text: 'x', embed: 'no' }), 'E_ARGS', 'embed');

  const embedded = await call('memory.store', orch, { text: 'default row embeds' });
  assert.strictEqual(embedCalls, before + 1);
  assert.strictEqual(embedded.has_embedding, true);
});

test('a title over 160 bytes is refused, one at 160 is kept, and a missing title reads as the derived one', async () => {
  await rejected(call('memory.store', orch, { text: 'long title', title: 'x'.repeat(161), embed: false }), 'E_ARGS', 'title');
  await rejected(call('memory.store', orch, { text: 'multibyte title', title: 'é'.repeat(81), embed: false }), 'E_ARGS', 'title');
  const ok = await call('memory.store', orch, { text: 'title at the bound', title: 'x'.repeat(160), embed: false });
  assert.strictEqual(ok.title.length, 160);
  const spaced = await call('memory.store', orch, { text: 'one line title', title: '  a\n  b\t c ', embed: false });
  assert.strictEqual(spaced.title, 'a b c');
  const derived = await call('memory.store', orch, { text: '\n\nfirst real line\nsecond', embed: false });
  assert.strictEqual(derived.title, 'first real line');
  assert.strictEqual(dbRow(derived.id).title, null, 'the derived title is never written back');
});

test('body must be an object of at most 8,192 bytes once serialised, and is stored as JSON', async () => {
  await rejected(call('memory.store', orch, { text: 'array body', body: [1], embed: false }), 'E_ARGS', 'body');
  await rejected(call('memory.store', orch, { text: 'huge body', body: { a: 'x'.repeat(8200) }, embed: false }), 'E_ARGS', 'body');
  const r = await call('memory.store', orch, { text: 'structured', body: { v: 1, files: ['a.cjs'] }, embed: false });
  assert.deepStrictEqual(JSON.parse(dbRow(r.id).body), { v: 1, files: ['a.cjs'] });
});

test('the return adds status, title, run_id, task_id and redactions', async () => {
  const r = await call('memory.store', orch, { text: 'shape check', embed: false });
  for (const k of ['status', 'title', 'run_id', 'task_id', 'redactions']) assert.ok(k in r, k);
  assert.deepStrictEqual([r.status, r.title, r.run_id, r.task_id, r.redactions], ['unverified', 'shape check', 'test-run', null, null]);
});

test('a dedup update refreshes title and body but not status or provenance; verified survives', async () => {
  const first = await call('memory.store', orch, { text: 'dedup subject', embed: false, source: 'harness', task_id: 't-1' });
  store.setStatus(first.id, { status: 'verified', receipt: 'commit:abcdef1', by: 'operator', at: Date.now() });
  const again = await call('memory.store', worker, { text: 'dedup subject', title: 'now titled', body: { k: 1 }, embed: false });
  assert.strictEqual(again.action, 'updated');
  assert.strictEqual(again.id, first.id);
  assert.strictEqual(again.status, 'verified');
  assert.strictEqual(again.title, 'now titled');
  const row = dbRow(first.id);
  assert.deepStrictEqual([row.status, row.status_receipt, row.source, row.task_id], ['verified', 'commit:abcdef1', 'harness', 't-1']);
  assert.deepStrictEqual(JSON.parse(row.body), { k: 1 });
});

test('memory.stats adds by_type, by_status, unembedded and the fts fact', async () => {
  const s = await call('memory.stats', orch);
  assert.ok(s.by_type.fact >= 1);
  assert.strictEqual(typeof s.by_status.unverified, 'number');
  assert.ok(s.by_status.verified >= 1);
  assert.strictEqual(typeof s.unembedded, 'number');
  assert.deepStrictEqual(Object.keys(s.fts), ['present', 'version', 'rows']);
  assert.strictEqual(s.fts.present, true, 'a stamped store carries the keyword index');
  assert.strictEqual(s.fts.version, '1');
  assert.strictEqual(s.fts.rows, s.n);
});

test('stats on a store with no keyword index says so and creates nothing', () => {
  const d = sandbox();
  const plain = new Store(`${d}/memory.db`); // not stamped: an unmigrated store, as a copy is
  try {
    const s = plain.stats();
    assert.deepStrictEqual(s.fts, { present: false, version: null, rows: null });
    assert.strictEqual(plain.p("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'memory_fts'").get().n, 0);
  } finally { plain.close(); cleanup(d); }
});
