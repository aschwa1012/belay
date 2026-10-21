'use strict';
// retrieval-pin.cjs — run.pinRouting: the retrieval routing resolved ONCE for a run and recorded on the run row (`retrieval_routing`),
// as the run's memory levers are (ADR 0050 decision 3: "the resolved routing is fixed at spawn for the run"). The run process calls it
// right after run.attach. A search's tier is then read from the row (heavy-tier.cjs); a run with nothing pinned stays on nano.
//
// Steps, in the store owner:
//   1. resolve the run's levers (resolveRouting) wanting a GPU, to learn which GPU models the routing needs;
//   2. when it needs any, run the probe for exactly those models with the vram_headroom_gb lever BEFORE the first GPU load. A refusal
//      is a loud tier failure handled by on_heavy_failure: `fallback` resolves the routing without a GPU (the fallback profile
//      everywhere) and records ONE notice (`gpu_probe_refused`: the probe's reason and options, the roles it moved); `pause` refuses
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

async function pinRouting(E, caller, args = {}) {
  const runId = caller.run_id;
  const prev = rows.current(E.store, 'run', runId);
  if (!prev) throw err('E_NOT_FOUND', `no run row exists for ${runId}`, { run_id: runId });
  if (prev.ended_at != null) throw err('E_ARGS', `run ${runId} has already ended`, { run_id: runId, ended_at: prev.ended_at });
  const levers = leversOfRow(prev);
  const agentTypes = [...new Set([...AGENT_TYPES, ...(Array.isArray(args.agent_types) ? args.agent_types : [])])];
  let routing = resolveRouting({ levers, agentTypes, gpu: true });
  const notices = [];
  let probe = null;
  if (routing.gpu_models.length) {
    const GS = require('./gpu-shared.cjs'); // lazy: only a routing that names a GPU model reaches it
    const r = await GS.probeOnce(routing.gpu_models, { headroomMb: Math.round(routing.levers.vram_headroom_gb * 1024) });
    if (r && r.ok) probe = { ok: true, device: r.device && r.device.name, needed_mb: r.needed_mb, free_mb: r.free_mb, headroom_mb: r.headroom_mb, models: r.models };
    else {
      const refusal = (r && r.refusal) || { reason: 'probe_failed', message: 'the GPU probe returned nothing', options: [] };
      probe = { ok: false, reason: refusal.reason, message: refusal.message };
      if (routing.levers.on_heavy_failure === 'pause') {
        throw err('E_MODEL_ABSENT', `the GPU probe refused the routing (${refusal.reason}: ${refusal.message}), and on_heavy_failure is pause, so the run was not started on it. Options: ${(refusal.options || []).join('; ') || 'none'}`, { gpu: true, cause: 'probe_refused', refusal });
      }
      const wanted = routing;
      routing = resolveRouting({ levers, agentTypes, gpu: false });
      const moved = wanted.gpu_models.length && routing.notices.length ? routing.notices[0].agent_types : [];
      notices.push({ code: 'gpu_probe_refused', message: `the GPU probe refused this run's routing (${refusal.reason}): ${refusal.message}. The run is served on the ${levers.profile_cpu} profile (nano, no GPU model).`, reason: refusal.reason, options: refusal.options || [], agent_types: moved });
    }
  }
  const behind = [];
  const scope = scopeOf(prev);
  const heavy = heavyEmbedders(routing);
  if (heavy.length) {
    const HD = require('./heavy-drain.cjs');
    for (const id of heavy) { const n = HD.backlogOf(E, id, scope).length; if (n) behind.push({ embedder: id, rows: n, namespaces: scope }); }
  }
  let choice = null;
  if (behind.length) {
    choice = routing.levers.on_heavy_behind;
    if (choice === 'wait') return { pinned: false, action: 'drain', behind, notices, routing };
    routing = demote(routing, new Set(behind.map((b) => b.embedder)));
    notices.push({ code: 'heavy_behind', message: `${behind.map((b) => `${b.embedder} is ${b.rows} note${b.rows === 1 ? '' : 's'} behind`).join('; ')}, and on_heavy_behind is fallback, so the heavy roles use nano for this run; drain with: belay memory embed --model ${behind[0].embedder}`, embedders: behind.map((b) => b.embedder) });
  }
  const record = { v: 1, pinned_at: Date.now(), routing, probe, notices, behind: { choice, embedders: behind } };
  const { appendRun } = require('./methods-run.cjs');
  appendRun(E, { ...prev, retrieval_routing: JSON.stringify(record) }, E.writtenBy(caller));
  E.noteWrite();
  return { pinned: true, action: 'pinned', ...record };
}

module.exports = { pinRouting, AGENT_TYPES, scopeOf };
