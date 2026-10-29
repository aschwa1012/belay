'use strict';
// retrieval-warm.cjs — warm-up of a pinned routing's models, at pin time (ADR 0050 decisions 5 and 6). The first rerank of a run must not
// pay a cold model load inside the 10 s rerank bound, and the first heavy query must not pay the GPU load inside a search. After the probe
// and before the run's first prompt, every distinct reranker (CPU or GPU) and heavy embedder of the routing is loaded here through its own
// provider, by one tiny real call. Owner only (the providers are built there). A failure names the model and is handled by the caller as a
// probe refusal is (on_heavy_failure). An owner that starts after the pin (a restart mid-run) or lost a reranker's state to a failure warms it in the
// background from the first search that needs it (rerankerState): that search keeps the fusion order and says so.

const RP = require('./retrieval-profiles.cjs');

const WARM_BOUND_MS = 300000; // a cold 4B load with a first Vulkan shader build is long; the load has its own wall clock

const tiersOf = (r) => [r.run, ...Object.values(r.tiers)];

// One tiny real call through the reranker's own provider: the load happens here, on the warm-up's own wall clock (WARM_BOUND_MS), never
// inside a search's rerank bound. Throws what the provider throws.
async function warmReranker(E, model) {
  const p = require('./rerank-provider.cjs').get({ reranker: model }, { owner: E.owner || false });
  if (!p) throw new Error(`no rerank provider for ${model}`);
  await p.rerank({ query: 'warm up', docs: [{ id: 'w', text: 'warm up' }], depth: 1, boundMs: WARM_BOUND_MS });
}

// The warm state of a search's reranker in this owner: 'ready' (loaded, or a provider the caller registered itself, which loads nothing
// here), 'loading' (a background warm-up is running; the search keeps the fusion order and does not wait), or 'failed' (the warm-up threw;
// the search then tries the reranker itself, so the real error follows on_heavy_failure). An owner that has not warmed this reranker yet
// (a pin made before this owner started, or a failure that dropped the state) starts the warm-up in the background and answers 'loading'.
// Never throws, never waits.
function rerankerState(E, tier) {
  const model = tier && tier.reranker, owner = E.owner;
  if (!model || !owner || (typeof owner === 'object' && owner.stopped)) return 'ready';
  const RPV = require('./rerank-provider.cjs');
  const impl = RPV.isExternal(model) ? null : RPV.get({ reranker: model }, { owner });
  if (!impl) return 'ready'; // nothing of the owner's to load: the stage reports an absent provider itself
  // A dead child (the GPU's shared one is never replaced by a call) is not warmed again: the search goes straight to the reranker, whose coded
  // error drives on_heavy_failure. A CPU child that died is replaced by its provider on the next call, so that one is warmed again.
  if (typeof impl.dead === 'function' && impl.dead()) return 'failed';
  const m = E._rerankWarm || (E._rerankWarm = new Map());
  const hit = m.get(model);
  // A 'ready' state outlives its child only on paper: a provider that can say whether its model is still loaded (its child exited, was closed or
  // was replaced outside a rerank) is asked, and a model that is gone is warmed again in the background.
  if (hit && !(hit.state === 'ready' && typeof impl.loaded === 'function' && !impl.loaded())) return hit.state;
  const entry = { state: 'loading', attempts: 0 };
  m.set(model, entry);
  // One background retry of a failed warm-up before the state falls to 'failed' (and the next search loads inside its own bound).
  const attempt = () => { entry.attempts += 1; warmReranker(E, model).then(() => { entry.state = 'ready'; }, (e) => { if (entry.attempts < 2 && !(E.owner && E.owner.stopped)) attempt(); else { entry.state = 'failed'; entry.cause = (e && e.message) || String(e); } }); };
  attempt();
  return 'loading';
}
// A rerank that failed leaves the model's state unknown (the provider rebuilds its child on the next call): drop it, so the next search warms again.
const forgetReranker = (E, model) => { if (E._rerankWarm) E._rerankWarm.delete(model); };

// -> { ok: true, models: [{ model, kind, ms }] } or { ok: false, model, kind, code, message, models }. Never throws.
async function warmUp(E, routing, onStep) {
  const EP = require('./embed-provider.cjs');
  const rerankers = [...new Set(tiersOf(routing).map((t) => t.reranker).filter(Boolean))].sort();
  const embedders = [...new Set(tiersOf(routing).map((t) => t.embedder).filter((id) => id && id !== RP.NANO))].sort();
  const done = [];
  const steps = [
    ...embedders.map((model) => ({ model, kind: 'embedder', run: async () => { const p = EP.get({ embedder: model }, { owner: E.owner || false }); if (!p) throw new Error(`no embed provider for ${model}`); await p.embedQuery('warm up'); } })),
    ...rerankers.map((model) => ({ model, kind: 'reranker', run: async () => { await warmReranker(E, model); (E._rerankWarm || (E._rerankWarm = new Map())).set(model, { state: 'ready' }); } })),
  ];
  for (const s of steps) {
    const t0 = Date.now();
    try { await s.run(); } catch (e) { return { ok: false, model: s.model, kind: s.kind, code: (e && e.code) || 'E_INTERNAL', message: (e && e.message) || String(e), models: done }; }
    done.push({ model: s.model, kind: s.kind, ms: Date.now() - t0 });
    if (onStep) { try { onStep(done[done.length - 1]); } catch { /* a sink never stops the warm-up */ } }
  }
  return { ok: true, models: done };
}

module.exports = { warmUp, warmReranker, rerankerState, forgetReranker, WARM_BOUND_MS };
