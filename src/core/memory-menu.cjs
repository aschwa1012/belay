'use strict';
// memory-menu.cjs — the facts the Memory menu shows (ADR 0050 decision 3 and amendment 3): the GPU line, the profiles, the routing's
// sizing, every model with its state, the backlog of each heavy embedder and the disk the models use. `belay memory menu --json` prints
// it and the panel draws it. It is a READ (invariants 6 and 9): the configuration file, the model tables, a stat of the model cache, the
// probe's last reading in its peaks file, and the store through a COPY (copy-read.cjs). It starts no process and creates no file, and it
// requires only pure modules (the profile table, the routing resolver, the model tables, the cache and runtime checks), never the GPU
// client, the probe, the rerank providers or the embedding library (tests/core/gpu-import-graph.test.cjs).
//
// `modelsInUse` is also what `belay embedder delete` consults: a model the current settings name is not deleted.

const fs = require('node:fs');
const path = require('node:path');
const RP = require('./retrieval-profiles.cjs');
const { resolveRouting } = require('./retrieval-routing.cjs');
const { GGUF_MODELS } = require('./gguf-models.cjs');
const { MODELS } = require('./models.cjs');
const { ONNX_RERANKER_TABLE } = require('./onnx-rerankers.cjs');
const ML = require('./memory-levers.cjs');
const K = require('./model-cache.cjs');
const R = require('./gpu-runtime.cjs');
const rows = require('./rows.cjs');
const { pidAlive } = require('./lock.cjs');

// What a search costs beyond nano's own, per profile (seconds, depth 50), measured on the operator's laptop (docs/HANDOFF-RETRIEVAL-0-3-1.md): speed
// and fit only. A guide, never a promise: the retrieval eval (0.3.2) re-picks the defaults.
const PROFILE_TIME_S = Object.freeze({ 'cpu-fast': 0, 'cpu-rerank-light': 0.3, 'cpu-rerank': 3.6, 'gpu-rerank-fast': 0.73, 'gpu-rerank': 2.7, 'gpu-balanced': 2.8, 'gpu-recall-max': 0.8 });
const MAIN_TYPES = Object.freeze(['orchestrator', 'reviewer', 'coder']);
const LEVER_KEYS = Object.freeze(['profile', 'profile_cpu', 'on_heavy_failure', 'on_heavy_behind', 'rerank_depth', 'search_log_cap_mb', 'vram_headroom_gb', 'routing', 'routing_cpu']);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function tableEntry(id) {
  if (has(GGUF_MODELS, id)) return GGUF_MODELS[id];
  if (has(ONNX_RERANKER_TABLE, id)) return ONNX_RERANKER_TABLE[id];
  if (has(MODELS, id)) return MODELS[id];
  return null;
}

// The effective memory levers for the settings the config holds, parsed as a run would parse them (defaults filled). A block a run would refuse
// is reported as `error` and the defaults stand, so the menu still draws.
function leversOf(found) {
  const block = found && found.found && found.config && found.config.memory && typeof found.config.memory === 'object' && !Array.isArray(found.config.memory) ? found.config.memory : undefined;
  const r = ML.parseMemoryBlock(block);
  if (r.error) return { levers: ML.parseMemoryBlock(undefined).value, error: r.error };
  return { levers: r.value, error: null };
}

// The probe's last reading and the recorded peaks (probe-peaks.json), by a plain read; { last: null, peaks: {} } when there is none.
function probeRead(env = process.env) {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(path.join(R.baseDir(env), 'probe-peaks.json'), 'utf8')); } catch { j = null; }
  const peaks = {};
  for (const e of Object.values((j && j.entries) || {})) if (e && typeof e.model === 'string' && Number.isFinite(e.peak_mb)) peaks[e.model] = Math.max(peaks[e.model] || 0, e.peak_mb);
  const l = j && j.last && typeof j.last === 'object' ? j.last : null;
  return { last: l, peaks };
}

function gpuOf(probe, env) {
  let runtime = { installed: false, ok: false, command: R.INSTALL_COMMAND, problems: 0 };
  try { const c = R.check({ env }); runtime = { installed: c.problems.length === 0 || !/not installed/.test(c.problems[0]), ok: c.ok, command: c.command, problems: c.problems.length, dir: c.dir }; } catch { /* a manifest that cannot be read: not installed */ }
  const l = probe.last;
  if (!l) return { state: 'not_probed', device: null, free_mb: null, total_mb: null, ok: null, reason: null, at: null, runtime };
  return { state: 'probed', device: l.device || null, free_mb: Number.isFinite(l.free_mb) ? l.free_mb : null, total_mb: Number.isFinite(l.total_mb) ? l.total_mb : null, ok: l.ok === true, reason: l.reason || null, at: l.at || null, runtime };
}

