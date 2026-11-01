'use strict';
// A write lost after it was sent: the owner may already have committed it, so it is not re-run (ADR 0033). Positive evidence only:
// the client says it was sent (E_OWNER_LOST { sent: true }) or that it may have committed (E_TIMEOUT { may_have_committed: true }).
const sentUnknown = (e) => {
  const d = e && e.detail;
  return !!d && (d.sent === true || d.may_have_committed === true || d.outcome === 'unknown');
};

// The token columns of a usage row, from the turn's snapshot.
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
function tokensOf(snap) {
  const u = snap.usage;
  if (!u) return {};
  if (snap.substrate === 'codex') {
    return { input_tokens: Math.max(0, num(u.input_tokens) - num(u.cached_input_tokens)), output_tokens: num(u.output_tokens), cache_read_tokens: num(u.cached_input_tokens), cache_creation_tokens: 0 };
  }
  return { input_tokens: num(u.input_tokens), output_tokens: num(u.output_tokens), cache_read_tokens: num(u.cache_read_input_tokens), cache_creation_tokens: num(u.cache_creation_input_tokens) };
}
module.exports = { sentUnknown, tokensOf };
