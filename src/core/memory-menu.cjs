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

// ONE copy of the store per read, shared by the live-run read and the backlog count. fn(null) when there is no store file yet.
async function withStore(dataDir, fn) {
  if (!fs.existsSync(path.join(dataDir, 'memory.db'))) return fn(null);
  const { withCopy } = require('./copy-read.cjs');
  const { Store } = require('./store.cjs');
  return withCopy(dataDir, async (dbPath) => {
    const store = new Store(dbPath);
    try { return await fn(store); } finally { try { store.close(); } catch { /* a throwaway copy */ } }
  });
}

// The models a run's routing names: the pin it recorded, or (still pinning or warming up, no pin yet) the routing its own recorded levers resolve to
// with a GPU assumed, so a model it is about to load counts as in use.
function modelsOfRun(r) {
  let pin = null;
  try { pin = typeof r.retrieval_routing === 'string' ? JSON.parse(r.retrieval_routing) : r.retrieval_routing; } catch { pin = null; }
  let tiers = pin && pin.routing ? [pin.routing.run, ...Object.values(pin.routing.tiers || {})] : null;
  if (!tiers) {
    try {
      const raw = typeof r.memory_levers === 'string' ? JSON.parse(r.memory_levers) : r.memory_levers;
      const res = resolveRouting({ levers: raw || undefined, agentTypes: [...MAIN_TYPES], gpu: true });
      tiers = [res.run, ...Object.values(res.tiers)];
    } catch { tiers = []; }
  }
  const ids = new Set();
  for (const t of tiers) for (const id of [t && t.embedder, t && t.reranker]) if (id) ids.add(id);
  return [...ids];
}

// The runs that keep a model in use, read from a store copy `store` (null: none). A run counts when it has not ended and EITHER it is paused (a
// parked run holds its pin whatever its pid says) OR its adapter pid is alive. With `verify` (the delete path), a live pid that recorded its creation
// time is confirmed against ONE process snapshot (ADR 0039): a different creation time is a reused pid, so the run is dead and does not count; an
// unreadable snapshot keeps the run counted, flagged `unverified`. The menu read skips the snapshot (a read budget) and trusts the bare pid.
// -> { models: { id: ['run <id>', ...] }, runs: [{ id, why: 'live'|'paused'|'unverified', pid }], stale: [{ id, pid }], ok }
async function liveRunsIn(store, { verify = false, snapshot = null } = {}) {
  const out = { models: {}, runs: [], stale: [], ok: true };
  if (!store) return out;
  let snap;
  const take = async () => { if (snap === undefined) snap = await (snapshot || require('./proc-identity.cjs').processSnapshot)(); return snap; };
  for (const r of rows.currentAll(store, 'run')) {
    if (r.ended_at != null) continue;
    let why = null;
    if (r.paused_at != null) why = 'paused';
    else if (pidAlive(r.adapter_pid)) {
      why = 'live';
      if (verify && r.adapter_pid_created != null) {
        const sn = await take();
        if (!sn) why = 'unverified';
        else {
          const e = sn.get(r.adapter_pid);
          if (!e || e.created == null || e.created !== r.adapter_pid_created) { out.stale.push({ id: r.id, pid: r.adapter_pid }); why = null; }
        }
      }
    }
    if (!why) continue;
    out.runs.push({ id: r.id, why, pid: r.adapter_pid });
    for (const id of modelsOfRun(r)) { const l = (out.models[id] = out.models[id] || []); const w = `run ${r.id}${why === 'paused' ? ' (paused)' : why === 'unverified' ? ' (adapter pid not verified)' : ''}`; if (!l.includes(w)) l.push(w); }
  }
  return out;
}

