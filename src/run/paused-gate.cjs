'use strict';
// paused-gate.cjs — the run manager's half of "a paused run starts no new work" (src/core/paused-run.cjs holds the task.assign half):
// the orchestrator's worker_spawn is refused E_PAUSED while the run's row says paused, whatever the reason. The operator's spawns
// (and the run's own close-stage jobs, which the run process makes as the operator) are not refused. Only a HEADLESS orchestrator is
// gated (the run process puts BELAY_RUN_HEADLESS in its environment; its adapter inherits it): an interactive orchestrator is the
// user's own session, and the operator accepts the user's chat approval there. Cost: one run.get per gated spawn or restart, none otherwise.

const { pausedMessage } = require('../core/paused-run.cjs');

async function refuseSpawnIfPaused(core, runId) {
  if (process.env.BELAY_RUN_HEADLESS !== '1' || !core || !core.caller || core.caller.role !== 'orchestrator') return;
  let run = null;
  try { run = ((await core.run.get({ run_id: runId })) || {}).run || null; } catch { return; } // an unreadable run row refuses nothing here; the spawn's own writes still answer for themselves
  if (run && run.paused_at != null && run.ended_at == null) {
    throw Object.assign(new Error(pausedMessage(run)), { code: 'E_PAUSED', detail: { cause: 'run_paused', run_id: runId, paused_by: run.paused_by, paused_at: run.paused_at } });
  }
}

module.exports = { refuseSpawnIfPaused };
