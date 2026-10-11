'use strict';
// methods-memory-status-mutation.test.cjs — claims of methods-memory-status.cjs that a mutation run showed no
// other test pins down: the argument guards by name, an unknown id changing nothing, the verified copy
// carrying the whole row, and a failed copy's message cut at 300 bytes in the answer and in the receipt.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

let dir, store, E;
const proj = callerFor('orchestrator', { run_id: 'r-copy' });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const dbRow = (id) => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const events = () => store.p("SELECT * FROM memory_event WHERE kind = 'project_write' ORDER BY seq").all();
const total = () => store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n;

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  await call('run.attach', proj, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', project_writes: true }) });
});
after(() => { store.close(); cleanup(dir); });

test('setStatus names the field of a bad id or status, and an unknown id is E_NOT_FOUND for every status', async () => {
  const orch = callerFor('orchestrator');
  for (const id of ['', 5, null, undefined, {}]) {
    await assert.rejects(call('memory.setStatus', orch, { id, status: 'unverified' }), (e) => { assert.strictEqual(e.code, 'E_ARGS', String(id)); assert.strictEqual(e.detail.field, 'id'); return true; });
  }
  for (const status of ['bogus', undefined, 'VERIFIED']) {
    const real = await call('memory.store', orch, { text: `row for ${status}`, embed: false });
    await assert.rejects(call('memory.setStatus', orch, { id: real.id, status }), (e) => {
      assert.strictEqual(e.code, 'E_ARGS');
      assert.strictEqual(e.detail.field, 'status');
      assert.strictEqual(e.detail.value, status);
      assert.match(e.message, /unverified, verified, refuted/);
      return true;
    });
  }
  const before = total();
  for (const status of ['unverified', 'verified', 'refuted']) {
    await assert.rejects(call('memory.setStatus', orch, { id: 'no-such-row', status, receipt: 'commit:abc1234' }), (e) => {
      assert.strictEqual(e.code, 'E_NOT_FOUND', status);
      assert.deepStrictEqual(e.detail, { id: 'no-such-row' });
      assert.match(e.message, /no memory row no-such-row/);
      return true;
    });
  }
  // the row is looked up before the receipt is judged, so a missing row with a bad receipt is still not found
  await assert.rejects(call('memory.setStatus', orch, { id: 'no-such-row', status: 'verified', receipt: 'hunch:feels right' }), (e) => e.code === 'E_NOT_FOUND');
  assert.strictEqual(total(), before);
});

test('the verified copy carries the body, tags, title, type and source of the row, and the receipt names the copy', async () => {
  const src = await call('memory.store', proj, {
    text: 'the copy keeps everything', title: 'Copy title', body: { files_modified: ['a.cjs'] }, tags: ['t1', 't2'], type: 'decision', embed: false,
  });
  const out = await call('memory.setStatus', proj, { id: src.id, status: 'verified', receipt: 'test:suite passes' });
  assert.strictEqual(out.project_copy.ok, true);
  const copy = dbRow(out.project_copy.id);
  const orig = dbRow(src.id);
  assert.strictEqual(copy.namespace, 'project/acme');
  for (const col of ['text', 'title', 'body', 'tags', 'type', 'source', 'run_id', 'redactions']) assert.strictEqual(copy[col], orig[col], col);
  assert.deepStrictEqual(JSON.parse(copy.body), { files_modified: ['a.cjs'] });
  assert.strictEqual(copy.provenance, `copy-of:${src.id}`);
  assert.strictEqual(copy.status, 'verified');
  assert.strictEqual(copy.status_receipt, 'test:suite passes');
  const ev = events().filter((x) => x.key === `copy-of:${src.id}`);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].ok, 1);
  assert.strictEqual(ev[0].newest_row_id, copy.id);
  assert.deepStrictEqual(JSON.parse(ev[0].row_ids), [copy.id]);
  assert.strictEqual(ev[0].run_id, 'r-copy');
  assert.match(ev[0].message, /copied .* to project\/acme/);
});

test('a failed copy is returned and recorded with its message cut at 300 bytes, and the source stays verified', async () => {
  const src = await call('memory.store', proj, { text: 'a copy that will fail', embed: false });
  const real = store.store;
  store.store = () => { throw Object.assign(new Error('x'.repeat(500)), { code: 'E_DIM' }); };
  let out;
  try { out = await call('memory.setStatus', proj, { id: src.id, status: 'verified', receipt: 'commit:abc1234' }); } finally { store.store = real; }
  assert.strictEqual(out.status, 'verified');
  assert.strictEqual(out.project_copy.ok, false);
  assert.strictEqual(out.project_copy.code, 'E_DIM');
  assert.strictEqual(out.project_copy.message.length, 300);
  assert.strictEqual(out.project_copy.source_id, src.id);
  const ev = events().filter((x) => x.key === `copy-of:${src.id}`);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].ok, 0);
  assert.strictEqual(ev[0].code, 'E_DIM');
  assert.strictEqual(ev[0].message.length, 300);
  assert.deepStrictEqual(JSON.parse(ev[0].row_ids), [src.id]);
  assert.strictEqual(dbRow(src.id).status, 'verified');
});

test('an error with no code is recorded as E_INTERNAL, whatever it says', async () => {
  const src = await call('memory.store', proj, { text: 'a copy that fails oddly', embed: false });
  const real = store.store;
  store.store = () => { throw Object.assign(new Error('odd'), { code: 'EPERM' }); };
  let out;
  try { out = await call('memory.setStatus', proj, { id: src.id, status: 'verified', receipt: 'commit:abc1234' }); } finally { store.store = real; }
  assert.strictEqual(out.project_copy.code, 'E_INTERNAL');
  assert.strictEqual(events().filter((x) => x.key === `copy-of:${src.id}`)[0].code, 'E_INTERNAL');
});