// Every model id the settings name, whether or not a run would reach it today: the run's profile, the CPU profile, every routed type and every
// CPU pick. { id: [who, ...] }. A name is a reason to keep the model, so `belay embedder delete` refuses it.
function modelsInUse(levers, live = {}) {
  const used = {};
  for (const [id, who] of Object.entries(live)) used[id] = [...who];
  const note = (id, who) => { if (id && id !== 'none') (used[id] = used[id] || []).push(who); };
  const named = (entry, who) => {
    if (entry === null || entry === undefined) return;
    const m = typeof entry === 'string' ? (entry === RP.CUSTOM ? { embedder: levers.embedder, reranker: levers.reranker } : has(RP.PROFILES, entry) ? RP.PROFILES[entry] : null) : entry;
    if (m) { note(m.embedder, who); note(m.reranker, who); }
  };
  named(levers.profile, 'run');
  named(levers.profile_cpu, 'run (CPU only)');
  for (const [t, e] of Object.entries(levers.routing || {})) named(e, t);
  for (const [t, e] of Object.entries(levers.routing_cpu || {})) named(e, `${t} (CPU only)`);
  note(RP.NANO, 'every note (the base)');
  for (const id of Object.keys(used)) used[id] = [...new Set(used[id])];
  return used;
}

// The models the pinned routing of every LIVE run (not ended, its adapter's pid alive; a paused run is live) names, read from a COPY of the store:
// { model id: ['run <id>', ...] } and the run ids. A run pins its routing once at its start and keeps it whatever the settings say now, so a model
// the settings no longer name can still be loaded by a run. `ok: false` when the store could not be read: a caller that must not guess refuses.
async function liveRunUse(dataDir) {
  const out = { models: {}, runs: [], ok: true };
  if (!fs.existsSync(path.join(dataDir, 'memory.db'))) return out;
  const { withCopy } = require('./copy-read.cjs');
  const { Store } = require('./store.cjs');
  try {
    return await withCopy(dataDir, async (dbPath) => {
      const store = new Store(dbPath);
      try {
        for (const r of rows.currentAll(store, 'run')) {
          if (r.ended_at != null || !pidAlive(r.adapter_pid)) continue;
          out.runs.push(r.id);
          let pin = null;
          try { pin = typeof r.retrieval_routing === 'string' ? JSON.parse(r.retrieval_routing) : r.retrieval_routing; } catch { pin = null; }
          const tiers = pin && pin.routing ? [pin.routing.run, ...Object.values(pin.routing.tiers || {})] : [];
          for (const t of tiers) for (const id of [t && t.embedder, t && t.reranker]) if (id) { const l = (out.models[id] = out.models[id] || []); if (!l.includes(`run ${r.id}`)) l.push(`run ${r.id}`); }
        }
        return out;
      } finally { try { store.close(); } catch { /* a throwaway copy */ } }
    });
  } catch { return { ...out, ok: false }; }
}

function modelRows({ cacheRoot, probe, used, backlog }) {
  const rows = [];
  const add = (e, kind, runtime) => {
    const chk = K.checkPresent(e, cacheRoot);
    const gpu = runtime === 'gguf';
    const measured = gpu && has(probe.peaks, e.id) ? probe.peaks[e.id] : null;
    rows.push({
      id: e.id, kind, runtime, device: gpu ? 'gpu' : 'cpu', label: e.label || e.id, bytes: e.files.reduce((n, f) => n + f.bytes, 0),
      vram_mb: gpu ? (measured !== null ? measured : e.vram_mb_ref) : null, vram_source: gpu ? (measured !== null ? 'measured' : 'reference') : null,
      state: chk.present ? 'ready' : 'download', in_use: has(used, e.id), in_use_by: used[e.id] || [],
      heavy: gpu && kind === 'embedder', backlog: gpu && kind === 'embedder' && has(backlog, e.id) ? backlog[e.id] : null,
    });
  };
  add(MODELS[RP.NANO], 'embedder', 'onnx');
  for (const e of Object.values(GGUF_MODELS).filter((x) => x.kind === 'embedder')) add(e, 'embedder', 'gguf');
  for (const e of Object.values(ONNX_RERANKER_TABLE)) add(e, 'reranker', 'onnx');
  for (const e of Object.values(GGUF_MODELS).filter((x) => x.kind === 'reranker')) add(e, 'reranker', 'gguf');
  return rows;
}

// The backlog of each heavy embedder: the visible notes of project/<p> with no vector under it, read from a COPY of the store. null for an embedder
// whose backlog cannot be counted (no project, no store, no vector table yet): the menu says so instead of 0.
async function backlogs(dataDir, project, ids) {
  const out = {};
  if (!project || !ids.length) return { by: out, reason: project ? null : 'no memory.project is set' };
  const src = path.join(dataDir, 'memory.db');
  if (!fs.existsSync(src)) return { by: out, reason: 'no store yet' };
  const { withCopy } = require('./copy-read.cjs');
  const { Store } = require('./store.cjs');
  const MV = require('./memory-vectors.cjs');
  return withCopy(dataDir, async (dbPath) => {
    const store = new Store(dbPath);
    try {
      for (const id of ids) {
        const g = GGUF_MODELS[id];
        try { out[id] = MV.backlog(store.db, { model: id, revision: g.sha, dims: g.dims }, { namespaces: [`project/${project}`] }).length; } catch { /* no vector table in this copy: not counted */ }
      }
      return { by: out, reason: Object.keys(out).length === ids.length ? null : 'the store has no vector table yet' };
    } finally { try { store.close(); } catch { /* a throwaway copy */ } }
  });
}

