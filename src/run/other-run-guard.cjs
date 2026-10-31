'use strict';
// other-run-guard.cjs — a run manager acts on workers of its own run, or of a run that has ended (adoption, ADR 0046
// decision 1). A worker of another LIVE run is that run's: its adapter spawned it and watches it, and this one may not
// rewrite its files, hold its task, kill it or launch on its session. Checked when the record is adopted, before any
// file write, hold, kill or launch (the core refuses the row write too, but only after the manager has acted).

const { fail } = require('./errors.cjs');

async function refuseLiveOtherRun(core, runId, w) {
  const from = w.adopted && w.adopted.from_run_id;
  if (!from || from === runId || !core.run || typeof core.run.list !== 'function') return;
  const { runs } = await core.run.list({});
  const run = (runs || []).find((r) => r.id === from);
  // The same rule the core uses (task-holds.runLiveness): no run row counts as live; an ended or dead adapter does not.
  if (run && (run.ended_at != null || !run.alive)) return;
  fail('E_ROLE', `worker ${w.id} belongs to run ${from}, which is live, so the manager of run ${runId} may not act on it`, { worker_id: w.id, run_id: runId, worker_run_id: from });
}

module.exports = { refuseLiveOtherRun };
