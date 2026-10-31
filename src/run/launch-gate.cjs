'use strict';
// launch-gate.cjs — the checks a spawn makes in the tick before it launches, because a stop or a run pause can overtake it while it
// awaits its levers, its memory preface or its task assignment. Neither can see a worker with no process: a stop finds no pid, and a
// run pause lists only rows with a live pid.

const { fail } = require('./errors.cjs');

// A stop that lands before the launch has written `stopped` (do-stop.cjs). The spawn refuses to launch: the row stays `stopped` and no
// process exists (the bind await in bind-launch.cjs has its own check, for a stop that lands after this one).
function abortIfStopped(w) {
  if (!w.stopRequested) return;
  w.launchFailed = true;
  fail('E_SUBSTRATE', `worker ${w.id}: a stop arrived before the launch; the launch is abandoned and no process was started`, { worker_id: w.id, substrate: w.substrate, state: w.state, reason: 'stopped_during_launch', launched: false });
}

// The paused-run gate again, in the tick before a spawn's or a restart's launch: the entry check passed, a run pause then set the run
// row, and its listing (live pids only) cannot name a worker that has no process yet. Refused E_PAUSED, as at the entry.
const refuseIfPaused = (core, runId) => require('./paused-gate.cjs').refuseSpawnIfPaused(core, runId);

module.exports = { abortIfStopped, refuseIfPaused };
