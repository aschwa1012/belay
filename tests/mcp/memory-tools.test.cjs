// memory-tools.test.cjs — ADR 0040 §4: the memory tool surface. Routes (against a fake core that echoes
// the arguments it was called with, because the real methods land separately), role allows, the
// harness-only refusals naming the field, and the listing bytes printed for both roles and kept under
// their budgets (10,240 orchestrator, 5,120 worker).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const tools = require('../../src/mcp/tools.cjs');
const { launch, sandboxDir } = require('./rpc.cjs');

const FAKE_MEMORY = path.join(__dirname, 'fake-core-memory.cjs').split('\\').join('/');

async function adapter(role, t, workerId) {
  const a = launch({
    role, data: sandboxDir(`memtools-${role}`), workerId: role === 'worker' ? (workerId || 'wk-1') : undefined,
    env: { BELAY_FAKE_CORE: FAKE_MEMORY },
  });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();
  return a;
}

const row = (r) => {
  assert.strictEqual(r.isError, false, `expected a row, got ${JSON.stringify(r.structuredContent)}`);
  return r.structuredContent;
};

test('routes: each memory tool reaches its core method with the arguments the model gave', async (t) => {
  const o = await adapter('orchestrator', t);
  const search = row(await o.call('memory_search', { query: 'pid', mode: 'hybrid', view: 'index', filter: { types: ['fact'] }, order: 'newest', offset: 5 }));
  assert.strictEqual(search.method, 'memory.search');
  assert.deepStrictEqual(search.__args, { query: 'pid', mode: 'hybrid', view: 'index', filter: { types: ['fact'] }, order: 'newest', offset: 5 });
  assert.deepStrictEqual(search.modes_run, ['hybrid']);

  const many = row(await o.call('memory_retrieve', { ids: ['m1', 'm2'] }));
  assert.strictEqual(many.method, 'memory.get', 'ids route to memory.get, which answers as get_many');
  assert.deepStrictEqual(many.__args, { ids: ['m1', 'm2'] });
  assert.strictEqual(row(await o.call('memory_retrieve', { id: 'm1' })).id, 'm1', 'a single id still answers as before');

  const tl = row(await o.call('memory_timeline', { anchor_id: 'm1', before: 2, after: 3, scope: 'task' }));
  assert.strictEqual(tl.method, 'memory.timeline');
  assert.deepStrictEqual(tl.__args, { anchor_id: 'm1', before: 2, after: 3, scope: 'task' });

  const v = row(await o.call('memory_verify', { id: 'm1', status: 'verified', receipt: 'commit:abc1234' }));
  assert.strictEqual(v.method, 'memory.setStatus');
  assert.deepStrictEqual(v.__args, { id: 'm1', status: 'verified', receipt: 'commit:abc1234' });
  assert.strictEqual(v.status_by, 'orchestrator', 'the setter is the argv role, not anything the call said');

  const st = row(await o.call('memory_store', { text: 'x', title: 'a title' }));
  assert.deepStrictEqual(st.__args, { text: 'x', title: 'a title' });
});

test('routes: a worker reaches memory_timeline and the new search arguments, as itself', async (t) => {
  const w = await adapter('worker', t, 'wk-mem');
  const tl = row(await w.call('memory_timeline', { anchor_id: 'm1' }));
  assert.strictEqual(tl.method, 'memory.timeline');
  assert.strictEqual(tl.__caller.worker_id, 'wk-mem');
  const s = row(await w.call('memory_search', { query: 'pid', mode: 'keyword' }));
  assert.deepStrictEqual(s.modes_run, ['keyword']);
});

test('role allows: memory_verify is the orchestrator\'s alone, memory_timeline is both roles\'', async (t) => {
  assert.strictEqual(tools.roleOf('memory_verify'), 'orchestrator');
  assert.strictEqual(tools.roleOf('memory_timeline'), 'both');
  assert.strictEqual(tools.allows('worker', 'memory_verify'), false);
  assert.strictEqual(tools.allows('orchestrator', 'memory_verify'), true);
  assert.strictEqual(tools.allows('worker', 'memory_timeline'), true);
  assert.strictEqual(tools.routeOf('memory_verify').method, 'memory.setStatus');
  assert.strictEqual(tools.routeOf('memory_retrieve').method, 'memory.get');
  assert.ok(!tools.toolsFor('worker').some((x) => x.name === 'memory_verify'), 'not listed for a worker');

  const w = await adapter('worker', t);
  const r = await w.call('memory_verify', { id: 'm1', status: 'verified', receipt: 'commit:abc1234' });
  assert.strictEqual(r.isError, true);
  assert.strictEqual(r.structuredContent.error, 'E_ROLE', 'a worker is refused by role before its arguments are looked at');
  const bare = await w.call('memory_verify', {});
  assert.strictEqual(bare.structuredContent.error, 'E_ROLE');
});

