'use strict';
// envelope.cjs — the MCP tool-result envelope of the stdio adapter (ADR 0010 §6), moved out of belay-mcp.cjs unchanged: a
// core row becomes a `structuredContent` result with the same JSON as text, and an error becomes `isError: true` with a code
// from the core's own vocabulary. Pure, and it loads nothing on a read path the adapter did not already load.

const text = (v) => ({ type: 'text', text: JSON.stringify(v) });

function okResult(row) {
  // Every row passes through unchanged. MCP requires structuredContent to be an object; the contract
  // returns an object from every method, so the guard below should never fire.
  const structured = require('./compose.cjs').revOf((row !== null && typeof row === 'object' && !Array.isArray(row)) ? row : { result: row }); // seq is named rev (ADR 0058)
  return { content: [text(structured)], structuredContent: structured, isError: false };
}

// api.md §6. A code from this set passes through unchanged; anything else (a MODULE_NOT_FOUND, a
// TypeError) becomes E_INTERNAL, because the orchestrator is entitled to a code it can act on and the
// contract names the whole vocabulary. The set is the core's own, not a copy of it: a hand-kept copy
// here silently downgraded E_DEPENDENCY_OPEN to E_INTERNAL the day the core gained it, and A4 was the
// thing that caught it. `errors.cjs` imports nothing, so this costs the read path nothing (api.md §4).
const { CODES } = require('../core/errors.cjs');

function errResult(e) {
  const original = e && e.code;
  const code = CODES.has(original) ? original : 'E_INTERNAL';
  const body = { error: code, message: e && e.message ? e.message : String(e) };
  const mapped = code === 'E_INTERNAL' && original && original !== 'E_INTERNAL';
  if (mapped) {
    // The original code is the only thing that says what actually went wrong, so it survives every
    // branch: with no detail, with an object detail whose own fields are kept beside it, and with a
    // scalar or array detail, which is nested under `detail` because it has no fields to merge into.
    // `underlying_code` is written last so a detail carrying that name cannot displace the truth.
    const d = e && e.detail;
    const carried = d !== undefined && d !== null && typeof d === 'object' && !Array.isArray(d)
      ? d
      : (d !== undefined ? { detail: d } : {});
    body.detail = { ...carried, underlying_code: original };
  } else if (e && e.detail !== undefined) {
    body.detail = e.detail;
  }
  return { content: [text(body)], structuredContent: body, isError: true };
}

module.exports = { okResult, errResult };
