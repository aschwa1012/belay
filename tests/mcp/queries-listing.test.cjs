// queries-listing.test.cjs — the orchestrator's worker_spawn lists `memory_queries` only when the run's first_message_index lever is
// on (they feed that index and nothing else); the call is accepted either way. Measured on the module and on the wire.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const tools = require('../../src/mcp/tools.cjs');
const { launch, sandboxDir, ROOT } = require('./rpc.cjs');

const FAKE = `${ROOT}/tests/mcp/fake-core-knowledge.cjs`;
const spawnOf = (list) => list.find((t) => t.name === 'worker_spawn');
const hasQueries = (list) => Object.prototype.hasOwnProperty.call(spawnOf(list).inputSchema.properties, 'memory_queries');

async function wireListing(levers) {
  const data = sandboxDir('ql');
  fs.writeFileSync(`${data}/memory.db`, '');
  const a = launch({ role: 'orchestrator', data, env: { BELAY_FAKE_CORE: FAKE, ...(levers ? { BELAY_FAKE_LEVERS: levers } : {}) } });
  try { await a.initialize(); return await a.list(); } finally { await a.close(); }
}

test('module: the field is off the listing by default and on with queries, and nothing else differs', () => {
  const off = tools.toolsFor('orchestrator'), on = tools.toolsFor('orchestrator', { queries: true });
  assert.strictEqual(hasQueries(off), false);
  assert.strictEqual(hasQueries(on), true);
  assert.deepStrictEqual(off.filter((t) => t.name !== 'worker_spawn'), on.filter((t) => t.name !== 'worker_spawn'));
  const { memory_queries, ...rest } = spawnOf(on).inputSchema.properties;
  assert.ok(memory_queries);
  assert.deepStrictEqual(spawnOf(off).inputSchema.properties, rest, 'the other properties keep their order and text');
  assert.deepStrictEqual(spawnOf(off).inputSchema.required, spawnOf(on).inputSchema.required);
  assert.ok(tools.listingBytes('orchestrator', { queries: true }) - tools.listingBytes('orchestrator') > 100);
  assert.ok(tools.listingBytes('orchestrator', { notes: true, knowledge: true, queries: true }) <= tools.BUDGET.orchestrator, 'everything on is inside the budget');
  assert.strictEqual(hasQueries(tools.toolsFor('orchestrator', { notes: true })), false, 'the notes lever alone does not list it');
});

test('a worker_spawn call that carries memory_queries is accepted when the field is not listed', () => {
  assert.doesNotThrow(() => tools.validateArgs('worker_spawn', { substrate: 'claude-code', worktree: '/w', prompt: 'p', memory_queries: ['a task line'] }));
  assert.throws(() => tools.validateArgs('worker_spawn', { substrate: 'claude-code', worktree: '/w', prompt: 'p', memory_queries: 'not a list' }), (e) => e.code === 'E_ARGS');
});

test('over the wire: no levers and a run without the index do not list it, first_message_index does', async () => {
  assert.strictEqual(hasQueries(await wireListing(null)), false);
  assert.strictEqual(hasQueries(await wireListing(JSON.stringify({ project: 'p', notes: true }))), false);
  const on = await wireListing(JSON.stringify({ project: 'p', notes: false, first_message_index: true }));
  assert.strictEqual(hasQueries(on), true);
  assert.deepStrictEqual(on, tools.toolsFor('orchestrator', { queries: true }));
});

test('the gate answers from the adapter\'s own run row once attached, and from the run row it reads before that', async () => {
  const { createKnowledgeGate } = require('../../src/mcp/knowledge-gate.cjs');
  const noop = () => {};
  const row = (levers) => ({ memory_levers: JSON.stringify(levers) });
  const attached = createKnowledgeGate({ role: 'orchestrator', runId: 'r1', storeExists: () => false, openCore: async () => { throw new Error('no read once attached'); }, log: noop, attachedRun: () => row({ project: 'p', first_message_index: true }) });
  await attached();
  assert.strictEqual(attached.queries(), true);
  const attachedOff = createKnowledgeGate({ role: 'orchestrator', runId: 'r1', storeExists: () => false, openCore: async () => { throw new Error('no read'); }, log: noop, attachedRun: () => row({ project: 'p' }) });
  await attachedOff();
  assert.strictEqual(attachedOff.queries(), false);
  const unread = createKnowledgeGate({ role: 'orchestrator', runId: 'r1', storeExists: () => false, openCore: async () => { throw new Error('no store'); }, log: noop });
  await unread();
  assert.strictEqual(unread.queries(), false, 'no store, no field');
});
