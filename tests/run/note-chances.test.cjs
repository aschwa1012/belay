'use strict';
// note-chances.test.cjs — the run side of the notes sink record: the parser adds `shown` to a memory_search /
// memory_retrieve tool result, and the worker hook hands the core what the stream showed when the hand-back succeeds.

const test = require('node:test');
const assert = require('node:assert');

const { createParser } = require('../../src/run/parsers.cjs');
const SH = require('../../src/run/shown-ids.cjs');
const NC = require('../../src/run/note-chances.cjs');

const use = (id, name, input = {}) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id, body, extra = {}) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify(body) }], ...extra }] } });
function feed(lines) {
  const p = createParser('claude-code');
  return lines.flatMap((l) => p.pushLine(l)).filter((e) => e.kind === 'tool_result');
}

test('the parser names the ids a memory_search answered, in rank order, and a retrieve in the order asked', () => {
  const [s, r1, r2] = feed([
    use('t1', 'mcp__belay__memory_search', { query: 'x' }), res('t1', { results: [{ id: 'm-a' }, { id: 'm-b' }] }),
    use('t2', 'mcp__belay__memory_retrieve', { id: 'm-a' }), res('t2', { id: 'm-a', found: true }),
    use('t3', 'mcp__belay__memory_retrieve', { ids: ['m-b', 'm-z'] }), res('t3', { rows: [{ id: 'm-b', found: true }, { id: 'm-z', found: false }] }),
  ]);
  assert.deepStrictEqual(s.shown, { route: 'search', ids: ['m-a', 'm-b'], full: [] });
  assert.deepStrictEqual(r1.shown, { route: 'retrieve', ids: ['m-a'], full: [] });
  assert.deepStrictEqual(r2.shown, { route: 'retrieve', ids: ['m-b'], full: [] }, 'a row that was not found was not shown');
});

test('no shown field for other tools, an error, an unreadable answer or an empty result', () => {
  const out = feed([
    use('t1', 'Read', {}), res('t1', { results: [{ id: 'm-a' }] }),
    use('t2', 'mcp__belay__memory_search', {}), res('t2', { results: [{ id: 'm-a' }] }, { is_error: true }),
    use('t3', 'mcp__belay__memory_search', {}), JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'not json' }] } }),
    use('t4', 'mcp__belay__memory_search', {}), res('t4', { results: [] }),
  ]);
  assert.strictEqual(out.length, 4);
  assert.ok(out.every((e) => e.shown === undefined));
  assert.strictEqual(SH.attach({ tool: 'memory_search' }, undefined).shown, undefined);
});

function harness(levers) {
  const calls = [];
  const w = { id: 'w1', taskId: 't-1', worktree: 'C:/wt', queue: Promise.resolve(), filesTouched: new Set(['C:\\wt\\src\\a.cjs']), noteShown: undefined };
  const ctx = { memoryLevers: levers, core: { memory: { recordChances: async (a) => { calls.push(a); return {}; } } } };
  return { w, ctx, calls };
}
const on = { notes: true, notes_sink: 'record' };
const shown = (ids) => ({ kind: 'tool_result', tool: 'mcp__belay__memory_search', shown: { route: 'search', ids }, at: 5 });
const release = (extra = {}) => ({ kind: 'tool_result', tool: 'mcp__belay__lease_release', is_error: false, at: 9, ...extra });

test('a successful lease_release hands the core what the stream showed and the files edited, once', async () => {
  const { w, ctx, calls } = harness(on);
  NC.onEvent(w, shown(['m-a', 'm-b']), ctx);
  NC.onEvent(w, release(), ctx);
  NC.onEvent(w, release(), ctx); // the reflection turn's second release
  await w.queue;
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], { task_id: 't-1', worker_id: 'w1', shown: [{ route: 'search', ids: ['m-a', 'm-b'], full: [], at: 5 }], changed_files: ['src/a.cjs'] });
});

test('nothing is kept or sent with the sink off, on an error release, or with no task; a core failure is named, not thrown', async () => {
  for (const lv of [undefined, { notes: true, notes_sink: 'off' }, { notes: false, notes_sink: 'record' }]) {
    const { w, ctx, calls } = harness(lv);
    NC.onEvent(w, shown(['m-a']), ctx);
    NC.onEvent(w, release(), ctx);
    await w.queue;
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(w.noteShown, undefined);
  }
  const bad = harness(on);
  NC.onEvent(bad.w, release({ is_error: true }), bad.ctx);
  bad.w.taskId = null;
  NC.onEvent(bad.w, release(), bad.ctx);
  await bad.w.queue;
  assert.strictEqual(bad.calls.length, 0);
  const fail = harness(on);
  fail.ctx.core.memory.recordChances = async () => { throw Object.assign(new Error('boom'), { code: 'E_INTERNAL' }); };
  NC.onEvent(fail.w, release(), fail.ctx);
  await fail.w.queue;
  assert.deepStrictEqual(fail.w.lastError, { where: 'memory.recordChances', code: 'E_INTERNAL', message: 'boom' });
});
