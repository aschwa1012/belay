'use strict';
// heavy-drain.cjs — a heavy embedder's backlog, drained (ADR 0050 decision 4). The backlog is DERIVED from the rows (memory-vectors.cjs
// backlog: the visible notes of the stated namespaces with no vector under the tier), never kept as a list. drainHeavy embeds those
// rows through the embed provider in batches, writes each vector with MV.putVector (which bumps the cache's generation, so a heavy
// search rebuilds its map), and reports progress. It is bounded: a call that reaches boundMs stops after its batch and says how much is
// left, so a caller (`belay memory embed --model`, a run's start) loops with progress and no single call outlives the pipe's limit.
// A held or superseded note is in the backlog and is embedded: every tier must see the notes the nano tier shows (ADR 0050 amendment 1).
// Owner only: the provider is built there. Nothing here is required by a read path.

const { err } = require('./errors.cjs');
const MV = require('./memory-vectors.cjs');
const EP = require('./embed-provider.cjs');
const HT = require('./heavy-tier.cjs');

const BATCH = 16;
const DEFAULT_BOUND_MS = 20000;

// { model, revision, dims } the cache is keyed by, for a heavy embedder id (or a tier). E_ARGS for anything else.
function keyOfModel(model) {
  const id = typeof model === 'string' ? model : model && model.embedder;
  const t = HT.withDims({ embedder: id });
  if (!id || !Number.isInteger(t.dims)) throw err('E_ARGS', `${JSON.stringify(id)} is not a heavy embedder in the GPU model table, so it has no backlog to drain`, { model: id });
  return { model: id, revision: t.revision || '', dims: t.dims };
}

// The visible notes of `namespaces` with no vector under `model`: [{ id, namespace, type, title, created_at }].
function backlogOf(E, model, namespaces) {
  return MV.backlog(E.store.db, keyOfModel(model), { namespaces });
}