const profileRows = (probe) => RP.PROFILE_NAMES.map((name) => {
  const p = RP.PROFILES[name];
  const gpuIds = [p.embedder, p.reranker].filter((id) => id && has(GGUF_MODELS, id));
  const vram = gpuIds.reduce((n, id) => n + (has(probe.peaks, id) ? probe.peaks[id] : GGUF_MODELS[id].vram_mb_ref), 0);
  const label = (id) => (id ? (tableEntry(id) && tableEntry(id).label) || id : 'none');
  return { name, embedder: p.embedder, reranker: p.reranker, device: gpuIds.length ? 'gpu' : 'cpu', embedder_label: label(p.embedder), reranker_label: label(p.reranker), time_s: PROFILE_TIME_S[name], vram_mb: vram };
});

// menu({ found, dataDir, agentTypes, env }) -> the object `belay memory menu --json` prints.
// The GPU is usable for the selected embedder when the last probe was ok AND the runtime is still sound now (a runtime removed since the probe is not).
const gpuUsable = (gpu) => gpu.state === 'probed' && gpu.ok === true && gpu.runtime.ok === true;

// The selected embedder (the profile when the GPU is usable, else profile_cpu) and the notes behind it. The badge needs no more than this, so
// `belay memory menu --badge` counts one embedder instead of every heavy one.
async function badge({ found, dataDir, env = process.env }) {
  const { levers } = leversOf(found);
  const gpu = gpuOf(probeRead(env), env);
  let selected = RP.NANO;
  try { selected = resolveRouting({ levers, agentTypes: [...MAIN_TYPES], gpu: gpuUsable(gpu) }).run.embedder; } catch { /* the block is refused: nano */ }
  const bl = has(GGUF_MODELS, selected) ? await backlogs(dataDir, levers.project, [selected]) : { by: {}, reason: null };
  return { v: 1, badge: true, selected_embedder: selected, behind: has(bl.by, selected) ? bl.by[selected] : 0, backlog_reason: bl.reason };
}

async function menu({ found, dataDir, agentTypes, env = process.env }) {
  const { levers, error } = leversOf(found);
  const probe = probeRead(env);
  const gpu = gpuOf(probe, env);
  const cacheRoot = K.cacheRoot(env);
  const live = await liveRunUse(dataDir);
  const used = modelsInUse(levers, live.models);
  const heavyIds = Object.values(GGUF_MODELS).filter((e) => e.kind === 'embedder').map((e) => e.id);
  const wanted = heavyIds.filter((id) => has(used, id) || K.checkPresent(GGUF_MODELS[id], cacheRoot).present);
  const bl = await backlogs(dataDir, levers.project, wanted);
  const models = modelRows({ cacheRoot, probe, used, backlog: bl.by });
  const usable = gpuUsable(gpu);
  const selectedProfile = usable ? levers.profile : levers.profile_cpu;
  let selected = RP.NANO;
  try { selected = resolveRouting({ levers, agentTypes: [...MAIN_TYPES], gpu: usable }).run.embedder; } catch { /* the block is refused: nano */ }
  const saved = (() => { try { return resolveRouting({ levers, agentTypes: [...MAIN_TYPES], gpu: true }).gpu_models; } catch { return []; } })();
  const disk = models.filter((m) => m.state === 'ready').reduce((n, m) => n + m.bytes, 0);
  return {
    v: 1, live_runs: live.runs, live_runs_ok: live.ok, config: found && found.found ? found.path : null, config_error: error, project: levers.project, cache_root: cacheRoot,
    gpu, levers: Object.fromEntries(LEVER_KEYS.map((k) => [k, levers[k]])), headroom_mb: Math.round(levers.vram_headroom_gb * 1024),
    profiles: profileRows(probe), models,
    agent_types: { main: [...MAIN_TYPES], advanced: agentTypes.filter((t) => !MAIN_TYPES.includes(t)) },
    routing_gpu_models: saved, selected_profile: selectedProfile, selected_embedder: selected,
    behind: has(bl.by, selected) ? bl.by[selected] : 0, backlog_reason: bl.reason,
    disk: { bytes: disk, models: models.filter((m) => m.state === 'ready').length },
  };
}

// The model a `belay embedder delete` names, and whether the settings forbid it: { entry, runtime, kind } or null for an unknown id.
function describeForDelete(id) {
  const e = tableEntry(id);
  if (!e) return null;
  return { entry: e, runtime: has(GGUF_MODELS, id) ? 'gguf' : 'onnx', kind: has(GGUF_MODELS, id) ? GGUF_MODELS[id].kind : has(ONNX_RERANKER_TABLE, id) ? 'reranker' : 'embedder' };
}

module.exports = { menu, badge, liveRunUse, gpuUsable, modelsInUse, leversOf, probeRead, describeForDelete, tableEntry, PROFILE_TIME_S, MAIN_TYPES };
