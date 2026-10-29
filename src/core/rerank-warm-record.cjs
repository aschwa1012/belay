'use strict';
// rerank-warm-record.cjs — a reranker warm-up as a fact of the run (no wake, no notify text): one record per warm-up inside the run row's
// `retrieval_routing` JSON, the place the pin and the sticky fallback already live (heavy-tier.cjs), so belay status, the run receipt and the panel read
// it from the row. Owner only (a copy never writes, invariant 6); written by the owner under the harness identity, like the fallback.
//   record: { id, model, trigger: 'pin' | 'first_search' | 'child_gone' | 'retry', state: 'loading' | 'ready' | 'failed',
//             started_at, ended_at?, ms?, served_warming, error? }
// served_warming is the number of searches that kept the fusion order while this warm-up ran; it is written when the warm-up ends.
// A warm-up with no run (the caller has no run id) is kept on the owner only (retrieval-warm.cjs, E._rerankWarm).

const rows = require('./rows.cjs');

const CAP = 20; // the newest records kept on the row

// -> true when the row was written. Never throws: a background warm-up must not fail on a row that moved on.
function upsert(E, runId, rec) {
  try {
    if (!runId || !E.owner) return false;
    const HT = require('./heavy-tier.cjs');
    const run = rows.current(E.store, 'run', runId);
    const pin = HT.pinOfRow(run);
    if (!pin || run.ended_at != null) return false;
    const list = Array.isArray(pin.warmups) ? pin.warmups : [];
    const i = list.findIndex((w) => w.id === rec.id);
    if (i >= 0) list[i] = { ...list[i], ...rec }; else list.push({ ...rec });
    pin.warmups = list.slice(-CAP);
    require('./methods-run.cjs').appendRun(E, { ...run, retrieval_routing: JSON.stringify(pin) }, 'harness');
    if (E.noteWrite) E.noteWrite();
    return true;
  } catch { return false; }
}

// The records a pin-time warm-up made, in the shape above (the pin record's `warm` list holds the same models with their milliseconds).
const fromPin = (warm, now) => (Array.isArray(warm) ? warm : []).filter((w) => w.kind === 'reranker').map((w) => ({ id: `${w.model}@pin`, model: w.model, trigger: 'pin', state: 'ready', started_at: now - (w.ms || 0), ended_at: now, ms: w.ms || 0, served_warming: 0 }));

module.exports = { upsert, fromPin, CAP };
