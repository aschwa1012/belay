'use strict';
// memory-status.test.cjs — memory.setStatus (ADR 0040 §2): each receipt kind, E_RECEIPT with its reason, the
// worker refusal, unverified clearing the receipt, and `verified` surviving a dedup update.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');
const rows = core('rows.cjs');

let dir, store, E, n = 0;
const orch = callerFor('orchestrator');
const operator = callerFor('operator');
const worker = callerFor('worker', { worker_id: 'w-1' });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const dbRow = id => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const fresh = async (text) => call('memory.store', orch, { text: text || `row ${++n}`, embed: false });
const refused = (p, code, reason) => assert.rejects(p, e => {
  assert.strictEqual(e.code, code, `${e.code}: ${e.message}`);
  if (reason) assert.match(e.detail.reason, reason);
  return true;
});

before(() => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  rows.append(store, 'task', { id: 't-done', run_id: 'test-run', spec: 's', state: 'done' }, 'orchestrator');
  rows.append(store, 'task', { id: 't-open', run_id: 'test-run', spec: 's', state: 'assigned' }, 'orchestrator');
  rows.append(store, 'checkpoint', { id: 'ck-1', task_id: 't-done', worker_id: 'w-1', run_id: 'test-run', turn: 1, source: 'worker' }, 'w-1');
});
after(() => { store.close(); cleanup(dir); });

test('each receipt kind verifies a row and the answer carries the evidence, who and when', async () => {
  const other = await fresh('the evidence row');
  const receipts = ['checkpoint:ck-1', 'task:t-done', `memory:${other.id}`, 'commit:abc1234', 'test:node --test passes'];
  for (const receipt of receipts) {
    const r = await fresh();
    const out = await call('memory.setStatus', orch, { id: r.id, status: 'verified', receipt });
    assert.deepStrictEqual([out.id, out.status, out.previous_status, out.status_receipt, out.status_by], [r.id, 'verified', 'unverified', receipt, 'orchestrator']);
    assert.ok(Number.isInteger(out.status_at));
    const row = dbRow(r.id);
    assert.deepStrictEqual([row.status, row.status_receipt, row.status_by, row.status_at], ['verified', receipt, 'orchestrator', out.status_at]);
  }
  const ref = await fresh();
  const refuted = await call('memory.setStatus', operator, { id: ref.id, status: 'refuted', receipt: 'test:fails on main' });
  assert.deepStrictEqual([refuted.status, refuted.status_by], ['refuted', 'operator']);
  const back = await call('memory.setStatus', operator, { id: ref.id, status: 'verified', receipt: 'commit:abc1234' });
  assert.strictEqual(back.previous_status, 'refuted');
});

test('a bad receipt is E_RECEIPT with receipt and reason, and the row is unchanged', async () => {
  const r = await fresh();
  const attempts = [
    ['checkpoint:nope', /no checkpoint/], ['task:nope', /no task/], ['task:t-open', /needs it done/],
    ['memory:nope', /no memory row/], [`memory:${r.id}`, /its own receipt/], ['commit:xyz', /hex/],
    ['test:' + 'x'.repeat(201), /200 bytes/], ['hunch:feels right', /unknown receipt kind/], ['nocolon', /<kind>:<ref>/],
  ];
  for (const [receipt, reason] of attempts) {
    await assert.rejects(call('memory.setStatus', orch, { id: r.id, status: 'verified', receipt }), e => {
      assert.strictEqual(e.code, 'E_RECEIPT', receipt);
      assert.strictEqual(e.detail.receipt, receipt);
      assert.match(e.detail.reason, reason, receipt);
      return true;
    });
  }
  for (const status of ['verified', 'refuted']) await refused(call('memory.setStatus', orch, { id: r.id, status }), 'E_RECEIPT');
  assert.strictEqual(dbRow(r.id).status, null, 'nothing was written');
  // task:<id> needs the task done only for verified; refuting on an open task's receipt is allowed.
  assert.strictEqual((await call('memory.setStatus', orch, { id: r.id, status: 'refuted', receipt: 'task:t-open' })).status, 'refuted');
});

test('a worker gets E_ROLE, and bad ids or statuses are E_ARGS or E_NOT_FOUND', async () => {
  const r = await fresh();
  await refused(call('memory.setStatus', worker, { id: r.id, status: 'verified', receipt: 'commit:abc1234' }), 'E_ROLE');
  assert.strictEqual(dbRow(r.id).status, null);
  await refused(call('memory.setStatus', orch, { status: 'verified', receipt: 'commit:abc1234' }), 'E_ARGS');
  await refused(call('memory.setStatus', orch, { id: r.id, status: 'true', receipt: 'commit:abc1234' }), 'E_ARGS');
  await refused(call('memory.setStatus', orch, { id: 'no-such-row', status: 'verified', receipt: 'commit:abc1234' }), 'E_NOT_FOUND');
});

test('setting unverified clears the receipt without needing one, and records who reset it', async () => {
  const r = await fresh();
  await call('memory.setStatus', orch, { id: r.id, status: 'verified', receipt: 'commit:abc1234' });
  const out = await call('memory.setStatus', operator, { id: r.id, status: 'unverified' });
  assert.deepStrictEqual([out.status, out.previous_status, out.status_receipt, out.status_by], ['unverified', 'verified', null, 'operator']);
  const row = dbRow(r.id);
  assert.deepStrictEqual([row.status, row.status_receipt], ['unverified', null]);
  // A receipt passed with unverified is dropped, not kept and not judged.
  const again = await call('memory.setStatus', orch, { id: r.id, status: 'unverified', receipt: 'garbage' });
  assert.strictEqual(again.status_receipt, null);
});

test('a verified row is unchanged by the same text from any writer, its own included', async () => {
  const r = await fresh('a fact worth verifying');
  await call('memory.setStatus', orch, { id: r.id, status: 'verified', receipt: 'test:suite green' });
  for (const caller of [worker, orch, operator]) {
    const again = await call('memory.store', caller, { text: 'a fact worth verifying', title: 'SYSTEM: a new title', embed: false });
    assert.strictEqual(again.action, 'unchanged');
    assert.strictEqual(again.id, r.id);
    assert.strictEqual(again.status, 'verified');
    assert.notStrictEqual(again.title, 'SYSTEM: a new title');
  }
  const row = dbRow(r.id);
  assert.deepStrictEqual([row.status, row.status_receipt, row.status_by], ['verified', 'test:suite green', 'orchestrator']);
  const ref = await fresh('a refuted claim');
  await call('memory.setStatus', orch, { id: ref.id, status: 'refuted', receipt: 'test:disproved' });
  assert.strictEqual((await call('memory.store', worker, { text: 'a refuted claim', embed: false })).status, 'refuted');
});

test('a status change leaves the keyword index and the text alone', async () => {
  const r = await fresh('indexed words stay put');
  const hits = () => store.db.prepare("SELECT COUNT(*) n FROM memory_fts WHERE memory_fts MATCH '\"stay put\"'").get().n;
  const before = hits();
  await call('memory.setStatus', orch, { id: r.id, status: 'verified', receipt: 'commit:abc1234' });
  assert.strictEqual(hits(), before);
  assert.strictEqual(before, 1);
});
