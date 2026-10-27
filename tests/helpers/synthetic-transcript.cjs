'use strict';
// A generated Claude Code session transcript of about `mb` megabytes: a user line carrying a tool result, then an
// assistant line with usage, each assistant message id once, in the shape ~/.claude/projects/<cwd>/<id>.jsonl has.

const fs = require('node:fs');

function writeSyntheticTranscript(file, mb = 10) {
  const fd = fs.openSync(file, 'w');
  const result = `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'y'.repeat(3000) }] } })}\n`;
  let size = 0;
  let i = 0;
  const parts = [];
  try {
    while (size < mb * 1024 * 1024) {
      i += 1;
      const a = `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', id: `msg_${i}`, content: [{ type: 'text', text: 'x'.repeat(200) }], usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 50000 + i, output_tokens: i % 7, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 } } } })}\n`;
      parts.push(result, result, a);
      size += 2 * result.length + a.length;
      if (parts.length >= 3000) { fs.writeSync(fd, parts.join('')); parts.length = 0; }
    }
    fs.writeSync(fd, parts.join(''));
  } finally { fs.closeSync(fd); }
  return { messages: i };
}

module.exports = { writeSyntheticTranscript };
