// summaries-listing.test.cjs — ADR 0047 decision 1 and ADR 0010 amendment 6: memory_summaries is listed for the orchestrator and
// the workers of a notes run, with knowledge_ask too, inside the 11,264 and 7,168 byte budgets; with the lever off the
// listings are those of a run without notes (4,815 and 9,870, the latter counting worker_spawn's agent_type). Every combination is measured on the module and on the wire.
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
  assert.strictEqual(bytes(off), 10502); // 9,900 before ADR 0054 git_read; 9,829 before the paired write/search contract
  assert.deepStrictEqual(on.map((t) => t.name).slice(-3), ['memory_summaries', 'memory_note_refutation', 'memory_report']);
  assert.ok(bytes(on) <= tools.BUDGET.orchestrator);
  // memory_verify is unlisted and memory_store states a note (notes-listing.test.cjs)
  assert.deepStrictEqual(on.slice(0, -3).map((t) => t.name), off.filter((t) => t.name !== 'memory_verify').map((t) => t.name));
  assert.deepStrictEqual(on.slice(0, -3).filter((t) => t.name !== 'memory_store'), off.filter((t) => t.name !== 'memory_verify' && t.name !== 'memory_store'));
});

test('notes and knowledge_ask together list both tools, inside the budget', () => {
  const both = tools.toolsFor('orchestrator', { notes: true, knowledge: true });
  assert.ok(bytes(both) <= tools.BUDGET.orchestrator, `${bytes(both)} bytes`);
  assert.ok(both.some((t) => t.name === 'memory_summaries') && both.some((t) => t.name === 'knowledge_ask'));
});

test('a worker lists memory_summaries in a notes run only, and the route and the role allow the call', () => {
  assert.ok(!tools.toolsFor('worker').some((t) => t.name === 'memory_summaries'));
  assert.ok(tools.toolsFor('worker', { notes: true }).some((t) => t.name === 'memory_summaries'));
  assert.ok(!tools.toolsFor('worker', { workerId: 'knowledge-r1', notes: true }).some((t) => t.name === 'memory_summaries'), 'the knowledge agent keeps its read tools only');
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

test('every combination, measured on the module and on the wire, is inside its budget; lever off is byte-identical to before', async () => {
  const run = async (levers, role = 'orchestrator', extra = []) => {
    const data = sandboxDir('sl2');
    fs.writeFileSync(`${data}/memory.db`, '');
    const a = launch({ role, workerId: role === 'worker' ? 'w1' : undefined, data, extra, env: { BELAY_FAKE_CORE: FAKE, ...(levers ? { BELAY_FAKE_LEVERS: levers } : {}) } });
    try { await a.initialize(); return await a.list(); } finally { await a.close(); }
  };
  const N = JSON.stringify({ notes: true, project: 'p' });
  const NK = JSON.stringify({ notes: true, knowledge_agent: true, project: 'p' });
  const rows = [
    ['worker, notes off', tools.toolsFor('worker'), await run(undefined, 'worker'), 'worker'],
    ['worker, notes on', tools.toolsFor('worker', { notes: true }), await run(N, 'worker', ['--notes']), 'worker'],
    ['orchestrator, notes off', tools.toolsFor('orchestrator'), await run(undefined), 'orchestrator'],
    ['orchestrator, notes on', tools.toolsFor('orchestrator', { notes: true }), await run(N), 'orchestrator'],
    ['orchestrator, knowledge_ask', tools.toolsFor('orchestrator', { knowledge: true }), await run(JSON.stringify({ knowledge_agent: true })), 'orchestrator'],
    ['orchestrator, notes on and knowledge_ask', tools.toolsFor('orchestrator', { notes: true, knowledge: true }), await run(NK), 'orchestrator'],
  ];
  for (const [name, mod, wire, role] of rows) {
    console.log(`${name}: module ${bytes(mod)} bytes, wire ${bytes(wire)} bytes, budget ${tools.BUDGET[role]}`);
    assert.deepStrictEqual(wire, mod, name);
    assert.ok(bytes(wire) <= tools.BUDGET[role], name);
  }
  assert.strictEqual(bytes(rows[0][2]), 4815); // 4,965 before the paired write/search contract
  assert.strictEqual(bytes(rows[2][2]), 10502);
});
