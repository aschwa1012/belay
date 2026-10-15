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

// What to tell the orchestrator (and so the operator) when a run is paused for an embedder failure. One text for every place that
// refuses or fails a call because of it (a memory call, a worker tool on a parked worker, a refused spawn).
const pauseAdvice = (runId) => `The run is paused for an embedder failure (on_embedder_failure required). Stop and ask the operator which they want: keyword (rank by keywords only), off (memory off for the run), or stay paused. Apply their choice with: belay resume ${runId || '<run>'} --embedder keyword|off, or, after the embedder is fixed, belay resume ${runId || '<run>'}.`;

// A worker is told something else: it is not the one who chooses, and it must not run belay commands.
const workerPauseAdvice = () => 'The run is paused for an embedder failure and this call was not written. Stop and wait: you will be resumed. After the resume, call it again (hand back again). Do not run belay commands.';

// The run is being ENDED (a failure no resume can fix, in a headless run): nobody is asked, and nothing is to be retried.
const endingAdvice = (code, forWorker) => `The run is ENDING because of this embedder failure (${code || 'E_MODEL_CHANGED'}), which cannot be fixed inside a run, and there is no resume. ${forWorker ? 'Stop; do not retry and do not run belay commands.' : 'Do not retry and do not spawn again; end your work and report it.'}`;

module.exports = { pauseAdvice, workerPauseAdvice, endingAdvice, MODES, ALIASES, ALLOWED, DEFAULT_MODE, normalize, describe };
