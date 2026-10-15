'use strict';
// run-close-stages.cjs — `belay run`'s call to the run-close stages (the Haiku scrubber, then the Opus archive reviewer). The workers
// are closed and run.end has not been written: the run process still owns the store, so the stages' reads and applies are in-process
// calls on its harness view (ADR 0044 decision 6). With notes off this loads nothing. A failure is never the run's failure: each
// stage records its own receipt and the exit code does not change.

const RI = require('./run-interactive.cjs');

// `levers` is the parsed spec's lever block (`memory_levers` present only when it differs from the defaults).
async function runCloseStages({ core, runId, levers, dataDir, worktree = null, goal = null, summary = null, ce = null, late = () => {}, stages = null, deps = {}, log = null }) {
  const lv = levers && levers.memory_levers;
  if (!lv || !lv.notes) return null;
  const S = stages || require('../run/close-stages.cjs');
  return RI.within(ce, S.closeStages({ core: core.harness ? core.harness() : core, runId, levers: lv, dataDir, worktree, goal, summary, fast: ce ? () => ce.hupSeen() : null, log, ...deps }), 'the run-close stages', { cut: true }, late, RI.END_RESERVE_MS);
}

module.exports = { runCloseStages };
