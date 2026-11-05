'use strict';
// retrieval-pin.cjs — run.pinRouting: the retrieval routing resolved ONCE for a run and recorded on the run row (`retrieval_routing`),
// as the run's memory levers are (ADR 0050 decision 3: "the resolved routing is fixed at spawn for the run"). The run process calls it
// right after run.attach. A search's tier is then read from the row (heavy-tier.cjs); a run with nothing pinned stays on nano.
//
// Steps, in the store owner:
//   1. resolve the run's levers (resolveRouting) wanting a GPU, to learn which GPU models the routing needs;
//   2. when it needs any, run the probe for exactly those models with the vram_headroom_gb lever BEFORE the first GPU load. A refusal
//      is a loud tier failure handled by on_heavy_failure: `fallback` resolves the routing without a GPU (the fallback profile
//      everywhere) and records ONE notice (`gpu_probe_refused`: the probe's reason and options, the roles it moved; `model_corrupt` for a model file that cannot be read, naming the model and file); `pause` refuses
//      to pin and throws, so the run does not start on a tier it cannot serve;
//   3. for each heavy embedder in the routing, count its backlog in the run's scope. A non-empty backlog is on_heavy_behind's business
//      (decision 4: a heavy tier never serves a partial index):
//        wait      nothing is pinned yet; the answer says `action: 'drain'` with the backlogs, the caller drains them
//                  (memory.drainHeavy, with progress) and calls again, and the run starts when they are empty;
//        fallback  the heavy roles use nano for this run (their reranker is kept), with ONE notice (`heavy_behind`);
//   4. record { v, pinned_at, routing, probe, notices, behind } on the run row and return it.
// The choice (on_heavy_behind) and every notice are in the recorded row, so the run receipt and `belay status` can read them.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const RP = require('./retrieval-profiles.cjs');
const { parseMemoryBlock } = require('./memory-levers.cjs');
const { resolveRouting } = require('./retrieval-routing.cjs');

const AGENT_TYPES = ['orchestrator', 'reviewer', 'coder', 'researcher', 'tester'];
const isHeavy = (id) => { const d = id && id !== RP.NANO && RP.describeModel(id); return !!d && d.kind === 'embedder' && d.runtime === 'gguf'; };

function leversOfRow(row) {
  let obj;
  try { obj = row.memory_levers == null ? undefined : (typeof row.memory_levers === 'string' ? JSON.parse(row.memory_levers) : row.memory_levers); } catch { obj = undefined; }
  const parsed = parseMemoryBlock(obj || undefined);
  if (parsed.error) throw err('E_ARGS', `run.pinRouting: the run's memory levers are not valid: ${parsed.error}`, { reason: 'levers' });
  return parsed.value;
}

// The namespaces a run's searches serve by default: its project's notes and its own run rows.
const scopeOf = (row) => [...(row.project ? [`project/${row.project}`] : []), `run/${row.id}`];

const tiersOf = (r) => [r.run, ...Object.values(r.tiers)];
const heavyEmbedders = (r) => [...new Set(tiersOf(r).map((t) => t.embedder).filter(isHeavy))].sort();
const gpuModelsOf = (r) => [...new Set(tiersOf(r).flatMap((t) => [t.embedder, t.reranker]).filter((id) => id && RP.describeModel(id).device === 'gpu'))].sort();

// The routing with every heavy embedder in `behind` replaced by nano (the reranker is kept), the way the fallback profile does for a missing GPU.
function demote(r, behind) {
  const swap = (t) => (behind.has(t.embedder) ? { ...t, embedder: RP.NANO, profile: RP.CUSTOM, device: RP.needsGpu({ embedder: RP.NANO, reranker: t.reranker }) ? 'gpu' : 'cpu', fallback_from: t.fallback_from || t.profile } : t);
  const out = { ...r, run: swap(r.run), tiers: Object.fromEntries(Object.entries(r.tiers).map(([k, t]) => [k, swap(t)])) };
  out.gpu_models = gpuModelsOf(out);
  return out;
}

