'use strict';
// store-reply.test.cjs — memory_store's reply explains an unverified summary and the applies_to counts, additively.

const test = require('node:test');
const assert = require('node:assert');
const { explain, UNVERIFIED, APPLIES } = require('../../src/mcp/store-reply.cjs');

test('an unverified summary row says what unverified means; no field of the row changes', () => {
  const row = { id: 'm1', type: 'summary', status: 'unverified', namespace: 'summary/tock' };
  assert.deepStrictEqual(explain('memory.store', row), { ...row, status_note: UNVERIFIED });
  assert.deepStrictEqual(explain('memory.store', { ...row, status: 'verified' }), { ...row, status: 'verified' });
});

test('a note reply with applies_to counts explains them', () => {
  const row = { id: 'n1', state: 'stored', applies_to: { total: 2, worker: 0, evidence: 0, diff: 0, dropped: 0, task_files: 0, orchestrator: 2 } };
  assert.deepStrictEqual(explain('memory.store', row), { ...row, applies_to_note: APPLIES });
  assert.match(APPLIES, /orchestrator/);
});

test('other methods and non-rows pass through', () => {
  const row = { type: 'summary', status: 'unverified' };
  assert.strictEqual(explain('memory.search', row), row);
  assert.strictEqual(explain('memory.store', null), null);
});
