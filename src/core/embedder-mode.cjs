'use strict';
// embedder-mode.cjs — the values of `memory.on_embedder_failure` (ADR 0034 amendment 1): what a run does when the embedder fails,
// in any of the calls ADR 0034 covers (the warm-up, memory.store, memory.search, and the first-message index's query embedding).
//
//   required  embeddings are required. A failure pauses the run loudly (the run row, status, notices and receipt name the cause);
//             the operator then chooses to switch to `keyword`, to switch to `off`, or to leave it paused. The default.
//   keyword   proceed with keyword-only ranking; every failure is recorded in the receipt and in status.
//   off       memory is turned off for the run once the embedder fails: no memory index, no memory writes; recorded.
//
// `stop` is the old name of `required` and `continue` the old name of `keyword`; both are accepted and stored as the new name.
// Nothing else is accepted. Requires nothing, so core, run and cli can all use it.

const MODES = Object.freeze(['required', 'keyword', 'off']);
const ALIASES = Object.freeze({ stop: 'required', continue: 'keyword' });
const DEFAULT_MODE = 'required';
const ALLOWED = Object.freeze([...MODES, ...Object.keys(ALIASES)]);

// The canonical mode for a value, or null when it is not one of the allowed values.
function normalize(v) {
  if (typeof v !== 'string') return null;
  if (MODES.includes(v)) return v;
  return Object.prototype.hasOwnProperty.call(ALIASES, v) ? ALIASES[v] : null;
}

const describe = () => `${MODES.join(', ')} (the old values stop and continue are accepted as required and keyword)`;

module.exports = { MODES, ALIASES, ALLOWED, DEFAULT_MODE, normalize, describe };