// Embeds the rows `ids` through `impl` and writes one vector per distinct (template, text hash): rows with the same text share it.
// Shared by the drain and by a note's own heavy embed (heavy-notes.cjs). A row with no renderable text writes nothing.
async function embedIds(E, key, impl, ids, opts) {
  const db = E.store.db;
  const rowsOf = db.prepare('SELECT * FROM memory_entries WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids));
  const want = new Map();
  for (const r of rowsOf) {
    const template = MV.renderTemplateOf(r), hash = MV.embedHashOf(r, template), text = MV.embedTextOf(r, template);
    if (hash === null || text === null) continue;
    want.set(`${template}\u0000${hash}`, { template, hash, text });
  }
  const list = [...want.entries()].map(([k, w]) => ({ id: k, text: w.text }));
  const embedded = list.length ? await impl.embedDocs(list, opts) : [];
  if (opts && opts.cancelled && opts.cancelled()) return 0; // the owner's catch-up was ended while this batch was in flight: write nothing
  E.store.tx(() => {
    for (const d of embedded) {
      const w = want.get(d.id);
      if (!w || d.embedding.length !== key.dims) throw err('E_DIM', `the ${key.model} embedder answered ${d.embedding.length} dimensions for a row and the table pins ${key.dims}`, { embedder: key.model });
      MV.putVector(db, { ...key, template: w.template }, w.hash, Buffer.from(Float32Array.from(d.embedding).buffer));
    }
  });
  if (E.noteWrite) E.noteWrite();
  return list.length;
}

// -> { embedder, dims, total, written, remaining, done, ms }. Throws a coded error (detail.written says how far it got) when the
// provider fails: the rows stay in the backlog, and nothing is reported as embedded that was not written.
// The VRAM probe (with the vram_headroom_gb lever) before a drain loads a model on its own (`belay memory embed --model`): a refusal is
// E_MODEL_ABSENT, probe_refused. Skipped when the shared child already holds the model (a live run's: its pin probed, and a second probe would count it twice).
async function probeFirst(model, headroomGb) {
  const GS = require('./gpu-shared.cjs');
  if (GS.holds(model)) return;
  const hr = headroomGb === undefined ? require('./memory-levers.cjs').DEFAULTS.vram_headroom_gb : headroomGb;
  const r = await GS.probeOnce([model], { headroomMb: Math.round(hr * 1024) });
  if (!(r && r.ok)) { const f = (r && r.refusal) || { reason: 'probe_failed', message: 'the GPU probe returned nothing', options: [] }; throw err('E_MODEL_ABSENT', `the GPU probe refused ${model} (${f.reason}): ${f.message}. Options: ${(f.options || []).join('; ') || 'none'}`, { gpu: true, cause: 'probe_refused', refusal: f }); }
}

async function drainHeavy(E, tierKey, { namespaces, onProgress, boundMs = DEFAULT_BOUND_MS, batch = BATCH, probe = false, headroomGb, cancelled, now = () => Date.now() } = {}) {
  const key = keyOfModel(tierKey);
  const db = E.store.db;
  const t0 = now();
  if (probe) await probeFirst(key.model, headroomGb);
  const missing = MV.backlog(db, key, { namespaces });
  const total = missing.length;
  const impl = total ? EP.get({ embedder: key.model }, { owner: E.owner || false }) : null;
  if (total && !impl) throw err('E_NO_EMBEDDER', `no embedder for ${key.model} is available here (only the store owner loads a heavy embedder)`, { embedder: key.model });
  for (let i = 0; i < total; i += batch) {
    if (i > 0 && now() - t0 >= boundMs) break;
    if (cancelled && cancelled()) break; // the owner is stopping (or the catch-up was ended): no further batch
    try { await embedIds(E, key, impl, missing.slice(i, i + batch).map((r) => r.id), { deadline: t0 + boundMs, cancelled, now }); } catch (e) {
      e.detail = { ...(e.detail || {}), written: total - MV.backlog(db, key, { namespaces }).length, embedder: key.model };
      throw e;
    }
    if (onProgress) { try { onProgress({ embedder: key.model, done: Math.min(i + batch, total), total }); } catch { /* a progress sink never stops the drain */ } }
  }
  const remaining = MV.backlog(db, key, { namespaces }).length;
  return { embedder: key.model, dims: key.dims, total, written: total - remaining, remaining, done: remaining === 0, ms: now() - t0 };
}

// The method behind `belay memory embed --model <gguf id>` (owner write, operator only): one bounded drain.
// args: { model, project?, namespaces?, bound_ms? }; the namespaces default to project/<project>.
async function drainMethod(E, caller, args = {}) {
  if (typeof args.model !== 'string' || !args.model) throw err('E_ARGS', 'memory.drainHeavy needs the heavy embedder model id', { field: 'model' });
  let namespaces = args.namespaces;
  if (namespaces === undefined && typeof args.project === 'string' && args.project) namespaces = [`project/${args.project}`];
  if (!Array.isArray(namespaces) || !namespaces.length || namespaces.some((n) => typeof n !== 'string' || !n)) throw err('E_ARGS', 'memory.drainHeavy needs a project or a list of namespaces', { field: 'namespaces' });
  const bound = args.bound_ms === undefined ? DEFAULT_BOUND_MS : args.bound_ms;
  if (!Number.isInteger(bound) || bound < 1 || bound > 120000) throw err('E_ARGS', 'memory.drainHeavy bound_ms must be an integer from 1 to 120000', { field: 'bound_ms' });
  return drainHeavy(E, args.model, { namespaces, cancelled: () => !!(E.owner && typeof E.owner === 'object' && E.owner.stopped), boundMs: bound, probe: args.probe === true, headroomGb: typeof args.headroom_gb === 'number' ? args.headroom_gb : undefined });
}

module.exports = { embedIds, drainHeavy, drainMethod, backlogOf, keyOfModel, DEFAULT_BOUND_MS };
