'use strict';
require('../helpers/tmp.cjs');
// call-budget.cjs — integrate and task_evaluate answer before the client's tool timeout, and the work is not cancelled.
const test = require('node:test');
const assert = require('node:assert');
const { withinBudget, budgetFor } = require('../../src/mcp/call-budget.cjs');

test('the budget is the client timeout less 10 s, for the two long tools only, and none without MCP_TOOL_TIMEOUT', () => {
  assert.strictEqual(budgetFor('integrate', { MCP_TOOL_TIMEOUT: '120000' }), 110000);
  assert.strictEqual(budgetFor('task_evaluate', { MCP_TOOL_TIMEOUT: '120000' }), 110000);
  assert.strictEqual(budgetFor('task_list', { MCP_TOOL_TIMEOUT: '120000' }), null);
  assert.strictEqual(budgetFor('integrate', {}), null);
  assert.strictEqual(budgetFor('integrate', { MCP_TOOL_TIMEOUT: '1.5e3' }), null);
  assert.strictEqual(budgetFor('integrate', { MCP_TOOL_TIMEOUT: '5000' }), 1000);
});

test('a call past the budget answers still_running while it carries on, and a call inside it answers itself', async () => {
  const env = { MCP_TOOL_TIMEOUT: '11000' }; // budget 1000 ms
  let finish;
  const slow = new Promise((res) => { finish = res; });
  const early = await withinBudget('integrate', { task_ids: ['a'] }, slow, env);
  assert.strictEqual(early.state, 'still_running');
  assert.strictEqual(early.tool, 'integrate');
  assert.match(early.note, /not cancelled/);
  finish({ state: 'merged' });
  assert.deepStrictEqual(await slow, { state: 'merged' });
  assert.deepStrictEqual(await withinBudget('integrate', {}, Promise.resolve({ state: 'merged' }), env), { state: 'merged' });
  const failing = Promise.reject(new Error('late'));
  await assert.rejects(withinBudget('integrate', {}, failing, env), /late/);
});

test('a failure after the early answer is not an unhandled rejection', async () => {
  let fail;
  const slow = new Promise((_, rej) => { fail = rej; });
  const early = await withinBudget('task_evaluate', { task_id: 't' }, slow, { MCP_TOOL_TIMEOUT: '11000' });
  assert.strictEqual(early.state, 'still_running');
  fail(new Error('late'));
  await new Promise((r) => setImmediate(r));
});
