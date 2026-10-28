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

test('the receipt names started_at, says a wake carries the result, and points at task_list with task_ids', () => {
  const { receipt } = require('../../src/mcp/call-budget.cjs');
  const r = receipt('integrate', { task_ids: ['a', 'b'] }, 110000, 12345);
  assert.strictEqual(r.started_at, 12345);
  assert.match(r.note, /A wake will carry the result/);
  assert.match(r.note, /task_list \{ task_ids: \["a","b"\] \}/);
  assert.ok(!/integration rows/.test(r.note));
  assert.match(r.note, /a task that had earlier results keeps them/);
  assert.match(receipt('task_evaluate', { task_id: 't' }, 1000).note, /evaluated_at/);
});

test('the hooks run after the budget passes, detached before ended, and never when the call answers in time', async () => {
  const env = { MCP_TOOL_TIMEOUT: '11000' };
  const seen = [];
  const hooks = { detached: async (i) => { seen.push(['detached', i.tool, typeof i.started_at]); }, ended: async (i) => { seen.push(['ended', i.row ? 'row' : 'error']); } };
  assert.deepStrictEqual(await withinBudget('integrate', {}, Promise.resolve({ state: 'merged' }), env, hooks), { state: 'merged' });
  let finish;
  const slow = new Promise((res) => { finish = res; });
  assert.strictEqual((await withinBudget('integrate', { task_ids: ['a'] }, slow, env, hooks)).state, 'still_running');
  finish({ id: 'i1' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(seen, [['detached', 'integrate', 'number'], ['ended', 'row']]);
  let fail;
  const failing = new Promise((_, rej) => { fail = rej; });
  const broke = { detached: async () => { throw new Error('ledger down'); }, ended: async () => { throw new Error('ledger down'); } };
  assert.strictEqual((await withinBudget('task_evaluate', { task_id: 't' }, failing, env, broke)).state, 'still_running');
  fail(new Error('late'));
  await new Promise((r) => setTimeout(r, 20));
});
