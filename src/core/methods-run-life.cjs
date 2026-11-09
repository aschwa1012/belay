'use strict';
// run.setPaused, run.setEmbedderMode and run.end, split from methods-run.cjs (a pure move; methods-run.cjs re-exports them).
const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const { resolveParks, parseRunRow, clearedPause, pauseFields } = require('./pause-parks.cjs');
const { closeEpochWorkers, fillMissingHeads } = require('./run-close-rows.cjs');
const M = () => require('./methods-run.cjs'); // read at call time: methods-run.cjs requires this file

// build step 6f, ADR 0023 amendment 3 decision 4.1, extended by build step 6i-2 design item 1 (amendment
// 4 decisions 1, 3): writes a run's own pause, open to orchestrator and operator. `args.at`/`args.by`/
// `args.parks` are stamped as given -- the run process's own core is bound to its own identity, never
// the pause's real caller -- and `pause_parks` is cleared to null whenever `paused` is false.
async function setPaused(E, caller, args) {
  if (typeof args.paused !== 'boolean') throw err('E_ARGS', 'run.setPaused needs paused as a boolean');
  const prev = rows.current(E.store, 'run', caller.run_id);
  if (!prev) throw err('E_NOT_FOUND', `no run row exists for ${caller.run_id}`, { run_id: caller.run_id });
  if (prev.ended_at != null) throw err('E_ARGS', `run ${caller.run_id} has already ended`, { run_id: caller.run_id, ended_at: prev.ended_at });
  const parks = resolveParks(args); // item 1 (amendment 4 decisions 1, 3) + fix-up (b): pause-parks.cjs refuses parks without paused: true
  const t = Date.now();
  const pausedAt = Number.isInteger(args.at) ? args.at : t;
  const pausedBy = typeof args.by === 'string' && args.by ? args.by : E.writtenBy(caller);
  const row = M().appendRun(E, { ...prev, ...pauseFields(args.paused, pausedAt, pausedBy, parks) }, E.writtenBy(caller), t); // item e
  E.noteWrite();
  return row;
}

// The run's current on_embedder_failure mode, written to its row when a resume switches it (belay resume --embedder keyword|off), so a reader
// with no owner guard (a copy fallback) sees the live mode. The guard in the run process stays the authority; this is its record.
async function setEmbedderMode(E, caller, args) {
  const mode = require('./embedder-mode.cjs').normalize(args.mode);
  if (mode === null) throw err('E_ARGS', 'run.setEmbedderMode needs mode: required, keyword or off', { mode: args.mode });
  const prev = rows.current(E.store, 'run', caller.run_id);
  if (!prev) throw err('E_NOT_FOUND', `no run row exists for ${caller.run_id}`, { run_id: caller.run_id });
  if (prev.ended_at != null) throw err('E_ARGS', `run ${caller.run_id} has already ended`, { run_id: caller.run_id, ended_at: prev.ended_at });
  const row = M().appendRun(E, { ...prev, embedder_mode: mode }, E.writtenBy(caller));
  E.noteWrite();
  return row;
}

// The substrate moved the orchestrator's session to another model: written to the run row when it happens (not only at run.end), so a reader of a live run sees it.
// `orch_model` follows the new model; run.end's usage replaces both with the run's own accumulator. A fact only; nothing is decided or refused.
async function setModelFallback(E, caller, args) {
  const fb = require('./model-switch.cjs').shape(args);
  if (!fb || !fb.to) throw err('E_ARGS', 'run.setModelFallback needs the model the session moved to (to)');
  const prev = rows.current(E.store, 'run', caller.run_id);
  if (!prev) throw err('E_NOT_FOUND', `no run row exists for ${caller.run_id}`, { run_id: caller.run_id });
  if (prev.ended_at != null) throw err('E_ARGS', `run ${caller.run_id} has already ended`, { run_id: caller.run_id, ended_at: prev.ended_at });
  const row = M().appendRun(E, { ...prev, orch_model: fb.to, orch_model_fallback: fb }, E.writtenBy(caller));
  E.noteWrite();
  return row;
}