// A probe refusal or a warm-up failure is a loud tier failure, and on_heavy_failure decides: `pause` refuses to pin (E_MODEL_ABSENT, the
// run does not start on a tier it cannot serve); `fallback` serves the fallback profile everywhere with ONE notice.
function tierFailure(ctx, code, cause, message, extra) {
  if (ctx.levers.on_heavy_failure === 'pause') {
    throw err('E_MODEL_ABSENT', `${message}, and on_heavy_failure is pause, so the run was not started on it${extra && extra.options && extra.options.length ? `. Options: ${extra.options.join('; ')}` : ''}`, { gpu: true, cause, ...(extra || {}) });
  }
  const was = ctx.routing;
  // The profile a run falls back to is profile_cpu, unless the model that failed is part of profile_cpu itself (a CPU reranker that is not fetched): then
  // the fallback profile proper (nano, no reranker), which needs no model but nano.
  const cpuModels = ctx.levers.profile_cpu === RP.CUSTOM ? [ctx.levers.embedder, ctx.levers.reranker] : Object.values(RP.profileModels(ctx.levers.profile_cpu));
  const target = extra && extra.model && cpuModels.includes(extra.model) ? RP.FALLBACK_PROFILE : ctx.levers.profile_cpu;
  ctx.routing = resolveRouting({ levers: { ...ctx.levers, profile: target, routing: null }, agentTypes: ctx.agentTypes, gpu: false });
  const from = (k) => (k === 'run' ? was.run : was.tiers[k]).profile;
  ctx.routing.run = { ...ctx.routing.run, fallback_from: from('run') };
  for (const k of Object.keys(ctx.routing.tiers)) ctx.routing.tiers[k] = { ...ctx.routing.tiers[k], fallback_from: from(k) };
  const moved = [...new Set(Object.entries(was.tiers).filter(([, t]) => t.device === 'gpu' || t.reranker || t.embedder !== RP.NANO).map(([k]) => k))];
  ctx.notices.push({ code, message: `${message}. ${extra && extra.model && !/fetch it with/i.test(message) && RP.describeModel(extra.model) && RP.describeModel(extra.model).runtime === 'onnx' ? `Fetch it with: belay embedder fetch --reranker ${extra.model}. ` : ''}The run is served on the ${target} profile${target === RP.FALLBACK_PROFILE ? ' (nano, no reranker)' : ''}.`, ...(extra && extra.reason ? { reason: extra.reason } : {}), options: (extra && extra.options) || [], agent_types: moved });
}

