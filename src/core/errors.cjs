'use strict';
// errors.cjs — the one error type the Core API rejects with (api.md §1, §6). Every rejection carries a
// code from the list below and a message that is a sentence naming the reason; `detail` carries ids.
// Never a bare status word, never a result and an error together.

const CODES = new Set([
  'E_ARGS', 'E_ROLE', 'E_NOT_FOUND', 'E_NOT_HOLDER', 'E_LEASE_EXPIRED', 'E_NO_LEASE',
  'E_OPERATOR_HOLDS', 'E_WORKER_NOT_LIVE', 'E_WORKER_LIVE', 'E_FILES_OVERLAP', 'E_RUN_NOT_LIVE', 'E_DEPENDENCY_OPEN',
  'E_DEPENDENCY_CYCLE', 'E_TASK_DONE', 'E_NO_READY', 'E_SUBSTRATE',
  'E_NO_OWNER', 'E_OWNER_LOST', 'E_LOCKED', 'E_NO_EMBEDDER', 'E_TOO_LONG', 'E_MODEL',
  'E_MODEL_ABSENT', 'E_MODEL_CHANGED', 'E_DIM', 'E_VEC', 'E_SUPERSEDES',
  'E_NAMESPACE_TOO_LARGE', 'E_TIMEOUT', 'E_INTERNAL', 'E_PAUSED', 'E_BUSY', 'E_FIX_ROUNDS', 'E_SCHEMA_NEWER',
  'E_EMBEDDER_TIMEOUT', 'E_EMBED_BOUND', 'E_SEMANTIC_REQUIRED', 'E_INDEX_BOUND', 'E_SHUTDOWN',
  // ADR 0040 to 0043 (memory architecture)
  'E_NO_INDEX', 'E_QUERY_SHORT', 'E_RECEIPT', 'E_SUMMARISER_ABSENT', 'E_SUMMARY_EMPTY', 'E_SUMMARY_MALFORMED',
  'E_SUMMARY_REFUSED', 'E_SUMMARY_OVER_BUDGET', 'E_LEVER_OFF', 'E_EXISTS',
  // ADR 0047: a note whose shape is refused (never truncated)
  'E_NOTE_SHAPE',
  // wave 4 and the notes lifecycle: an unverifiable citation, a job over its cost cap, out of scope, a failed fact precondition, a ground that is not allowed
  'E_CITATION', 'E_COST_CAP', 'E_SCOPE', 'E_PRECONDITION', 'E_GROUND',
  // a write that would change a held note's visibility or status, from a caller that is neither the operator nor the archive review's cited outcome
  'E_HELD',
  // ADR 0045: a write with no bound identity on an owner that serves only bound callers, and a bind that cannot be opened or claimed
  'E_UNBOUND', 'E_BIND',
]);

class CoreError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'CoreError';
    // An unlisted code is itself a defect; surface it rather than silently normalising it away.
    this.code = CODES.has(code) ? code : 'E_INTERNAL';
    if (this.code !== code) this.message = `${message} (raised with unlisted code ${code})`;
    if (detail !== undefined) this.detail = detail;
  }
}

const err = (code, message, detail) => new CoreError(code, message, detail);

// Transport failures are the only errors a read may swallow before falling back to copy-then-read
// (api.md §1, ADR 0005 §4). A refusal the owner computed is an answer and must reach the caller.
const TRANSPORT_CODES = new Set(['E_NO_OWNER', 'E_OWNER_LOST', 'E_TIMEOUT']);
const isTransport = e => !!e && TRANSPORT_CODES.has(e.code);

module.exports = { CoreError, err, CODES, isTransport };
