'use strict';
// paused-gate.cjs — the run manager's half of "a paused run starts no new work" (src/core/paused-run.cjs holds the rule): before an
// orchestrator's worker_spawn or worker_restart it asks the core (run.assertNotPaused), which refuses E_PAUSED while the run's row says
// paused, whatever the reason, unless the run's owner says its orchestrator is not gated (an interactive run: the user's own session).
// The owner holds that one fact, so spawn, restart and assign share it and a missing setting fails closed. The operator's spawns and the
// run's own close-stage jobs (made as the operator) are not asked. Cost: one owner call per spawn or restart by an orchestrator.

async function refuseSpawnIfPaused(core, runId) {
  void runId;
  if (!core || !core.caller || core.caller.role !== 'orchestrator') return;
  await core.run.assertNotPaused({});
}

module.exports = { refuseSpawnIfPaused };
