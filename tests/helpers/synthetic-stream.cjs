'use strict';
// A generated orchestrator stream shaped like a real run's: assistant text, tool calls and their
// results, about 1.7 KB per line, so tests that parse or tail a long stream do not need a recording.

const fs = require('node:fs');

const TS = '2026-10-04T10:00:00.000Z';
const L = (o) => `${JSON.stringify(o)}\n`;
const FILLER = 'The worker reported progress on the task and the orchestrator is checking the next step. '.repeat(18);

function lines(count = 242) {
  const out = [L({ type: 'system', subtype: 'init', session_id: 'synthetic-session', model: 'claude-opus-5-5', tools: ['Read', 'Bash'] })];
  let i = 0;
  while (out.length < count - 1) {
    i += 1;
    const id = `toolu_${String(i).padStart(4, '0')}`;
    out.push(L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Step ${i}. ${FILLER}` }], usage: { input_tokens: 1 } }, parent_tool_use_id: null, timestamp: TS }));
    if (out.length >= count - 1) break;
    out.push(L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `src/file-${i}.cjs` } }], usage: { input_tokens: 1 } }, parent_tool_use_id: null, timestamp: TS }));
    if (out.length >= count - 1) break;
    out.push(L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `contents of file ${i}. ${FILLER}` }] }, parent_tool_use_id: null, timestamp: TS }));
  }
  out.push(L({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'synthetic-session', num_turns: i }));
  return out;
}

function writeSyntheticStream(file, count) {
  fs.writeFileSync(file, lines(count).join(''));
}

module.exports = { writeSyntheticStream, lines };
