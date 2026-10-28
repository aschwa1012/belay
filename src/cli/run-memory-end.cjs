'use strict';
// run-memory-end.cjs — the run's end-of-run memory jobs, run by `belay run` itself (ADR 0043 decision 2).
//
// The orchestrator's adapter runs them in its own shutdown, after it has stopped each worker (up to 10 s each)
// and drained the memory queues (up to 5 s). Claude Code ends its stdio server 324 to 424 ms after closing the
// server's stdin, with no handlers run, so with any live worker
// that run is cut short and nothing records it. `belay run` owns the store and outlives the adapter: once the
// adapter has closed, the workers are closed and run.end has settled the rows, it runs the same jobs against
// its own store. They are store-only (task and worker rows, memory rows and events) and idempotent with any
// partial run the adapter got through: summaries are once per (task, worker), wrap-ups once per (run, key).
//
// With every job lever off this loads nothing and calls nothing. A failure is never the run's failure: it is on
// the ledger (a `run:gave-up` wrap-up event) and in the receipt, and the exit code does not change.

const RI = require('./run-interactive.cjs');

const anyJob = (lv) => !!(lv && ((lv.summaries && lv.summaries !== 'off') || lv.project_writes || lv.cost_ledger || lv.wrapup || lv.notes));

// `levers` is the parsed spec's lever block (`memory_levers` present only when it differs from the defaults).
// Returns null when no job lever is on, else { outcome, unfinished?, error? } (memory-jobs.cjs runEndJobs), or
// { outcome: 'cut' } when a fast close's deadline passed first.
async function memoryRunEnd({ core, runId, levers, ce = null, late = () => {}, jobs = null }) {
  const lv = levers && levers.memory_levers;
  if (!anyJob(lv)) return null;
  // ADR 0044 decision 6: these rows are belay's, not the operator's; the run process writes them on the harness channel.
  const MJ = jobs || require('../run/memory-jobs.cjs');
  // A cut leaves the jobs running behind it. The gate is how they are told to stop: set before this returns, so nothing they
  // have not yet started is sent, and no write can reach the store after the shutdown that follows (it would elect a new owner).
  const gate = { aborted: false, cut: false };
  const cutLate = (m) => { gate.aborted = true; gate.cut = true; late(m); };
  return RI.within(ce, MJ.runEndJobs({ core: core.harness ? core.harness() : core, runId, levers: lv, gate }), 'the run-end note jobs', { outcome: 'cut' }, cutLate, RI.END_RESERVE_MS);
}

module.exports = { memoryRunEnd };
