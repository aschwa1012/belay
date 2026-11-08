'use strict';
// run-reattach-carry.test.cjs — a re-attach of a live run carries the budget record (run.setBudget) and the retrieval
// routing pin (with its warm-up records) byte for byte.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const rows = core('rows.cjs');
const { appendRun } = core('methods-run.cjs');

let dir, store, E;
const operator = callerFor('operator');
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });

before(() => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: { opts: {}, noteWrite() {} }, establishedBy: 'test' });
});
after(() => { store.close(); cleanup(dir); });

test('a re-attach of a live run keeps budget_usd, budget and retrieval_routing byte-equal', async () => {
  await call('run.attach', operator, { adapter_pid: process.pid });
  await call('run.setBudget', operator, { budget_usd: 12, budget: { events: [{ type: 'raise', usd: 12 }] } });
  const pin = JSON.stringify({ v: 1, pinned_at: 1, routing: { profile: 'fast' }, warmups: [{ id: 'm@pin', model: 'm', trigger: 'pin', state: 'ready' }] });
  appendRun(E, { ...rows.current(store, 'run', 'test-run'), retrieval_routing: pin }, 'harness');
  const before1 = rows.current(store, 'run', 'test-run');
  assert.strictEqual(before1.retrieval_routing, pin);
  assert.notStrictEqual(before1.budget, null);

  const again = await call('run.attach', operator, { adapter_pid: process.pid });
  assert.strictEqual(again.reattached, true);
  const after1 = rows.current(store, 'run', 'test-run');
  for (const col of ['budget_usd', 'budget', 'retrieval_routing']) assert.strictEqual(after1[col], before1[col], `${col} survives the re-attach`);
});
