'use strict';
// worker-run-guard.cjs — which worker rows an orchestrator may write (worker.write in methods-run.cjs).

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');

// Audit 0.3.1 P6: an orchestrator writes worker rows of its own run only. It may name no other run, and a worker row that
// belongs to another live run is that run's; one whose run has ended or died (or has no run row) may be adopted into
// the caller's run, as a relaunch of an adopted worker does (ADR 0046 decision 1). The operator is unaffected.
function refuseOtherRun(E, caller, args, prev) {
  if (args.run_id != null && args.run_id !== caller.run_id) {
    throw err('E_ROLE', `an orchestrator writes worker rows of its own run ${caller.run_id}, and this write named run ${args.run_id}; worker ${args.id} was not written`, { worker_id: args.id, run_id: caller.run_id, named_run_id: args.run_id });
  }
  if (!prev || !prev.run_id || prev.run_id === caller.run_id) return;
  // Live by the rule run.list and the task holds use: a run row with no ended_at whose adapter pid answers a pid check.
  if (rows.current(E.store, 'run', prev.run_id) && require('./task-holds.cjs').runLiveness(E.store)(prev.run_id).live) {
    throw err('E_ROLE', `worker ${args.id} belongs to run ${prev.run_id}, which is live, so the orchestrator of run ${caller.run_id} may not write it`, { worker_id: args.id, run_id: caller.run_id, worker_run_id: prev.run_id });
  }
}

module.exports = { refuseOtherRun };
