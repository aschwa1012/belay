'use strict';
// parser-text.cjs — the two text helpers of the stream parsers (moved out of parsers.cjs to keep it under the line budget).

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

function byteLength(v) {
  return Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v == null ? null : v), 'utf8');
}

module.exports = { textOf, byteLength };
