'use strict';
require('../helpers/tmp.cjs');
// call-budget.cjs — the still_running receipt promises a wake only after the call_detached ledger write landed (invariant 5).
const test = require('node:test');
const assert = require('node:assert');
const { withinBudget } = require('../../src/mcp/call-budget.cjs');

const env = { MCP_TOOL_TIMEOUT: '11000' }; // budget 1000 ms
const tick = () => new Promise((r) => setImmediate(r));

test('a detached write that stalls and then fails: the receipt waits for it, then says no wake will follow, and no ended event follows', async () => {
  const order = [];
  let failWrite;
  const hooks = {
    detachedWriteMs: 60000,
    detached: () => { order.push('write-started'); return new Promise((_, rej) => { failWrite = () => { order.push('write-failed'); rej(new Error('ledger down')); }; }); },
    ended: async () => { order.push('ended'); },
  };
  let finish;
  const slow = new Promise((res) => { finish = res; });
  const answer = withinBudget('integrate', { task_ids: ['a'] }, slow, env, hooks).then((r) => { order.push('receipt'); return r; });
  while (!failWrite) await tick();
  await tick();
  assert.deepStrictEqual(order, ['write-started'], 'the receipt has not resolved while the write is pending');
  failWrite();
  const r = await answer;
  assert.deepStrictEqual(order, ['write-started', 'write-failed', 'receipt']);
  assert.strictEqual(r.state, 'still_running');
  assert.strictEqual(r.wake, false);
  assert.match(r.note, /No wake will follow/);
  assert.match(r.note, /task_list \{ task_ids: \["a"\] \}/);
  assert.ok(!/A wake will carry/.test(r.note));
  finish({ id: 'i1' });
  await tick();
  await tick();
  assert.ok(!order.includes('ended'), 'no ended event follows a detached write that failed');
});

test('a detached write that never answers: the bound passes and the receipt promises nothing', async () => {
  const hooks = { detachedWriteMs: 20, detached: () => new Promise(() => {}), ended: async () => {} };
  const r = await withinBudget('task_evaluate', { task_id: 't' }, new Promise(() => {}), env, hooks);
  assert.strictEqual(r.state, 'still_running');
  assert.strictEqual(r.wake, false);
  assert.match(r.note, /No wake will follow/);
});

test('a detached write that landed: the wake is promised, after the write', async () => {
  const seen = [];
  const hooks = { detached: async () => { seen.push('write'); }, ended: async () => {} };
  const r = await withinBudget('integrate', { task_ids: ['a'] }, new Promise(() => {}), env, hooks);
  assert.deepStrictEqual(seen, ['write']);
  assert.strictEqual(r.wake, undefined);
  assert.match(r.note, /A wake will carry the result/);
});
