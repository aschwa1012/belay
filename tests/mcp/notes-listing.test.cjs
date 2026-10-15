// notes-listing.test.cjs — ADR 0047 decisions 3 and 4: a worker adapter launched with --notes lists lease_release with
// `notes` required in its schema and memory_note_resolve, inside the worker budget; without the flag the listing is the
// one it always was. The orchestrator's listing does not change.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const tools = require('../../src/mcp/tools.cjs');
const { launch, sandboxDir, runArgv, BIN } = require('./rpc.cjs');

const bytes = (list) => Buffer.byteLength(JSON.stringify(list), 'utf8');

test('without the flag the worker and orchestrator listings are byte-identical to what they were', () => {
  assert.strictEqual(tools.listingBytes('worker'), 4965);
  assert.strictEqual(tools.listingBytes('orchestrator'), 9936);
  assert.deepStrictEqual(tools.toolsFor('worker', { notes: false }), tools.toolsFor('worker'));
  assert.deepStrictEqual(tools.toolsFor('orchestrator', { notes: true }).slice(0, -2), tools.toolsFor('orchestrator'), 'the orchestrator is given memory_summaries and memory_note_refutation only (summaries-listing.test.cjs)');
});

test('with notes on the worker listing fits its 7,168 byte budget, every ordinary tool still listed, and carries the schema', () => {
  const list = tools.toolsFor('worker', { notes: true });
  const b = bytes(list);
  console.log(`worker listing, notes on: ${list.length} tools, ${b} bytes, budget ${tools.BUDGET.worker}, headroom ${tools.BUDGET.worker - b} (off: ${tools.listingBytes('worker')})`);
  assert.ok(b <= tools.BUDGET.worker, `${b} bytes is over the ${tools.BUDGET.worker} byte budget`);
  const lr = list.find((t) => t.name === 'lease_release');
  assert.deepStrictEqual(lr.inputSchema.required, ['lease_id', 'notes']);
  assert.strictEqual(lr.inputSchema.properties.notes.type, 'array');
  assert.deepStrictEqual(lr.inputSchema.properties.notes.items.properties.basis.enum, ['observed', 'inferred', 'relayed']);
  assert.deepStrictEqual(lr.inputSchema.properties.notes.items.properties.kind.enum, ['lesson', 'flag', 'recurring', 'gotcha']);
  assert.deepStrictEqual(lr.inputSchema.properties.notes.items.required, ['kind', 'title', 'basis']);
  assert.ok(lr.inputSchema.properties.reported_wrong, 'reported_wrong is in the schema');
  assert.deepStrictEqual(lr.inputSchema.properties.reported_wrong.items.properties.replaced_by.type, ['string', 'null'], 'replaced_by is nullable');
  assert.ok(list.find((t) => t.name === 'memory_note_resolve').inputSchema.properties.resolutions.items.properties.title, 'resolve new takes a changed title');
  assert.ok(list.some((t) => t.name === 'memory_note_resolve'));
  for (const kept of ['memory_store', 'memory_search', 'memory_retrieve', 'memory_timeline', 'lease_renew', 'checkpoint_write', 'briefing']) assert.ok(list.some((t) => t.name === kept), kept);
  // ADR 0010 amendment 6: no tool is unlisted in a notes run; the notes listing is the ordinary one plus memory_note_resolve and memory_summaries
  const ordinary = tools.toolsFor('worker').map((t) => t.name);
  assert.deepStrictEqual(list.map((t) => t.name), [...ordinary, 'memory_note_resolve', 'memory_summaries']);
  assert.ok(tools.listingBytes('worker', { notes: true }) > tools.listingBytes('worker'));
});

test('the knowledge agent\'s listing ignores notes', () => {
  assert.deepStrictEqual(tools.toolsFor('worker', { workerId: 'knowledge-r1', notes: true }), tools.toolsFor('worker', { workerId: 'knowledge-r1' }));
});

test('validateArgs: with notes on, lease_release without notes is E_ARGS naming it, [] passes; without the flag nothing changes', () => {
  assert.throws(() => tools.validateArgs('lease_release', { lease_id: 'l' }, { notes: true }), (e) => e.code === 'E_ARGS' && e.detail.missing === 'notes');
  assert.doesNotThrow(() => tools.validateArgs('lease_release', { lease_id: 'l', notes: [] }, { notes: true }));
  assert.throws(() => tools.validateArgs('lease_release', { lease_id: 'l', notes: 'x' }, { notes: true }), (e) => e.code === 'E_ARGS');
  assert.doesNotThrow(() => tools.validateArgs('lease_release', { lease_id: 'l' }));
  assert.throws(() => tools.validateArgs('memory_note_resolve', {}), (e) => e.detail.missing === 'resolutions');
  assert.strictEqual(tools.routeOf('memory_note_resolve').method, 'memory.noteResolve');
  assert.strictEqual(tools.allows('worker', 'memory_note_resolve'), true);
  assert.strictEqual(tools.allows('orchestrator', 'memory_note_resolve'), false);
});

test('over the wire: --notes lists the notes schema, no flag does not, and the orchestrator refuses the flag', async () => {
  const on = launch({ role: 'worker', workerId: 'w1', data: sandboxDir('nl-on'), extra: ['--notes'] });
  const off = launch({ role: 'worker', workerId: 'w1', data: sandboxDir('nl-off') });
  try {
    await on.initialize(); await off.initialize();
    const a = await on.list(); const b = await off.list();
    assert.deepStrictEqual(a, tools.toolsFor('worker', { notes: true }));
    assert.deepStrictEqual(b, tools.toolsFor('worker'));
    const missing = await on.call('lease_release', { lease_id: 'l' });
    assert.strictEqual(missing.structuredContent.error, 'E_ARGS');
    assert.match(missing.structuredContent.message, /needs notes/);
    const ok = await on.call('lease_release', { lease_id: 'l', notes: [] });
    assert.strictEqual(ok.isError, false, JSON.stringify(ok));
    const plain = await off.call('lease_release', { lease_id: 'l' });
    assert.strictEqual(plain.isError, false, 'no flag, no requirement');
  } finally { await on.close(); await off.close(); }
  const r = await runArgv(['--role', 'orchestrator', '--run', 'r1', '--data', sandboxDir('nl-orch'), '--notes']);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /--notes is a worker adapter/);
  assert.ok(BIN);
});
