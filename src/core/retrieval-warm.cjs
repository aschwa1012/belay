'use strict';
// retrieval-warm.cjs — warm-up of a pinned routing's models, at pin time (ADR 0050 decisions 5 and 6). The first rerank of a run must not
// pay a cold model load inside the 10 s rerank bound, and the first heavy query must not pay the GPU load inside a search. After the probe
// and before the run's first prompt, every distinct reranker (CPU or GPU) and heavy embedder of the routing is loaded here through its own
// provider, by one tiny real call. Owner only (the providers are built there). A failure names the model and is handled by the caller as a
// probe refusal is (on_heavy_failure).

const RP = require('./retrieval-profiles.cjs');

const WARM_BOUND_MS = 300000; // a cold 4B load with a first Vulkan shader build is long; the load has its own wall clock

const tiersOf = (r) => [r.run, ...Object.values(r.tiers)];

// -> { ok: true, models: [{ model, kind, ms }] } or { ok: false, model, kind, code, message, models }. Never throws.
async function warmUp(E, routing, onStep) {
  const RPV = require('./rerank-provider.cjs'), EP = require('./embed-provider.cjs');
  const rerankers = [...new Set(tiersOf(routing).map((t) => t.reranker).filter(Boolean))].sort();
  const embedders = [...new Set(tiersOf(routing).map((t) => t.embedder).filter((id) => id && id !== RP.NANO))].sort();
  const done = [];
  const steps = [
    ...embedders.map((model) => ({ model, kind: 'embedder', run: async () => { const p = EP.get({ embedder: model }, { owner: E.owner || false }); if (!p) throw new Error(`no embed provider for ${model}`); await p.embedQuery('warm up'); } })),
    ...rerankers.map((model) => ({ model, kind: 'reranker', run: async () => { const p = RPV.get({ reranker: model }, { owner: E.owner || false }); if (!p) throw new Error(`no rerank provider for ${model}`); await p.rerank({ query: 'warm up', docs: [{ id: 'w', text: 'warm up' }], depth: 1, boundMs: WARM_BOUND_MS }); } })),
  ];
  for (const s of steps) {
    const t0 = Date.now();
    try { await s.run(); } catch (e) { return { ok: false, model: s.model, kind: s.kind, code: (e && e.code) || 'E_INTERNAL', message: (e && e.message) || String(e), models: done }; }
    done.push({ model: s.model, kind: s.kind, ms: Date.now() - t0 });
    if (onStep) { try { onStep(done[done.length - 1]); } catch { /* a sink never stops the warm-up */ } }
  }
  return { ok: true, models: done };
}

module.exports = { warmUp, WARM_BOUND_MS };
