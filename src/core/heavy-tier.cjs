'use strict';
// heavy-tier.cjs — which retrieval tier a caller's searches run on (ADR 0050 decision 3), read from the routing the run was PINNED
// with (retrieval-pin.cjs, recorded on the run row as `retrieval_routing`), and the run's sticky tier fallback (decision 6).
//
// IDENTITY (invariant 3, ADR 0045): the agent type is read from the caller's process-bound identity, never from a request.
//   orchestrator  the role the owner derived for the connection: the pinned tier of `orchestrator`
//   worker        the agent_type on the worker row the harness wrote at spawn (`worker_spawn`'s agent_type), found by the caller's
//                 worker id, which the adapter's process arguments fixed. A worker with no agent type, or one whose row names another
//                 run, gets the run tier. A worker can never name `orchestrator`: that type is ignored on a worker row.
//   operator / harness / anything else   the run tier.
// A run with no pinned routing (an older run, or one never pinned) is on nano with no reranker, exactly as before this existed.
// This file reads rows and tables only: no model, no process, no GPU module (invariant 9).

const rows = require('./rows.cjs');
const RP = require('./retrieval-profiles.cjs');

const ROLE_TYPE = 'orchestrator';

function runOf(E, runId) {
  if (!runId) return null;
  try { return rows.current(E.store, 'run', runId) || null; } catch { return null; }
}
function pinOfRow(run) {
  if (!run || !run.retrieval_routing) return null;
  try { const p = typeof run.retrieval_routing === 'string' ? JSON.parse(run.retrieval_routing) : run.retrieval_routing; return p && p.routing && p.routing.run ? p : null; } catch { return null; }
}
const pinOf = (E, runId) => pinOfRow(runOf(E, runId));

// The agent type the harness spawned `workerId` with, or null.
function agentTypeOfWorker(E, runId, workerId) {
  if (!workerId) return null;
  let w;
  try { w = rows.current(E.store, 'worker', workerId); } catch { return null; }
  if (!w || w.run_id !== runId || typeof w.agent_type !== 'string' || !w.agent_type || w.agent_type === ROLE_TYPE) return null;
  return w.agent_type;
}

// A heavy embedder's tier carries the table's dims and revision (the pinned commit), which the vector cache is keyed by.
function withDims(tier) {
  if (!tier || tier.embedder === RP.NANO || !tier.embedder) return tier;
  const d = RP.describeModel(tier.embedder);
  if (!d || d.runtime !== 'gguf' || d.kind !== 'embedder') return tier;
  try {
    const e = require('./gguf-models.cjs').ggufFor(tier.embedder, process.env.BELAY_TEST_MODE === '1' ? seamTable : undefined); // a pure table
    return { ...tier, dims: e.dims, revision: e.sha };
  } catch { return tier; } // no dims: assertServable then refuses by name
}
let seamTable;
function setTestTable(t) { if (process.env.BELAY_TEST_MODE !== '1') throw new Error('setTestTable is a test seam'); seamTable = t; }

// The run's sticky fallback to the fallback profile, once a heavy tier failed under on_heavy_failure `fallback`. It is a fact of the RUN
// ROW (inside retrieval_routing: { cause, at, epoch }), so it survives an owner restart, is visible to status and the receipt, and ends
// with the epoch it was written in (a resume attaches a new epoch, as the rerank sticky does).
const FALLBACK_TIER = Object.freeze({ profile: RP.FALLBACK_PROFILE, embedder: RP.NANO, reranker: null, device: 'cpu', depth: 0, source: 'fallback' });
// Owner only (a copy never writes, invariant 6): a copy-served search falls back for that search alone. True when this call wrote it.
function setFallback(E, caller, cause) {
  const runId = caller && caller.run_id;
  if (!runId || !E.owner) return false;
  const run = runOf(E, runId), pin = pinOfRow(run);
  if (!pin || run.ended_at != null || (pin.fallback && pin.fallback.epoch === run.epoch)) return false;
  pin.fallback = { cause: { code: cause.code || null, reason: cause.reason || null, message: String(cause.message || '').slice(0, 400) }, at: Date.now(), epoch: run.epoch };
  require('./methods-run.cjs').appendRun(E, { ...run, retrieval_routing: JSON.stringify(pin) }, E.writtenBy(caller));
  if (E.noteWrite) E.noteWrite();
  return true;
}
function fallbackOf(E, runId) {
  const run = runOf(E, runId), pin = pinOfRow(run);
  return pin && pin.fallback && pin.fallback.epoch === run.epoch ? pin.fallback : null;
}

// The pinned tier for `agentType` ('orchestrator', a worker type, or null for the run tier), or null when the run has none pinned.
function tierOfType(E, runId, agentType) {
  const run = runOf(E, runId), pin = pinOfRow(run);
  if (!pin) return null;
  const fb = pin.fallback && pin.fallback.epoch === run.epoch ? pin.fallback : null;
  if (fb) return { ...FALLBACK_TIER, fallback_from: pin.routing.run.profile, fallback_cause: fb.cause };
  const t = agentType && Object.prototype.hasOwnProperty.call(pin.routing.tiers || {}, agentType) ? pin.routing.tiers[agentType] : pin.routing.run;
  return withDims(t);
}

function pinnedTier(E, caller) {
  if (!caller || !caller.run_id) return null;
  const type = caller.role === 'orchestrator' ? ROLE_TYPE : caller.role === 'worker' ? agentTypeOfWorker(E, caller.run_id, caller.worker_id) : null;
  return tierOfType(E, caller.run_id, type);
}

// The tier of the worker a first-message index is FOR (the harness asks as the orchestrator, naming the worker it spawned).
function tierForWorker(E, caller, workerId) {
  if (!caller || !caller.run_id) return null;
  return tierOfType(E, caller.run_id, agentTypeOfWorker(E, caller.run_id, workerId));
}

module.exports = { pinOf, pinOfRow, pinnedTier, tierForWorker, tierOfType, agentTypeOfWorker, withDims, setFallback, fallbackOf, FALLBACK_TIER, setTestTable };
