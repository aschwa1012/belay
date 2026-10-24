// schema-budget.test.cjs — A5, the ADR 0010 §5 budget: the byte length of the `tools/list` result is
// at most 16,384 bytes (ADR 0010 amendment 6) for the orchestrator role and 7,168 for the worker role. Measured twice: on the
// module directly, and on what a live child actually sends over the wire, because only the second is
// what the orchestrator pays for. Every failure prints the number.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const tools = require('../../src/mcp/tools.cjs');
const { launch, sandboxDir } = require('./rpc.cjs');

const EXPECTED = {
  orchestrator: [
    'memory_store', 'memory_retrieve', 'memory_search', 'memory_timeline', 'memory_list', 'memory_delete', 'memory_stats',
    'status', 'task_list', 'briefing',
    'worker_spawn', 'worker_wait', 'worker_message', 'worker_stop', 'worker_restart', 'task_create', 'task_assign',
    'permission_list', 'permission_decide', 'task_evaluate', 'memory_verify',
  ],
  worker: [
    'memory_store', 'memory_retrieve', 'memory_search', 'memory_timeline', 'memory_list', 'memory_delete', 'memory_stats',
    'status', 'task_list', 'briefing',
    'lease_renew', 'lease_release', 'checkpoint_write',
  ],
};

test('A5 the module listing is inside the budget for both roles', () => {
  for (const role of ['orchestrator', 'worker']) {
    const bytes = tools.listingBytes(role);
    const budget = tools.BUDGET[role];
    console.log(`A5 ${role}: ${tools.toolsFor(role).length} tools, ${bytes} bytes, budget ${budget}, headroom ${budget - bytes}`);
    assert.ok(bytes <= budget, `${role} listing is ${bytes} bytes, over the ${budget} byte budget by ${bytes - budget}`);
  }
  // build step 6d, ADR 0020 decision 1: permit is never in toolsFor's own listing (hidden from the
  // model, measured); its bytes are capped separately.
  const permitBytes = tools.permitBytes();
  console.log(`6d permit: ${permitBytes} bytes, budget ${tools.BUDGET.permit}`);
  assert.ok(permitBytes <= tools.BUDGET.permit, `permit is ${permitBytes} bytes, over the ${tools.BUDGET.permit} byte budget`);
});

test('the twenty-four tools of ADR 0010 §2 as amended by ADR 0015, 0020, amendment 3 and ADR 0040 are split ten both, eleven orchestrator, three worker', () => {
  // Nineteen until ADR 0020 admitted permission_list and permission_decide, twenty-one with ADR 0040's
  // memory_timeline and memory_verify (permit itself is hidden from the model and never in this
  // listing, measured separately above).
  const names = new Set([...EXPECTED.orchestrator, ...EXPECTED.worker]);
  assert.strictEqual(names.size, 24, 'twenty-four distinct tools');
  assert.deepStrictEqual(tools.toolsFor('orchestrator').map((t) => t.name), EXPECTED.orchestrator);
  assert.deepStrictEqual(tools.toolsFor('worker').map((t) => t.name), EXPECTED.worker);
  assert.strictEqual(tools.toolsFor('orchestrator').length, 21);
  assert.strictEqual(tools.toolsFor('worker').length, 13);
  assert.strictEqual(tools.BUDGET.worker, 7168, 'ADR 0010 amendment 6 raised the worker budget to 7,168');
  assert.strictEqual(tools.BUDGET.orchestrator, 16384, 'and amendment 9 raised the orchestrator budget to 16,384');
});

test('every tool has a route into exactly one Core or RunManager method', () => {
  for (const role of ['orchestrator', 'worker']) {
    for (const t of tools.toolsFor(role)) {
      const r = tools.routeOf(t.name);
      assert.ok(r, `${t.name} has a route`);
      assert.ok(['core', 'run', 'briefing', 'compose'].includes(r.via), `${t.name} via is core, run, briefing or compose`);
      assert.ok(typeof r.method === 'string' && r.method.length > 0, `${t.name} names a method`);
      assert.ok(t.description.length > 0 && t.inputSchema.type === 'object', `${t.name} has a description and an object schema`);
    }
  }
  assert.strictEqual(tools.routeOf('status').method, 'status.get');
  assert.strictEqual(tools.routeOf('worker_stop').method, 'stop');
  assert.strictEqual(tools.routeOf('briefing').via, 'briefing');
});

test('unknown roles are refused rather than listed', () => {
  assert.throws(() => tools.toolsFor('operator'), (e) => e.code === 'E_ROLE');
  assert.throws(() => tools.toolsFor(undefined), (e) => e.code === 'E_ROLE');
});

for (const role of ['orchestrator', 'worker']) {
  test(`A5 over the wire: ${role} tools/list from a live child`, async (t) => {
    const data = sandboxDir('budget');
    const a = launch({ role, data, workerId: role === 'worker' ? 'wk-1' : undefined });
    t.after(async () => { await a.close(); a.kill(); });
    await a.initialize();
    const list = await a.list();
    const bytes = Buffer.byteLength(JSON.stringify(list), 'utf8');
    console.log(`A5 wire ${role}: ${list.length} tools, ${bytes} bytes, budget ${tools.BUDGET[role]}`);
    assert.deepStrictEqual(list.map((x) => x.name), EXPECTED[role]);
    assert.ok(bytes <= tools.BUDGET[role], `${role} wire listing is ${bytes} bytes, over the ${tools.BUDGET[role]} byte budget`);
  });
}
