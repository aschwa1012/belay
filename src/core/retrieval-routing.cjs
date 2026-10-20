'use strict';
// retrieval-routing.cjs — ADR 0050 decision 3: which retrieval tier each agent type gets, resolved once from the
// layered levers and fixed for the run. `resolveRouting` is a pure function of its arguments: no file, no process,
// no model is touched, so the owner, a menu or a test may call it. It requires only the lever spec and the
// profile table (both pure data), so a read path may load it (invariant 9).
//
// Layering (the settings rule of 2026-10-15): `settings` is the config file's memory block, `spec` the run spec's;
// the spec overrides the settings key by key (a spec `routing` replaces the settings `routing` whole, as
// run-levers.cjs's mergeMemory does for every lever), then the merged block is validated once by parseMemoryBlock.
//
// IDENTITY (invariant 3, ADR 0045): `agentTypes` is the caller's list of agent types, and a search's tier is the
// entry for the agent type the worker was SPAWNED with. When this is wired in, the agent type must come from the
// spawn arguments the harness itself passed (pinned on the worker row), never from a request, a prompt or anything
// a model says. This module never reads an agent type from anywhere but its argument.

const { err } = require('./errors.cjs');
const ML = require('./memory-levers.cjs');
const RP = require('./retrieval-profiles.cjs');

// A probe or detection result counts as a usable GPU unless it says otherwise. false, null and undefined are no GPU.
function gpuUsable(gpu) {
  if (gpu === true) return true;
  if (!gpu || typeof gpu !== 'object') return false;
  return gpu.ok !== false && gpu.available !== false;
}

// One wanted pair -> a tier. `models` is { embedder, reranker } ids (reranker null for none).
function tierOf(profile, models, depth, extra = {}) {
  const device = RP.needsGpu(models) ? 'gpu' : 'cpu';
  return { profile, embedder: models.embedder, reranker: models.reranker, device, depth: models.reranker ? depth : 0, ...extra };
}

const pairModels = (p) => ({ embedder: p.embedder, reranker: p.reranker === undefined || p.reranker === 'none' ? null : p.reranker });

// A profile name or a pair, as { label, models }. `custom` is the merged block's own embedder and reranker.
function wanted(entry, merged) {
  if (typeof entry === 'string') {
    if (entry === RP.CUSTOM) return { label: RP.CUSTOM, models: pairModels({ embedder: merged.embedder, reranker: merged.reranker }) };
    return { label: entry, models: RP.profileModels(entry) };
  }
  return { label: RP.CUSTOM, models: pairModels(entry) };
}

// resolveRouting({ settings, spec, agentTypes, gpu }) -> {
//   run:      the tier of the run's own profile (what an unset agent type uses),
//   tiers:    { <agent type>: tier } for every type in agentTypes (and every routed type),
//   gpu:      whether a usable GPU was assumed,
//   gpu_models: the distinct GPU model ids the resolved tiers need, sorted (for the probe's sum),
//   notices:  [{ code, message, agent_types }]  (gpu_absent once, never one per role),
//   levers:   the few merged levers the run needs beside the tiers (depth, bound, failure and behind policies, headroom) }
// A tier is { profile, embedder, reranker, device, depth, source, fallback_from } and serialises as plain JSON.
// Refuses (E_MODEL) a tier that names a model whose pin is pending, and (E_ARGS) an invalid lever block.
function resolveRouting({ settings, spec, agentTypes = [], gpu = false } = {}) {
  const parsed = ML.parseMemoryBlock({ ...(settings || {}), ...(spec || {}) });
  if (parsed.error) throw err('E_ARGS', parsed.error, { reason: 'levers' });
  const m = parsed.value;
  if (!Array.isArray(agentTypes) || agentTypes.some((t) => typeof t !== 'string' || !t)) throw err('E_ARGS', 'agentTypes must be a list of agent type names', { agentTypes });
  const haveGpu = gpuUsable(gpu);
  const routing = m.routing || {};
  const types = [...new Set([...agentTypes, ...Object.keys(routing)])];

  const affected = [];
  const resolve = (entry, source, who) => {
    let w = wanted(entry, m);
    let fallbackFrom = null;
    if (!haveGpu && RP.needsGpu(w.models)) {
      fallbackFrom = w.label;
      affected.push(who);
      w = wanted(m.profile_cpu, m);
    }
    for (const id of [w.models.embedder, w.models.reranker]) if (id) RP.assertUsable(id);
    return tierOf(w.label, w.models, m.rerank_depth, { source, fallback_from: fallbackFrom });
  };

  const run = resolve(m.profile, 'run', 'run');
  const tiers = {};
  for (const t of types) tiers[t] = Object.prototype.hasOwnProperty.call(routing, t) ? resolve(routing[t], 'routing', t) : { ...run, source: 'run' };

  const gpuModels = new Set();
  for (const tier of [run, ...Object.values(tiers)]) {
    for (const id of [tier.embedder, tier.reranker]) if (id && RP.describeModel(id).device === 'gpu') gpuModels.add(id);
  }
  const notices = [];
  if (affected.length) {
    const roles = [...new Set(affected)];
    notices.push({
      code: 'gpu_absent',
      message: `no usable GPU: ${roles.join(', ')} fell back to the ${m.profile_cpu} profile (a heavy embedder never runs on the CPU)`,
      agent_types: roles,
    });
  }
  return {
    run, tiers, gpu: haveGpu, gpu_models: [...gpuModels].sort(), notices,
    levers: {
      rerank_depth: m.rerank_depth, rerank_bound_ms: m.rerank_bound_ms, on_heavy_failure: m.on_heavy_failure,
      on_heavy_behind: m.on_heavy_behind, vram_headroom_gb: m.vram_headroom_gb, search_log_cap_mb: m.search_log_cap_mb,
    },
  };
}

module.exports = { resolveRouting, gpuUsable };
