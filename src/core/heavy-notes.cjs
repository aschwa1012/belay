'use strict';
// heavy-notes.cjs — a note written during a run while a heavy tier is live also gets that tier's vector (ADR 0050 decision 4: "embedded
// by each heavy embedder as it is written"). nano has already embedded it in the hand-back; this runs AFTER the hand-back committed,
// for each heavy embedder in the run's pinned routing. Best effort and bounded: a failure leaves the note in that embedder's backlog
// (derived from the rows, so nothing is lost), and the heavy tier then refuses to serve until it is drained (E_TIER_BEHIND), loudly.
// It never changes the hand-back's answer and never throws. A run with no pinned heavy embedder, or one that fell back, does nothing.

const HT = require('./heavy-tier.cjs');
const RP = require('./retrieval-profiles.cjs');

const BOUND_MS = 8000;

// The heavy embedders of the run's pinned routing, from the row (the sticky fallback leaves none).
function heavyOf(E, runId) {
  const pin = HT.pinOf(E, runId);
  if (!pin || HT.fallbackOf(E, runId)) return [];
  const r = pin.routing;
  return [...new Set([r.run, ...Object.values(r.tiers || {})].map((t) => t && t.embedder).filter((id) => id && id !== RP.NANO && RP.describeModel(id) && RP.describeModel(id).runtime === 'gguf'))];
}

// `out` is the release's answer: { notes: [{ id, state }] }. Resolves { embedded: [{ embedder, ids }], failed: [{ embedder, code, message }] }.
async function afterNotes(E, caller, out, boundMs = BOUND_MS) {
  const res = { embedded: [], failed: [] };
  try {
    const ids = out && Array.isArray(out.notes) ? out.notes.filter((n) => n && n.id && (n.state === 'stored' || n.state === 'pending') && n.embedded !== false).map((n) => n.id) : [];
    if (!ids.length || !E.owner) return res;
    const heavy = heavyOf(E, caller.run_id);
    if (!heavy.length) return res;
    const HD = require('./heavy-drain.cjs'), EP = require('./embed-provider.cjs');
    for (const id of heavy) {
      let timer;
      try {
        const key = HD.keyOfModel(id), impl = EP.get({ embedder: id }, { owner: E.owner });
        if (!impl) throw new Error(`no provider for ${id}`);
        await Promise.race([HD.embedIds(E, key, impl, ids), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`the ${id} embed took over ${boundMs} ms`)), boundMs); })]);
        res.embedded.push({ embedder: id, ids });
      } catch (e) { res.failed.push({ embedder: id, code: (e && e.code) || 'E_INTERNAL', message: (e && e.message) || String(e) }); } finally { clearTimeout(timer); }
    }
  } catch { /* a record, never the hand-back's failure */ }
  return res;
}

module.exports = { afterNotes, heavyOf, BOUND_MS };
