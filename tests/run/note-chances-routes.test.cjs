'use strict';
// note-chances-routes.test.cjs — the parser names the notes a memory_list or memory_timeline answer showed, as it does for a search or a
// retrieve, so the core can tell a writer who had read a note from one who had not.

const test = require('node:test');
const assert = require('node:assert');

const { createParser } = require('../../src/run/parsers.cjs');
const SH = require('../../src/run/shown-ids.cjs');

const use = (id, name, input = {}) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id, body, extra = {}) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify(body) }], ...extra }] } });
function feed(lines) {
  const p = createParser('claude-code');
  return lines.flatMap((l) => p.pushLine(l)).filter((e) => e.kind === 'tool_result');
}

test('a memory_list answer shows its rows, in order, and the full ones are named', () => {
  const [l] = feed([
    use('t1', 'mcp__belay__memory_list', { namespace: 'project/acme' }),
    res('t1', { data_notice: 'data', rows: [{ id: 'm-a', type: 'note', text: 'whole text' }, { id: 'm-b', type: 'note' }], total: 2 }),
  ]);
  assert.deepStrictEqual(l.shown, { route: 'list', ids: ['m-a', 'm-b'], full: ['m-a'] });
});

test('a memory_timeline answer shows its anchor and the rows around it', () => {
  const [t] = feed([
    use('t1', 'mcp__belay__memory_timeline', { anchor_id: 'm-b' }),
    res('t1', { anchor: { id: 'm-b' }, before: [{ id: 'm-a' }], after: [{ id: 'm-c' }, { id: 'm-d' }], scope: 'namespace' }),
  ]);
  assert.deepStrictEqual(t.shown, { route: 'timeline', ids: ['m-b', 'm-a', 'm-c', 'm-d'], full: [] });
});

test('an empty or unreadable list or timeline answer is no shown field, and an error is none', () => {
  const out = feed([
    use('t1', 'mcp__belay__memory_list', {}), res('t1', { rows: [] }),
    use('t2', 'mcp__belay__memory_timeline', {}), res('t2', { before: [], after: [] }),
    use('t3', 'mcp__belay__memory_list', {}), res('t3', { rows: [{ id: 'm-a' }] }, { is_error: true }),
  ]);
  assert.ok(out.every((e) => e.shown === undefined));
  assert.strictEqual(SH.toolOf('mcp__belay__memory_list'), 'list');
  assert.strictEqual(SH.toolOf('memory_timeline'), 'timeline');
  assert.strictEqual(SH.toolOf('mcp__belay__memory_stats'), null);
});
