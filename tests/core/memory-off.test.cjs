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

let dir, store, E, ending = false, off = false, mode = 'required', failEmbed = false, embeds = 0;
const call = (method, args) => E.handle(method, { ...args, caller: callerFor('orchestrator', { channel: 'harness' }) });
const rowCount = () => store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n;

before(() => {
  dir = sandbox();
  store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  const owner = { opts: { embedderMode: () => (off ? 'off' : mode), memoryOff: () => off, runEnding: () => ending } };
  const embedder = { embed: async () => { embeds++; if (failEmbed) throw Object.assign(new Error('embedder down'), { code: 'E_MODEL_ABSENT', detail: { embedder: true, cause: 'dead' } }); return { embedding: [1, 0, 0], embedding_model: 'stub', embedding_revision: 'r', dim: 3 }; } };
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

// ---- hand-back under the modes -----------------------------------------------------------------------------------------

const RUN = 'r-hand';
const orch = callerFor('orchestrator', { run_id: RUN });
const worker = callerFor('worker', { run_id: RUN, worker_id: 'wh' });
const wcall = (method, args) => E.handle(method, { ...args, caller: worker });
const note = (marker) => ({ kind: 'lesson', title: `the ${marker} loader skips unlisted fixtures`, when: `add a ${marker} test fixture`, basis: 'observed', evidence: [{ where: `src/${marker}.js`, saw: 'never read' }], applies_to: [`src/${marker}.js`], subjects: [marker] });
const noteRows = () => store.p("SELECT COUNT(*) AS n FROM memory_entries WHERE type = 'note'").get().n;
let seq = 0;
async function newLease() {
  const t = await E.handle('task.create', { caller: orch, spec: `job ${++seq}` });
  const a = await E.handle('task.assign', { caller: orch, task_id: t.id, worker_id: 'wh' });
  return { lease_id: a.new_lease.id, task_id: t.id };
}

test('hand-back setup', async () => {
  off = false; mode = 'required'; failEmbed = false;
  await E.handle('run.attach', { caller: orch, adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  await E.handle('worker.write', { caller: orch, id: 'wh', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-wh', last_event_at: Date.now(), model: 'claude-test-1' });
});

test('under off a release drops its notes, says so, and still releases the lease', async () => {
  const l = await newLease(), before = noteRows();
  off = true;
  try {
    const out = await wcall('lease.release', { lease_id: l.lease_id, notes: [note('K1'), note('K2')], reported_wrong: [] });
    assert.strictEqual(out.state, 'released');
    assert.deepStrictEqual([out.notes_dropped.notes, out.notes_dropped.reported_wrong], [2, 0]);
    assert.match(out.notes_dropped.reason, /memory is off/);
    assert.ok(!('notes' in out), 'no note was written');
    assert.strictEqual(noteRows(), before);
    assert.strictEqual((await E.handle('task.get', { caller: orch, task_id: l.task_id })).state, 'released');
    // a second call on the released lease only drops again; the release is not rewritten
    const again = await wcall('lease.release', { lease_id: l.lease_id, notes: [note('K3')] });
    assert.strictEqual(again.notes_dropped.notes, 1);
    assert.strictEqual(noteRows(), before);
  } finally { off = false; }
});

test('under off memory.delete is refused by name', async () => {
  const r = await call('memory.store', { namespace: 'n', text: 'to delete', type: 'decision' });
  off = true;
  try { await assert.rejects(call('memory.delete', { id: r.id }), (e) => e.code === 'E_LEVER_OFF'); }
  finally { off = false; }
  assert.ok(store.p('SELECT 1 AS x FROM memory_entries WHERE id = ?').get(r.id), 'the row is still there');
});

test('under keyword a release whose notes cannot be embedded stores them without a vector and releases the lease', async () => {
  const l = await newLease();
  mode = 'keyword'; failEmbed = true;
  try {
    const out = await wcall('lease.release', { lease_id: l.lease_id, notes: [note('K4'), note('K5')] });
    assert.strictEqual(out.state, 'released');
    assert.strictEqual(out.notes.length, 2);
    for (const n of out.notes) {
      assert.strictEqual(n.embedded, false);
      assert.strictEqual(n.embedder_failure.code, 'E_MODEL_ABSENT');
      assert.strictEqual(store.p('SELECT embedding IS NULL AS nul FROM memory_entries WHERE id = ?').get(n.id).nul, 1);
    }
    const found = await call('memory.search', { namespace: 'project/acme', query: 'loader', mode: 'keyword', view: 'index' });
    assert.ok(found.results.length >= 2, 'found by keyword search');
  } finally { mode = 'required'; failEmbed = false; }
});

test('under required a release whose notes cannot be embedded still fails whole and holds the lease', async () => {
  const l = await newLease();
  failEmbed = true;
  try { await assert.rejects(wcall('lease.release', { lease_id: l.lease_id, notes: [note('K6')] }), (e) => e.code === 'E_MODEL_ABSENT'); }
  finally { failEmbed = false; }
  assert.strictEqual((await E.handle('task.get', { caller: orch, task_id: l.task_id })).state, 'assigned');
  // after the resume (the embedder works again) the same hand-back goes through: the work is not lost
  const again = await wcall('lease.release', { lease_id: l.lease_id, notes: [note('K6')] });
  assert.strictEqual(again.state, 'released');
  assert.strictEqual(again.notes.length, 1);
});

test('a copy-fallback engine (no owner) enforces off through the run process test', async () => {
  const copy = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'copy', memoryOffFn: () => off });
  off = true;
  try {
    await assert.rejects(copy.handle('memory.search', { caller: orch, namespace: 'n', query: 'x', mode: 'keyword' }), (e) => e.code === 'E_LEVER_OFF');
    await assert.rejects(copy.handle('memory.list', { caller: orch, namespace: 'n' }), (e) => e.code === 'E_LEVER_OFF');
  } finally { off = false; }
  await copy.handle('memory.list', { caller: orch, namespace: 'n' }); // and with memory on again it answers
});

test('under required an embedder failure names the choices and the resume command to the orchestrator, another text to a worker, the ending to both when the run is ending; under keyword nothing', async () => {
  failEmbed = true;
  try {
    mode = 'required';
    await assert.rejects(call('memory.store', { namespace: 'n', text: 'needs a vector' }), (e) => e.code === 'E_MODEL_ABSENT'
      && /paused for an embedder failure/.test(e.message) && /keyword \(rank by keywords only\), off \(memory off for the run\), or stay paused/.test(e.message)
      && /belay resume \S+ --embedder keyword\|off/.test(e.message));
    await assert.rejects(wcall('memory.store', { namespace: 'project/acme', text: 'a worker write' }), (e) => /paused for an embedder failure and this call was not written/.test(e.message)
      && /call it again/.test(e.message) && /Do not run belay commands/.test(e.message) && !/belay resume/.test(e.message) && !/ask the operator/i.test(e.message));
    ending = true;
    await assert.rejects(call('memory.store', { namespace: 'n', text: 'orchestrator while ending' }), (e) => /ENDING/.test(e.message) && !/paused for/.test(e.message) && !/belay resume/.test(e.message) && !/ask the operator/i.test(e.message));
    await assert.rejects(wcall('memory.store', { namespace: 'project/acme', text: 'worker while ending' }), (e) => /ENDING/.test(e.message) && !/belay resume/.test(e.message));
    ending = false;
    mode = 'keyword';
    await assert.rejects(call('memory.store', { namespace: 'n', text: 'needs a vector too' }), (e) => !/belay resume|ENDING|embedder failure and this call/.test(e.message));
  } finally { mode = 'required'; failEmbed = false; ending = false; }
});
