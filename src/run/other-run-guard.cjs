'use strict';
// other-run-guard.cjs — a run manager acts on workers of its own run, or of a run that has ended (adoption, ADR 0046
// decision 1). A worker of another LIVE run is that run's: its adapter spawned it and watches it, and this one may not
// rewrite its files, hold its task, kill it or launch on its session. Checked when the record is adopted (worker.cjs adopt), before any
// file write, hold, kill or launch (the core refuses the row write too, but only after the manager has acted).
// Known limit: the check runs once per adoption; a run that revives after a record was adopted is not re-checked.

const { fail } = require('./errors.cjs');

async function refuseLiveOtherRun(core, runId, w) { // w: the worker's store row
  const from = w.run_id;
  if (!from || from === runId) return;
  // An authority check does not depend on the shape of what it is handed: no way to ask is a refusal.
  if (!core.run || typeof core.run.list !== 'function') {
    fail('E_ROLE', `worker ${w.id} belongs to run ${from}, and this manager cannot tell whether that run is live, so it may not act on it`, { worker_id: w.id, run_id: runId, worker_run_id: from, reason: 'run_list_unavailable' });
  }
  const { runs } = await core.run.list({});
  const run = (runs || []).find((r) => r.id === from);
  // The core's rule (worker-run-guard.cjs): a run with a row, no ended_at and a live adapter is live. A run with no row, or an
  // ended or dead one, is not, and its worker is adopted.
  if (!run || run.ended_at != null || !run.alive) return;
  fail('E_ROLE', `worker ${w.id} belongs to run ${from}, which is live, so the manager of run ${runId} may not act on it`, { worker_id: w.id, run_id: runId, worker_run_id: from });
}

module.exports = { refuseLiveOtherRun };
