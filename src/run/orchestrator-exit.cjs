'use strict';
// orchestrator-exit.cjs — moved out of orchestrator.cjs (S2 fix round 2: keeping the file at or under
// its own 500-line budget after the fix-round-2 race fix, rather than compressing any line).
// 5c: `belay stop`'s own facts, set by a second 'exit' listener after the one that finalises `state`.

// `child`, `state`, `t0` are orchestrator.cjs's own (read only, never mutated here beyond exitFacts
// itself); `closeThenKillOnDeadline` is its existing stdin-close-then-kill bound, called unchanged.
function createExitTracking({ child, state, t0, closeThenKillOnDeadline }) {
  let exitFacts = null;
  const exitWaiters = [];

  function noteExit() {
    exitFacts = {
      pid: child.pid, exit_code: state.exitCode, exit_signal: state.exitSignal,
      killed_after_close: state.killedAfterClose, ended_by: state.endedBy, ms: Date.now() - t0,
    };
    for (const w of exitWaiters.splice(0)) w();
  }

  async function stopForControl(reason) {
    await closeThenKillOnDeadline(reason);
    if (!exitFacts) await new Promise((resolve) => exitWaiters.push(resolve));
    return exitFacts;
  }

  return { noteExit, stopForControl, getExitFacts: () => exitFacts };
}

module.exports = { createExitTracking };