// Build step W2-3 (S4b): the orchestrator's usage, as typed. `orch_model` is a string, the rest numbers;
// a null or absent field is left to the row (null on a crashed run). A usage problem never stops a run ending (amendment 1, SF2): an invalid field is dropped and named in `invalid_usage` on the result.
const USAGE_FIELDS = { orch_model: 'string', orch_input_tokens: 'number', orch_output_tokens: 'number',
  orch_cache_read_tokens: 'number', orch_cache_creation_tokens: 'number', orch_cost_usd: 'number', orch_turns: 'number', orch_model_fallback: 'object' };
function usageColumns(usage) {
  const out = {};
  const invalid = [];
  if (usage == null) return { out, invalid };
  if (typeof usage !== 'object' || Array.isArray(usage)) return { out, invalid: [{ field: 'usage', reason: 'must be an object of orch_* fields' }] };
  for (const [k, v] of Object.entries(usage)) {
    if (!(k in USAGE_FIELDS)) { invalid.push({ field: k, reason: 'unknown field' }); continue; }
    if (v == null) continue;
    if (typeof v !== USAGE_FIELDS[k] || (typeof v === 'number' && !Number.isFinite(v))) {
      invalid.push({ field: k, reason: `must be a ${USAGE_FIELDS[k]}, and this call carried ${JSON.stringify(v)}` });
      continue;
    }
    out[k] = v;
  }
  return { out, invalid };
}

// The orchestrator tree kill the run process made (orchestrator.cjs `state.kill`): { signalled_at, killed_processes: [{ pid, image }] }.
// Malformed input names no kill, so a row falls back to the plain "no adapter wrote its exit" wording.
function treeKillOf(v) {
  if (!v || typeof v !== 'object' || !Number.isSafeInteger(v.signalled_at) || !Array.isArray(v.killed_processes)) return null;
  const pids = new Map();
  for (const p of v.killed_processes) if (p && Number.isSafeInteger(p.pid) && Number.isFinite(p.created)) pids.set(p.pid, p.created); // pid -> creation time: a pid alone proves nothing (ADR 0039)
  return pids.size ? { signalled_at: v.signalled_at, pids } : null;
}

async function end(E, caller, args) {
  if (!args.exit_reason) throw err('E_ARGS', 'run.end needs an exit_reason naming why the run ended');
  const { out: usage, invalid } = usageColumns(args.usage);
  const prev = rows.current(E.store, 'run', caller.run_id);
  if (!prev) throw err('E_NOT_FOUND', `no run row exists for ${caller.run_id}, so there is nothing to end`, { run_id: caller.run_id });
  // Audit D42: a run that has ended is ended once. A second end from a process launched for the run (the orchestrator role)
  // answers with the row as it stands and writes nothing, so it cannot replace the ended_at, exit_reason or usage the run
  // process recorded. The run process (role operator) closes its own run and keeps the whole call.
  if (prev.ended_at != null && caller.role !== 'operator') return { ...parseRunRow(prev), workers_marked_dead: [], heads_filled: [], already_ended: true };
  const t = Date.now();
  // 6f-2 design item 4 (should-fix, methods-run.cjs:77, first review 1b): a pause ends with its run — the
  // ended row never claims one, so a re-run under the same run id starts its next epoch unpaused too
  // (run.attach's own `carryPause` above), and `belay pause` never answers `already: true` over nothing.
  const row = M().appendRun(E, { ...prev, ended_at: t, exit_reason: String(args.exit_reason), ...usage, ...clearedPause() }, E.writtenBy(caller), t); // item e
  E.noteWrite();
  // Only the run process (operator) names a tree kill it made; an orchestrator's adapter cannot attribute a death to belay (invariant 3 and ADR 0045: the caller's role comes from its bound identity, never from what it says).
  const treeKill = caller.role === 'operator' ? treeKillOf(args.tree_kill) : null;
  const workersMarkedDead = await closeEpochWorkers(E, caller.run_id, E.writtenBy(caller), M().LIFE_CLAIMING_STATES, treeKill);
  const headsFilled = await fillMissingHeads(E, caller.run_id, E.writtenBy(caller), new Set(workersMarkedDead.map(m => m.worker_id)));
  if (workersMarkedDead.length || headsFilled.some(h => h.head_sha != null)) E.noteWrite();
  const out = { ...row, workers_marked_dead: workersMarkedDead, heads_filled: headsFilled };
  return invalid.length ? { ...out, invalid_usage: invalid } : out;
}
module.exports = { setPaused, setEmbedderMode, setModelFallback, end, usageColumns };
