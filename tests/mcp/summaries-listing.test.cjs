// summaries-listing.test.cjs — ADR 0047 decision 1: memory_summaries is listed for the orchestrator of a notes run, inside the
// 10 KB budget; with the lever off the listing is the one it always was; a worker does not list it (its 5 KB budget
// has no room); with knowledge_ask also listed it would not fit, and is left out rather than the budget raised.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const tools = require('../../src/mcp/tools.cjs');
const { launch, sandboxDir, ROOT } = require('./rpc.cjs');

const FAKE = `${ROOT}/tests/mcp/fake-core-knowledge.cjs`;
const bytes = (list) => Buffer.byteLength(JSON.stringify(list), 'utf8');

async function listing(levers, role = 'orchestrator') {
  const data = sandboxDir('sl');
  fs.writeFileSync(`${data}/memory.db`, '');
  const a = launch({ role, workerId: role === 'worker' ? 'w1' : undefined, data, env: { BELAY_FAKE_CORE: FAKE, ...(levers ? { BELAY_FAKE_LEVERS: levers } : {}) } });
  try { await a.initialize(); return await a.list(); } finally { await a.close(); }
}

test('notes on: the orchestrator lists memory_summaries inside the budget; off, the listing is unchanged', () => {
  const off = tools.toolsFor('orchestrator');
  const on = tools.toolsFor('orchestrator', { notes: true });
  console.log(`orchestrator listing: off ${bytes(off)}, notes on ${bytes(on)}, budget ${tools.BUDGET.orchestrator}`);
  assert.strictEqual(bytes(off), 9696);
  assert.deepStrictEqual(on.map((t) => t.name).slice(-1), ['memory_summaries']);
  assert.ok(bytes(on) <= tools.BUDGET.orchestrator);
  assert.deepStrictEqual(on.slice(0, -1), off);
});

test('notes and knowledge_ask together do not fit, so the summaries tool is the one left out', () => {
  const both = tools.toolsFor('orchestrator', { notes: true, knowledge: true });
  assert.ok(bytes(both) <= tools.BUDGET.orchestrator);
  assert.ok(!both.some((t) => t.name === 'memory_summaries'));
  assert.ok(both.some((t) => t.name === 'knowledge_ask'));
});

test('a worker never lists memory_summaries, notes or not, but the route and the role allow the call', () => {
  for (const notes of [false, true]) assert.ok(!tools.toolsFor('worker', { notes }).some((t) => t.name === 'memory_summaries'));
  assert.strictEqual(tools.routeOf('memory_summaries').method, 'memory.summaries');
  assert.strictEqual(tools.allows('worker', 'memory_summaries'), true);
  assert.strictEqual(tools.allows('orchestrator', 'memory_summaries'), true);
  assert.ok(tools.listingBytes('worker', { notes: true }) <= tools.BUDGET.worker);
});

test('over the wire: the notes lever in the run row lists the tool, once, and no lever does not', async () => {
  const on = await listing(JSON.stringify({ notes: true, project: 'p' }));
  assert.deepStrictEqual(on, tools.toolsFor('orchestrator', { notes: true }));
  const off = await listing(JSON.stringify({ rules: true }));
  assert.deepStrictEqual(off, tools.toolsFor('orchestrator'));
  const none = await listing(undefined);
  assert.deepStrictEqual(none, tools.toolsFor('orchestrator'));
  const w = await listing(JSON.stringify({ notes: true, project: 'p' }), 'worker');
  assert.deepStrictEqual(w, tools.toolsFor('worker'), 'a worker adapter without --notes lists the ordinary tools');
});
