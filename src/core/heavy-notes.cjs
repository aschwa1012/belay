'use strict';
// heavy-notes.cjs — rows written during a run reach the run's heavy tiers before the write call returns (ADR 0050 decision 4: "embedded by each
// heavy embedder as it is written"). nano has embedded them already (or the row has no vector yet); this runs in the store OWNER after ANY
// memory write method (or a hand-back) of a run whose PINNED routing has heavy embedders, so a later heavy search never meets a row it has no
// vector for (E_TIER_BEHIND would refuse every heavy search, hybrid included). It works from the rows, not from the call: the run's
// backlog under each heavy embedder (retrieval-pin.cjs scopeOf: project/<p> and run/<id>) is what is embedded, whatever the method wrote
// (a store, an import, a resolve, a scrub, a promote).
//
// ONE deadline for the whole pass (not per embedder). A failure leaves the rows in the backlog AND applies on_heavy_failure of the pinned routing:
// `fallback` records the run's fallback on its row (heavy-tier.cjs setFallback), so the next search is served on nano with `tier_fallback`;
// `pause` tells the run's hook (the ADR 0034 path) with a heavy_embed stage. The write itself has committed and is never failed or changed.

const HT = require('./heavy-tier.cjs');
const RP = require('./retrieval-profiles.cjs');

const TOTAL_BOUND_MS = 8000;
const BATCH = 16;
// Memory methods that write no row a heavy tier reads.
const SKIP = new Set(['memory.drainHeavy', 'memory.warm', 'memory.embedQuery', 'memory.recordEvent', 'memory.recordChances', 'memory.reviewClaim', 'memory.reviewRelease', 'memory.delete']);
const feeds = (method) => (method.startsWith('memory.') || method === 'lease.release') && !SKIP.has(method);

// The heavy embedders of the run's pinned routing; none after the run's fallback.
function heavyOf(E, runId) {
  const pin = HT.pinOf(E, runId);
  if (!pin || HT.fallbackOf(E, runId)) return [];
  const r = pin.routing;
  return [...new Set([r.run, ...Object.values(r.tiers || {})].map((t) => t && t.embedder).filter((id) => id && id !== RP.NANO && RP.describeModel(id) && RP.describeModel(id).runtime === 'gguf'))];
}

// -> { embedded: [{ embedder, rows }], failed: [{ embedder, code, message }] }. Never throws.
async function afterWrite(E, caller, method, boundMs = TOTAL_BOUND_MS) {
  const res = { embedded: [], failed: [] };
  try {
    if (!E.owner || !caller || !caller.run_id) return res;
    const heavy = heavyOf(E, caller.run_id);
    if (!heavy.length) return res;
    const HD = require('./heavy-drain.cjs'), EP = require('./embed-provider.cjs');
    const scope = require('./retrieval-pin.cjs').scopeOf(require('./rows.cjs').current(E.store, 'run', caller.run_id));
    let timer, timedOut = false, over = false; // `over`: the pass has been judged; abandoned work that finishes later reports nothing
    const deadline = new Promise((r) => { timer = setTimeout(() => { timedOut = true; r(); }, boundMs); });
    const work = (async () => {
      for (const id of heavy) {
        const missing = HD.backlogOf(E, id, scope);
        if (!missing.length) continue;
        try {
          const key = HD.keyOfModel(id), impl = EP.get({ embedder: id }, { owner: E.owner });
          if (!impl) throw Object.assign(new Error(`no embed provider for ${id}`), { code: 'E_NO_EMBEDDER' });
          for (let i = 0; i < missing.length && !timedOut; i += BATCH) await HD.embedIds(E, key, impl, missing.slice(i, i + BATCH).map((r) => r.id));
          if (timedOut) throw Object.assign(new Error(`the ${id} embed of ${missing.length} row${missing.length === 1 ? '' : 's'} passed its ${boundMs} ms deadline`), { code: 'E_EMBEDDER_TIMEOUT', detail: { gpu: true, cause: 'timeout' } });
          if (!over) res.embedded.push({ embedder: id, rows: missing.length });
        } catch (e) { if (!over) res.failed.push({ embedder: id, code: (e && e.code) || 'E_INTERNAL', message: (e && e.message) || String(e), cause: e && e.detail && e.detail.cause ? e.detail.cause : null }); }
      }
    })();
    try { await Promise.race([work, deadline]); } finally { clearTimeout(timer); over = true; }
    if (!res.failed.length && timedOut) res.failed.push({ embedder: heavy[0], code: 'E_EMBEDDER_TIMEOUT', message: `the heavy embed after ${method} passed its ${boundMs} ms deadline`, cause: 'timeout' });
    if (res.failed.length) policy(E, caller, method, res.failed[0], boundMs);
  } catch { /* a record, never the write's failure */ }
  return res;
}

// on_heavy_failure of the pinned routing, applied to a heavy embed that failed after a write.
function policy(E, caller, method, f, boundMs) {
  const pin = HT.pinOf(E, caller.run_id);
  const mode = pin && pin.routing && pin.routing.levers && pin.routing.levers.on_heavy_failure;
  if (mode === 'pause') {
    const { notifyEmbedderFailure } = require('./methods-memory.cjs');
    const { err, CODES } = require('./errors.cjs');
    notifyEmbedderFailure(E, caller, method, err(CODES.has(f.code) ? f.code : 'E_INTERNAL', `the ${f.embedder} embed of a note just written failed: ${f.message}`, { embedder: true, heavy: true, stage: 'heavy_embed', cause: f.cause, advised: true }));
    return;
  }
  HT.setFallback(E, caller, { code: f.code, reason: f.cause, message: `the ${f.embedder} embed after ${method} failed: ${f.message}` });
}

module.exports = { afterWrite, heavyOf, feeds, TOTAL_BOUND_MS };
