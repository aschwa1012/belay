'use strict';
// The lifecycle stream cite (scrub, archive review) searches the same thing a note review does: the decoded text of the
// non-belay tool results of a stream, never its JSON structure.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkCitations } = require('../../src/core/memory-citations.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cite-life-'));
const use = (id, name) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
const result = (id, text) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
const file = path.join(dir, 'stream.jsonl').split('\\').join('/');
fs.writeFileSync(file, [
  use('a', 'Bash'), result('a', 'build ok: said "hi" exit 0'),
  use('b', 'mcp__belay__memory_search'), result('b', 'belay result only'),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'the writer said widgets are fine' }] } }),
].join('\n') + '\n');

const run = (quote, ctx = {}) => checkCitations([{ where: `stream:${file}`, quote }], { evidence_files: [file], ...ctx });
const refused = async (quote, ctx) => assert.rejects(() => run(quote, ctx), e => e.code === 'E_CITATION');

test('a quote of the stream\'s JSON structure is refused', async () => {
  for (const q of ['}', '"type":"user"', 'tool_use_id', '"type":"tool_result"']) await refused(q);
});
test('a real tool result line is accepted', async () => {
  assert.deepStrictEqual(await run('build ok'), [{ where: `stream:${file}`, source: 'stream' }]);
});
test('an escaped quote that exists is accepted, one that does not is refused', async () => {
  await run('said \\"hi\\"');
  await refused('said \\"yo\\"');
});
test('the writer\'s own assistant text is refused', async () => {
  await refused('widgets are fine');
});
test('a belay tool result is refused', async () => {
  await refused('belay result only');
});
test('the note\'s own words are refused', async () => {
  await refused('build ok', { own: ['build ok: it passed'] });
});
