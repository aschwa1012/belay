'use strict';
// A quote copied from the raw JSON-lines stream carries JSON string escapes; the checker compares decoded text.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { streamResultHas, selfQuoted } = require('../../src/core/memory-citations.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cite-unesc-'));
const line = (id, text) => `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } })}\n${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } })}\n`;
const file = path.join(dir, 'stream.jsonl');
fs.writeFileSync(file, line('a', '["001","002","003","004"]') + line('b', 'path C:\\tmp\\new\nsecond line\ttabbed') + line('c', 'caf\u00e9 done'));

test('a quote as decoded text is found', () => {
  assert.strictEqual(streamResultHas(file, '["001","002","003","004"]').found, true);
});
test('a quote copied with JSON escapes is found', () => {
  assert.strictEqual(streamResultHas(file, '[\\"001\\",\\"002\\",\\"003\\",\\"004\\"]').found, true);
  assert.strictEqual(streamResultHas(file, 'C:\\\\tmp\\\\new').found, true);
  assert.strictEqual(streamResultHas(file, 'second line\\ttabbed').found, true);
  assert.strictEqual(streamResultHas(file, 'caf\\u00e9 done').found, true);
});
test('a backslash quote written as is still matches', () => {
  assert.strictEqual(streamResultHas(file, 'C:\\tmp\\new').found, true);
});
test('an escaped quote that is not there is refused', () => {
  assert.strictEqual(streamResultHas(file, '[\\"001\\",\\"002\\",\\"009\\"]').found, false);
  assert.strictEqual(streamResultHas(file, 'second line\\nthird').found, false);
  assert.strictEqual(streamResultHas(file, 'caf\\u00e8 done').found, false);
});
test('results of belay tools stay no evidence in either form', () => {
  const f = path.join(dir, 'b.jsonl');
  fs.writeFileSync(f, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'mcp__belay__memory_search', input: {} }] } })}\n${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: '["a","b"]' }] }] } })}\n`);
  assert.strictEqual(streamResultHas(f, '[\\"a\\",\\"b\\"]').found, false);
});
test('the note\'s own words are caught in the decoded form too', () => {
  assert.strictEqual(selfQuoted(['the list is ["001","002"]'], 'a title', '["001",\\"002\\"]'.replace('["001",', '[\\"001\\",')), true);
  assert.strictEqual(selfQuoted(['something else'], 'a title', '[\\"001\\"]'), false);
});
