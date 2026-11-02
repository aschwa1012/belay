'use strict';
// heavy-notes.cjs — rows a method wrote during a run reach the run's heavy tiers before the call returns (ADR 0050 decision 4: "embedded by each
// heavy embedder as it is written"). nano has embedded them already (or the row has no vector yet); this runs in the store OWNER after a memory write
// method (or a hand-back) of a run whose PINNED routing has heavy embedders, so a later heavy search does not meet a row it has no vector for.
//   - It embeds only the rows THIS call wrote: the rows of the run's scope (retrieval-pin.cjs scopeOf) created or changed since the call began,
//     that lack the embedder's vector. A method that wrote no row (a status change, a read-like write) costs one small query and no embed.
//   - ONE deadline for the whole pass (not per embedder), and one pass in flight per run (a concurrent write waits its turn; rows an earlier pass
//     embedded are skipped). Reaching the deadline is NOT a failure: whatever is left is the background catch-up's (heavy-behind.cjs).
//   - A real error (an error, a dead child, a failed load) is a heavy failure: the rows stay in the backlog AND on_heavy_failure of the pinned
//     routing applies. `fallback` records the run's fallback on its row (heavy-tier.cjs setFallback); `pause` tells the run hook (the ADR 0034 path)
//     with a heavy_embed stage. The write has committed and is never failed or changed.

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

// The ids of the run's scope created or changed since `t0` (the call began).
function touchedSince(E, scope, t0) {
  return E.store.db.prepare("SELECT id, type, namespace FROM memory_entries WHERE namespace IN (SELECT value FROM json_each(?)) AND (created_at >= ? OR updated_at >= ?)").all(JSON.stringify(scope), t0, t0).filter(((x) => (r) => !x(r))(require('./memory-search-scope.cjs').heavyExemptFn(E))).map((r) => r.id);
}

const scopeOfRun = (E, runId) => require('./retrieval-pin.cjs').scopeOf(require('./rows.cjs').current(E.store, 'run', runId));

// -> { embedded: [{ embedder, rows }], failed: [{ embedder, code, message, cause }], deadline: bool, settled: Promise }. Never throws.
// `settled` resolves when the pass's own work has finished, even after a deadline (a test seam).
async function afterWrite(E, caller, method, boundMs = TOTAL_BOUND_MS, t0 = Date.now()) {
  const res = { embedded: [], failed: [], deadline: false, settled: Promise.resolve() };
  try {
    if (!E.owner || !caller || !caller.run_id) return res;
    if (!heavyOf(E, caller.run_id).length) return res;
    const flights = E._heavyFlights || (E._heavyFlights = new Map());
    const before = flights.get(caller.run_id) || Promise.resolve();
    let release;
    flights.set(caller.run_id, new Promise((r) => { release = r; }));
    const started = Date.now();
    let timer, over = false;
    const deadline = new Promise((r) => { timer = setTimeout(() => { res.deadline = true; r(); }, Math.max(1, boundMs)); });
    const work = (async () => {
      try {
        await Promise.race([before, deadline]); // one pass in flight per run
        if (res.deadline) return;
        const heavy = heavyOf(E, caller.run_id); // read again: an earlier pass may have fallen back
        if (!heavy.length) return;
        const HD = require('./heavy-drain.cjs'), EP = require('./embed-provider.cjs'), MV = require('./memory-vectors.cjs');
        const touched = touchedSince(E, scopeOfRun(E, caller.run_id), t0);
        if (!touched.length) return; // the method wrote no row
        for (const id of heavy) {
          if (res.deadline) return;
          try {
            const key = HD.keyOfModel(id);
            const have = MV.vectorsFor(E.store.db, { model: key.model, revision: key.revision, dims: key.dims }, touched);
            const ids = touched.filter((x) => !have.has(x));
            if (!ids.length) continue;
            const impl = EP.get({ embedder: id }, { owner: E.owner });
            if (!impl) throw Object.assign(new Error(`no embed provider for ${id}`), { code: 'E_NO_EMBEDDER' });
            for (let i = 0; i < ids.length && !res.deadline; i += BATCH) await HD.embedIds(E, key, impl, ids.slice(i, i + BATCH), { deadline: started + boundMs });
            if (!over && !res.deadline) res.embedded.push({ embedder: id, rows: ids.length });
          } catch (e) { if (!over) res.failed.push({ embedder: id, code: (e && e.code) || 'E_INTERNAL', message: (e && e.message) || String(e), cause: e && e.detail && e.detail.cause ? e.detail.cause : null }); }
        }
      } finally { release(); }
    })();
    res.settled = work.catch(() => {});
    try { await Promise.race([work, deadline]); } finally { clearTimeout(timer); over = true; }
    if (res.failed.length) { if (!(E.owner && E.owner.stopped)) policy(E, caller, method, res.failed[0]); } // a stopping owner closed the provider: not a heavy failure, no pause and no sticky fallback; the rows stay in the backlog for the next owner
    else if (res.deadline && E.owner && !E.owner.stopped) { // not a failure: the rest is the background catch-up's
      const HB = require('./heavy-behind.cjs'), scope = scopeOfRun(E, caller.run_id);
      for (const id of heavyOf(E, caller.run_id)) HB.startCatchUp(E, caller, id, scope);
    }
  } catch { /* a record, never the write's failure */ }
  return res;
}

// on_heavy_failure of the pinned routing, applied to a heavy embed that really failed (after a write, or in a background catch-up).
function policy(E, caller, method, f) {
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

module.exports = { afterWrite, policy, heavyOf, feeds, TOTAL_BOUND_MS };
