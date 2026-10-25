// notes-listing.test.cjs — ADR 0047 decisions 3 and 4: a worker adapter launched with --notes lists lease_release with
// `notes` required in its schema and memory_note_resolve, inside the worker budget; without the flag the listing is the
// one it always was. The orchestrator's listing does not change.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const tools = require('../../src/mcp/tools.cjs');
const { launch, sandboxDir, runArgv, BIN } = require('./rpc.cjs');

const bytes = (list) => Buffer.byteLength(JSON.stringify(list), 'utf8');

test('without the flag the worker and orchestrator listings are what the notes contract left them', () => {
  // 4,965 and 9,829 before the paired write/search contract: its search guidance and memory_queries were added, and other descriptions trimmed to keep the notes-on worker listing 500 bytes inside its budget.
  assert.strictEqual(tools.listingBytes('worker'), 4842);
  assert.strictEqual(tools.listingBytes('orchestrator'), 13822); // 13,728 before ADR 0060, 13,360 before the compact task views, 13,321 before ADR 0059, 9,900 before ADR 0053 and ADR 0054
  assert.deepStrictEqual(tools.toolsFor('worker', { notes: false }), tools.toolsFor('worker'));
  // A notes run lists memory_store with the note's fields and not memory_verify, then memory_summaries, memory_note_refutation and memory_report (summaries-listing.test.cjs).
  const ordinary = tools.toolsFor('orchestrator').filter((t) => t.name !== 'memory_verify');
  assert.deepStrictEqual(tools.toolsFor('orchestrator', { notes: true }).slice(0, -3).map((t) => t.name), ordinary.map((t) => t.name));
  assert.deepStrictEqual(tools.toolsFor('orchestrator', { notes: true }).slice(0, -3).filter((t) => t.name !== 'memory_store'), ordinary.filter((t) => t.name !== 'memory_store'));
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
  assert.deepStrictEqual(lr.inputSchema.properties.notes.items.required, ['kind', 'title', 'when', 'basis']);
  assert.ok(lr.inputSchema.properties.notes.items.properties.when, 'when is in the schema');
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

test('the notes schema lists applies_to as an optional field (the worker\'s route to an unchanged file the note is about), and the notes-on worker listing is inside its budget', () => {
  const list = tools.toolsFor('worker', { notes: true });
  const items = list.find((t) => t.name === 'lease_release').inputSchema.properties.notes.items;
  assert.strictEqual(items.properties.applies_to.type, 'array');
  assert.ok(!items.required.includes('applies_to'));
  // The project memory_store states a note's fields (ADR 0047 amendment of 2026-10-22), so the listing is within the ADR 0010 amendment 6 budget and no longer 500 bytes inside it.
  assert.ok(bytes(list) <= tools.BUDGET.worker, `${bytes(list)} bytes`);
  assert.match(tools.toolsFor('orchestrator', { queries: true }).find((t) => t.name === 'worker_spawn').inputSchema.properties.memory_queries.description, /^Up to 4 task lines/);
});

test('over the wire: the orchestrator of a notes run lists no memory_verify and a call to it is E_ROLE naming memory_report; with notes off it is routed', async () => {
  const fs = require('node:fs');
  const FAKE = `${require('./rpc.cjs').ROOT}/tests/mcp/fake-core-knowledge.cjs`;
  const run = async (levers) => {
    const data = sandboxDir('nl-verify');
    fs.writeFileSync(`${data}/memory.db`, '');
    const a = launch({ data, env: { BELAY_FAKE_CORE: FAKE, BELAY_FAKE_LEVERS: levers } });
    try {
      await a.initialize();
      const list = await a.list();
      const res = await a.call('memory_verify', { id: 'n1', status: 'refuted', receipt: 'test:x' });
      return { names: list.map((t) => t.name), res };
    } finally { await a.close(); }
  };
  const on = await run(JSON.stringify({ project: 'acme', notes: true }));
  assert.ok(!on.names.includes('memory_verify') && on.names.includes('memory_report'));
  assert.strictEqual(on.res.isError, true);
  assert.match(JSON.stringify(on.res), /E_ROLE/);
  assert.match(JSON.stringify(on.res), /memory_report/);
  const off = await run(JSON.stringify({ project: 'acme', notes: false }));
  assert.ok(off.names.includes('memory_verify'));
  assert.doesNotMatch(JSON.stringify(off.res), /dispute a note with memory_report/);
});