async function pinRouting(E, caller, args = {}) {
  const runId = caller.run_id;
  const prev = rows.current(E.store, 'run', runId);
  if (!prev) throw err('E_NOT_FOUND', `no run row exists for ${runId}`, { run_id: runId });
  if (prev.ended_at != null) throw err('E_ARGS', `run ${runId} has already ended`, { run_id: runId, ended_at: prev.ended_at });
  const levers = leversOfRow(prev);
  const agentTypes = [...new Set([...AGENT_TYPES, ...(Array.isArray(args.agent_types) ? args.agent_types : [])])];
  const ctx = { levers, agentTypes, routing: resolveRouting({ levers, agentTypes, gpu: true }), notices: [] };
  let probe = null, warm = null;
  if (ctx.routing.gpu_models.length) {
    const GS = require('./gpu-shared.cjs'); // lazy: only a routing that names a GPU model reaches it
    GS.recycle(); // a child that died or hung under an earlier run is forgotten, so this pin probes and forks afresh
    // The first probe's verdict stands for this model set and headroom (gpu-shared.cjs): a second pin after a drain does not probe again.
    const r = await GS.probeOnce(ctx.routing.gpu_models, { headroomMb: Math.round(ctx.routing.levers.vram_headroom_gb * 1024), runId });
    if (r && r.ok) probe = { ok: true, device: r.device && r.device.name, needed_mb: r.needed_mb, free_mb: r.free_mb, headroom_mb: r.headroom_mb, models: r.models };
    else {
      const refusal = (r && r.refusal) || { reason: 'probe_failed', message: 'the GPU probe returned nothing', options: [] };
      probe = { ok: false, reason: refusal.reason, message: refusal.message };
      // A model file that cannot be read is a fact about that file, not about the GPU or the probe: it keeps the handling (on_heavy_failure) and says so.
      if (refusal.reason === 'model_corrupt') tierFailure(ctx, 'model_corrupt', 'model_corrupt', refusal.message, { refusal, reason: refusal.reason, options: refusal.options || [], model: r && r.model, file: r && r.file });
      else tierFailure(ctx, 'gpu_probe_refused', 'probe_refused', `the GPU probe refused this run's routing (${refusal.reason}): ${refusal.message}`, { refusal, reason: refusal.reason, options: refusal.options || [] });
    }
  }
  const behind = [];
  const scope = scopeOf(prev);
  for (const id of heavyEmbedders(ctx.routing)) {
    const n = require('./heavy-drain.cjs').backlogOf(E, id, scope).length;
    if (n) behind.push({ embedder: id, rows: n, namespaces: scope });
  }
  let choice = null;
  if (behind.length) {
    // A drain the caller tried and that FAILED is a heavy failure it already handled (on_heavy_failure fallback): demote, with ONE notice.
    const failed = new Map((Array.isArray(args.drain_failed) ? args.drain_failed : []).filter((d) => d && typeof d.embedder === 'string').map((d) => [d.embedder, d]));
    choice = behind.every((b) => failed.has(b.embedder)) && failed.size ? 'fallback' : ctx.routing.levers.on_heavy_behind;
    if (choice === 'wait') return { pinned: false, action: 'drain', behind, notices: ctx.notices, routing: ctx.routing };
    ctx.routing = demote(ctx.routing, new Set(behind.map((b) => b.embedder)));
    const drainFailure = behind.map((b) => failed.get(b.embedder)).find(Boolean);
    ctx.notices.push({ code: drainFailure ? 'heavy_drain_failed' : 'heavy_behind', message: drainFailure ? `the ${drainFailure.embedder} embedder failed while draining its backlog (${drainFailure.code}: ${drainFailure.message}), and on_heavy_failure is fallback, so the heavy roles use nano for this run; drain with: belay memory embed --model ${behind[0].embedder}` : `${behind.map((b) => `${b.embedder} is ${b.rows} note${b.rows === 1 ? '' : 's'} behind`).join('; ')}, and on_heavy_behind is fallback, so the heavy roles use nano for this run; drain with: belay memory embed --model ${behind[0].embedder}`, embedders: behind.map((b) => b.embedder) });
  }
  // Warm-up (after the probe, before the run's first prompt): every model of the final routing is loaded now, so the first rerank or heavy
  // query of the run pays no cold load. A failure is a tier failure like a probe refusal.
  if (tiersOf(ctx.routing).some((t) => t.reranker || t.embedder !== RP.NANO)) {
    warm = await require('./retrieval-warm.cjs').warmUp(E, ctx.routing);
    if (!warm.ok) tierFailure(ctx, 'retrieval_warmup_failed', 'warmup_failed', `warming ${warm.model} failed (${warm.code}): ${warm.message}`, { model: warm.model, reason: warm.code });
  }
  // The row is read AGAIN after every await above (a probe and a warm-up take minutes): a run that ended meanwhile is refused, and the
  // record is merged onto the fresh row, never onto the stale copy (which would resurrect the run or clear a pause).
  const fresh = rows.current(E.store, 'run', runId);
  if (!fresh) throw err('E_NOT_FOUND', `no run row exists for ${runId}`, { run_id: runId });
  if (fresh.ended_at != null) throw err('E_ARGS', `run ${runId} ended while its routing was being resolved, so nothing was pinned`, { run_id: runId, ended_at: fresh.ended_at });
  const record = { v: 1, pinned_at: Date.now(), routing: ctx.routing, probe, warm: warm && warm.ok ? warm.models : null, ...(warm && warm.ok ? { warmups: require('./rerank-warm-record.cjs').fromPin(warm.models, Date.now()) } : {}), notices: ctx.notices, behind: { choice, embedders: behind } };
  require('./methods-run.cjs').appendRun(E, { ...fresh, retrieval_routing: JSON.stringify(record) }, E.writtenBy(caller));
  E.noteWrite();
  return { pinned: true, action: 'pinned', ...record };
}

module.exports = { pinRouting, AGENT_TYPES, scopeOf };
