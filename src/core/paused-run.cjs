'use strict';
// paused-run.cjs — a paused run starts no new work (a proposed amendment to the run pause). While the run's row says paused, the
// orchestrator's task.assign (a worker_spawn with a task assigns too) is refused E_PAUSED, whatever the pause's reason; the operator's
// calls are not. A read of the run row only when the caller is the orchestrator, so no other path pays for it.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');

function pausedMessage(run) {
  return `run ${run.id} is paused (${run.paused_by || 'paused'}), and a paused run starts no new work: wait for the operator's resume; nothing was written`;
}

function refuseIfPaused(E, caller) {
  if (!caller || caller.role !== 'orchestrator' || !caller.run_id) return;
  const run = rows.current(E.store, 'run', caller.run_id);
  if (run && run.paused_at != null && run.ended_at == null) throw err('E_PAUSED', pausedMessage(run), { run_id: run.id, paused_by: run.paused_by, paused_at: run.paused_at });
}

// Wraps a method (E, caller, args): an assign that only checks (`check_only`) writes nothing, so it is allowed.
const gate = (fn) => (E, caller, args) => {
  if (!(args && args.check_only)) refuseIfPaused(E, caller);
  return fn(E, caller, args);
};

module.exports = { refuseIfPaused, gate, pausedMessage };