async function liveRunUse(dataDir, opts = {}) {
  try { return await withStore(dataDir, (store) => liveRunsIn(store, opts)); } catch { return { models: {}, runs: [], stale: [], ok: false }; }
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

// The backlog of each heavy embedder: the visible notes of project/<p> with no vector under it, counted in the shared store copy. A model whose backlog
// cannot be counted (no project, no store, no vector table yet) has no entry, and the reason says why: the menu says so instead of 0.
function backlogsIn(store, project, ids) {
  const out = {};
  if (!project || !ids.length) return { by: out, reason: project ? null : 'no memory.project is set' };
  if (!store) return { by: out, reason: 'no store yet' };
  const MV = require('./memory-vectors.cjs');
  for (const id of ids) {
    const g = GGUF_MODELS[id];
    try { out[id] = MV.backlog(store.db, { model: id, revision: g.sha, dims: g.dims }, { namespaces: [`project/${project}`] }).length; } catch { /* no vector table in this copy: not counted */ }
  }
  return { by: out, reason: Object.keys(out).length === ids.length ? null : 'the store has no vector table yet' };
}

const profileRows = (probe) => RP.PROFILE_NAMES.map((name) => {
  const p = RP.PROFILES[name];
  const gpuIds = [p.embedder, p.reranker].filter((id) => id && has(GGUF_MODELS, id));
  const vram = gpuIds.reduce((n, id) => n + (has(probe.peaks, id) ? probe.peaks[id] : GGUF_MODELS[id].vram_mb_ref), 0);
  const label = (id) => (id ? (tableEntry(id) && tableEntry(id).label) || id : 'none');
  return { name, embedder: p.embedder, reranker: p.reranker, device: gpuIds.length ? 'gpu' : 'cpu', embedder_label: label(p.embedder), reranker_label: label(p.reranker), time_s: PROFILE_TIME_S[name], vram_mb: vram };
});

// The GPU is usable for the selected embedder when the last probe was ok, the runtime is sound NOW, and every GPU model of the saved routing is still in
// the cache (a stat): an ok probe does not outlive a runtime or a model removed since.
function gpuUsable(gpu, levers, cacheRoot) {
  if (!(gpu.state === 'probed' && gpu.ok === true && gpu.runtime.ok === true)) return false;
  let ids = [];
  try { ids = resolveRouting({ levers, agentTypes: [...MAIN_TYPES], gpu: true }).gpu_models; } catch { return false; }
  return ids.every((id) => { const e = tableEntry(id); return !!e && K.checkPresent(e, cacheRoot).present; });
}

// The selected embedder (the profile when the GPU is usable, else profile_cpu) and the notes behind it. The badge needs no more than this, so
// `belay memory menu --badge` counts one embedder instead of every heavy one.
async function badge({ found, dataDir, env = process.env }) {
  const { levers } = leversOf(found);
  const gpu = gpuOf(probeRead(env), env);
  let selected = RP.NANO;
  try { selected = resolveRouting({ levers, agentTypes: [...MAIN_TYPES], gpu: gpuUsable(gpu, levers, K.cacheRoot(env)) }).run.embedder; } catch { /* the block is refused: nano */ }
  let bl = { by: {}, reason: null };
  if (has(GGUF_MODELS, selected)) {
    try { bl = await withStore(dataDir, (store) => backlogsIn(store, levers.project, [selected])); } catch { bl = { by: {}, reason: 'the store could not be read' }; }
  }
  return { v: 1, badge: true, selected_embedder: selected, behind: has(bl.by, selected) ? bl.by[selected] : 0, backlog_reason: bl.reason };
}

async function menu({ found, dataDir, agentTypes, env = process.env }) {
  const { levers, error } = leversOf(found);
  const probe = probeRead(env);
  const gpu = gpuOf(probe, env);
  const cacheRoot = K.cacheRoot(env);
  const heavyIds = Object.values(GGUF_MODELS).filter((e) => e.kind === 'embedder').map((e) => e.id);
  let live = { models: {}, runs: [], stale: [], ok: true }, used = {}, bl = { by: {}, reason: null };
  try { // one store copy for the live runs and the backlog
    await withStore(dataDir, async (store) => {
      live = await liveRunsIn(store);
      used = modelsInUse(levers, live.models);
      bl = backlogsIn(store, levers.project, heavyIds.filter((id) => has(used, id) || K.checkPresent(GGUF_MODELS[id], cacheRoot).present));
    });
  } catch { live = { ...live, ok: false }; used = modelsInUse(levers, {}); bl = { by: {}, reason: 'the store could not be read' }; }
  const models = modelRows({ cacheRoot, probe, used, backlog: bl.by });
  const usable = gpuUsable(gpu, levers, cacheRoot);
  const selectedProfile = usable ? levers.profile : levers.profile_cpu;
  let selected = RP.NANO;
  try { selected = resolveRouting({ levers, agentTypes: [...MAIN_TYPES], gpu: usable }).run.embedder; } catch { /* the block is refused: nano */ }
  const saved = (() => { try { return resolveRouting({ levers, agentTypes: [...MAIN_TYPES], gpu: true }).gpu_models; } catch { return []; } })();
  const disk = models.filter((m) => m.state === 'ready').reduce((n, m) => n + m.bytes, 0);
  return {
    v: 1, live_runs: live.runs.map((r) => r.id), live_runs_ok: live.ok, config: found && found.found ? found.path : null, config_error: error, project: levers.project, cache_root: cacheRoot,
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
