'use strict';
// memory-report-tool.test.cjs — the orchestrator's memory_report tool: listed for the orchestrator of a notes run only, routed to memory.noteReport,
// never on a worker's listing, inside the orchestrator listing budget.

const { test } = require('node:test');
const assert = require('node:assert');
const tools = require('../../src/mcp/tools.cjs');

const bytes = (list) => Buffer.byteLength(JSON.stringify(list), 'utf8');

test('memory_report is listed for the orchestrator of a notes run, routed to memory.noteReport, and the listing stays in budget', () => {
  const on = tools.toolsFor('orchestrator', { notes: true });
  const t = on.find((x) => x.name === 'memory_report');
  assert.ok(t, 'listed with the notes lever');
  assert.deepStrictEqual(t.inputSchema.required, ['note_id', 'why']);
  assert.ok(!('by' in t.inputSchema.properties) && !('reporter' in t.inputSchema.properties), 'no argument names a reporter');
  assert.deepStrictEqual(tools.routeOf('memory_report'), { role: 'orchestrator', via: 'core', method: 'memory.noteReport' });
  const size = bytes(on);
  console.log(`orchestrator listing with notes on: ${size} bytes, budget ${tools.BUDGET.orchestrator}`);
  assert.ok(size <= tools.BUDGET.orchestrator);
});

test('memory_report is not listed with the notes lever off, nor for a worker; a worker may not call it', () => {
  assert.ok(!tools.toolsFor('orchestrator').some((x) => x.name === 'memory_report'));
  assert.ok(!tools.toolsFor('worker', { notes: true }).some((x) => x.name === 'memory_report'));
  assert.strictEqual(tools.allows('worker', 'memory_report'), false);
  assert.strictEqual(tools.allows('orchestrator', 'memory_report'), true);
});

test('memory_report arguments are checked at the boundary', () => {
  assert.throws(() => tools.validateArgs('memory_report', { why: 'x' }), (e) => e.code === 'E_ARGS');
  assert.throws(() => tools.validateArgs('memory_report', { note_id: 'n' }), (e) => e.code === 'E_ARGS');
  assert.deepStrictEqual(tools.validateArgs('memory_report', { note_id: 'n', why: 'x' }), { note_id: 'n', why: 'x' });
});