test('HARNESS_ONLY: memory_store refuses each harness field by name, in both roles', async (t) => {
  assert.deepStrictEqual(tools.HARNESS_ONLY.memory_store, ['task_id', 'turn', 'source', 'embed', 'body', 'worker_id']);
  const values = { task_id: 't-1', turn: 3, source: 'harness', embed: false, body: { a: 1 }, worker_id: 'w-other' };
  for (const role of ['orchestrator', 'worker']) {
    const a = await adapter(role, t);
    for (const [field, value] of Object.entries(values)) {
      const r = await a.call('memory_store', { text: 'x', [field]: value });
      assert.strictEqual(r.isError, true, `${role}: ${field} must be refused`);
      assert.strictEqual(r.structuredContent.error, 'E_ARGS');
      assert.match(r.structuredContent.message, new RegExp(`\\b${field}\\b`), `${role}: the message names ${field}`);
      assert.strictEqual(r.structuredContent.detail.field, field);
      assert.strictEqual(r.structuredContent.detail.tool, 'memory_store');
    }
    // A harness field set to null is still a harness field: the boundary does not read it as absent.
    const n = await a.call('memory_store', { text: 'x', source: null });
    assert.strictEqual(n.structuredContent.detail.field, 'source');
    // And none of them is in the schema, so the listing does not pay for them.
    const props = Object.keys(tools.schemaOf('memory_store').properties);
    for (const f of Object.keys(values)) assert.ok(!props.includes(f), `${f} is not advertised`);
  }
});

test('memory_retrieve: id or ids, not neither, not both, ids bounded and typed', () => {
  const bad = (args, re) => assert.throws(() => tools.validateArgs('memory_retrieve', args), (e) => e.code === 'E_ARGS' && re.test(e.message));
  bad({}, /needs id or ids/);
  bad({ id: 'a', ids: ['b'] }, /not both/);
  bad({ ids: [] }, /1 to 50/);
  bad({ ids: Array.from({ length: 51 }, (_, i) => `m${i}`) }, /1 to 50/);
  bad({ ids: ['a', 3] }, /ids\[1\]/);
  bad({ ids: ['a', ''] }, /ids\[1\]/);
  bad({ ids: 'a' }, /ids must be array/);
  assert.doesNotThrow(() => tools.validateArgs('memory_retrieve', { ids: Array.from({ length: 50 }, (_, i) => `m${i}`) }));
  assert.doesNotThrow(() => tools.validateArgs('memory_retrieve', { id: 'a' }));
});

test('the new arguments are typed at the boundary', () => {
  const bad = (name, args, re) => assert.throws(() => tools.validateArgs(name, args), (e) => e.code === 'E_ARGS' && re.test(e.message));
  bad('memory_search', { query: 'x', mode: 'fuzzy' }, /mode must be one of semantic, keyword, hybrid/);
  bad('memory_search', { query: 'x', view: 'brief' }, /view must be one of full, index/);
  bad('memory_search', { query: 'x', order: 'random' }, /order must be one of score, newest, oldest/);
  bad('memory_search', { query: 'x', filter: ['fact'] }, /filter must be object/);
  bad('memory_search', { query: 'x', offset: 1.5 }, /offset must be integer/);
  bad('memory_timeline', {}, /needs anchor_id/);
  bad('memory_timeline', { anchor_id: 'm', scope: 'galaxy' }, /scope must be one of task, worker, run, namespace/);
  bad('memory_timeline', { anchor_id: 'm', before: 'two' }, /before must be integer/);
  assert.doesNotThrow(() => tools.validateArgs('memory_verify', { id: 'm', status: 'unverified' }), 'setting unverified needs no receipt (ADR 0040); the core refuses verified or refuted without one');
  bad('memory_verify', { id: 'm', status: 'trusted', receipt: 'commit:abc1234' }, /status must be one of unverified, verified, refuted/);
  bad('memory_store', { text: 'x', title: 7 }, /title must be string/);
});

test('listing bytes for both roles are printed and inside the ADR 0040 §4 budgets', async (t) => {
  assert.strictEqual(tools.BUDGET.worker, 5120);
  assert.strictEqual(tools.BUDGET.orchestrator, 10240);
  for (const role of ['orchestrator', 'worker']) {
    const bytes = tools.listingBytes(role);
    console.log(`ADR 0040 §4 ${role}: ${tools.toolsFor(role).length} tools, ${bytes} bytes, budget ${tools.BUDGET[role]}, headroom ${tools.BUDGET[role] - bytes}`);
    assert.ok(bytes <= tools.BUDGET[role], `${role} listing is ${bytes} bytes, over ${tools.BUDGET[role]}`);
    // The worker was at 4,081 before this record; the orchestrator at 8,351.
    assert.ok(bytes > (role === 'worker' ? 4081 : 8351), `${role} listing grew`);
    const a = await adapter(role, t);
    const wire = Buffer.byteLength(JSON.stringify(await a.list()), 'utf8');
    console.log(`ADR 0040 §4 ${role} over the wire: ${wire} bytes`);
    assert.strictEqual(wire, bytes, 'the wire listing is the module listing');
  }
});
