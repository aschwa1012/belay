'use strict';
// shown-ids.cjs — the memory ids a worker's memory_search or memory_retrieve call returned, read from the tool result
// the stream carried. The parser adds them to the tool_result event as `shown: { route, ids }` (nothing else changes), so
// the run manager can tell the core at task end which notes this worker was shown. Pure: no I/O, never throws, and an
// answer it cannot read is no `shown` field at all (a missing fact, not a guess).

const ID_MAX = 200;

const toolOf = (name) => {
  const n = String(name || '');
  if (/(^|__)memory_search$/.test(n)) return 'search';
  if (/(^|__)memory_retrieve$/.test(n)) return 'retrieve';
  return null;
};

// An MCP result's content (a string, a list of { text } blocks, or an object) as the JSON object the tool answered.
function bodyOf(content) {
  let c = content;
  if (c && typeof c === 'object' && !Array.isArray(c) && c.structuredContent) return c.structuredContent;
  if (c && typeof c === 'object' && !Array.isArray(c) && Array.isArray(c.content)) c = c.content;
  if (Array.isArray(c)) c = c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('');
  if (c && typeof c === 'object') return c;
  if (typeof c !== 'string') return null;
  try { return JSON.parse(c); } catch { return null; }
}

// memory_search answers { results: [{ id }] } in rank order; memory_retrieve answers one row { id, found } or
// { rows: [{ id, found }] } in the order asked. A row with found false was not shown.
function idsOf(route, b) {
  if (!b || typeof b !== 'object') return null;
  let list;
  if (route === 'search') list = b.results;
  else list = Array.isArray(b.rows) ? b.rows : [b];
  if (!Array.isArray(list)) return null;
  return list.filter((r) => r && typeof r.id === 'string' && r.found !== false).map((r) => r.id).slice(0, ID_MAX);
}

// Returns `f` itself (with `shown` added when the call was a search or retrieve that answered).
function attach(f, content) {
  const route = toolOf(f.tool);
  if (!route || f.is_error) return f;
  const ids = idsOf(route, bodyOf(content));
  if (ids && ids.length) f.shown = { route, ids };
  return f;
}

module.exports = { attach, toolOf };
