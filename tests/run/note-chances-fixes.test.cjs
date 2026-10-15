'use strict';
// note-chances-fixes.test.cjs — regression tests for the review of the notes sink record, run side: a Codex release that
// failed is not a task end, the task id is captured at the trigger, what is shown is tagged with its task and stops
// being kept after the send, full search rows are marked, and the contract asks for memory_ids with the sink on.

const test = require('node:test');
const assert = require('node:assert');

const { createParser } = require('../../src/run/parsers.cjs');
const NC = require('../../src/run/note-chances.cjs');
const { contract } = require('../../src/run/notes-contract.cjs');

function codex(item) {
  const p = createParser('codex');
  return p.pushLine(JSON.stringify({ type: 'item.completed', item })).filter((e) => e.kind === 'tool_result');
}

test('S-3: a Codex MCP call that failed is an error whatever its error field says, and its answer shows nothing', () => {
  const [a] = codex({ type: 'mcp_tool_call', tool: 'lease_release', status: 'failed', error: null, result: { content: [{ type: 'text', text: '{}' }] } });
  assert.strictEqual(a.is_error, true);
  const [b] = codex({ type: 'mcp_tool_call', tool: 'lease_release', status: 'completed', result: { is_error: true } });
  assert.strictEqual(b.is_error, true);
  const [c] = codex({ type: 'mcp_tool_call', tool: 'memory_search', status: 'failed', result: { content: [{ type: 'text', text: JSON.stringify({ results: [{ id: 'm-a' }] }) }] } });
  assert.strictEqual(c.shown, undefined);
  const [ok] = codex({ type: 'mcp_tool_call', tool: 'memory_search', status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify({ results: [{ id: 'm-a', text: 'whole' }, { id: 'm-b' }] }) }] } });
  assert.deepStrictEqual(ok.shown, { route: 'search', ids: ['m-a', 'm-b'], full: ['m-a'] });
});

function harness() {
  const calls = [];
  const w = { id: 'w1', taskId: 't-1', worktree: 'C:/wt', queue: Promise.resolve(), filesTouched: new Set() };
  const ctx = { memoryLevers: { notes: true, notes_sink: 'record' }, core: { memory: { recordChances: async (a) => { calls.push(a); return {}; } } } };
  return { w, ctx, calls };
}
const shown = (ids) => ({ kind: 'tool_result', tool: 'mcp__belay__memory_search', shown: { route: 'search', ids, full: [] }, at: 5 });
const release = { kind: 'tool_result', tool: 'mcp__belay__lease_release', is_error: false, at: 9 };

test('N-1 and S-5: the task id is captured at the trigger; shown results after the send are not kept or sent for another task', async () => {
  const { w, ctx, calls } = harness();
  NC.onEvent(w, shown(['m-a']), ctx);
  NC.onEvent(w, release, ctx);
  w.taskId = 't-2'; // reassigned before the queued job runs
  await w.queue;
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].task_id, 't-1', 'recorded under the task whose release triggered it');
  assert.deepStrictEqual(calls[0].shown.map((s) => s.ids), [['m-a']]);
  w.taskId = 't-1';
  NC.onEvent(w, shown(['m-late']), ctx); // a search after the release of t-1
  assert.strictEqual((w.noteShown || []).length, 0, 'nothing more is kept for a task whose record was sent');
  w.taskId = 't-2';
  NC.onEvent(w, shown(['m-b']), ctx);
  NC.onEvent(w, release, ctx);
  await w.queue;
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual([calls[1].task_id, calls[1].shown.map((s) => s.ids)], ['t-2', [['m-b']]]);
});

test('B-1: the contract asks for memory_ids only when the sink is on', () => {
  const on = contract({ notes: true, notes_sink: 'record' });
  const off = contract({ notes: true, notes_sink: 'off' });
  assert.match(on, /`memory_ids`.*required in this run; `\[\]` when you applied none/);
  assert.ok(!/memory_ids/.test(off));
  assert.ok(on.startsWith(off), 'the sink line is appended; the rest is unchanged');
});
