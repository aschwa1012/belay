'use strict';
// orchestrator-block.cjs — moved out of orchestrator.cjs (S2 fix round, F4: "Each of manager.cjs and
// orchestrator.cjs stays at or under 500 lines; move a whole function out rather than compress").
// Pure formatting of the run result's `orchestrator` block: no state of its own, no process, no store.

// `child`: the spawned child process (only `.pid` is read). `state`: the orchestrator's own mutable
// run state (orchestrator.cjs). `model`, `argvHash`: this launch's own constants. `initFacts`: ready.cjs's
// pure helper, called with nulls when no ready event ever arrived (state.init stays unset that whole time).
// `usage`: orchestrator-usage.cjs's snapshot (W2-3), surfaced as the block's `usage`; null when none is given.
function buildOrchestratorBlock({ child, state, model, argvHash, initFacts, usage }) {
  return {
    // 5a-3: `pid: child.pid` is `undefined` on a spawn-error path (the exe never started), and
    // JSON.stringify drops an `undefined` key from both --json and run.json. The key must exist on
    // every path.
    pid: child.pid == null ? null : child.pid, session_id: state.sessionId, model, turns: state.turns,
    externally_triggered_turns: state.externallyTriggeredTurns,
    exit_code: state.exitCode, exit_signal: state.exitSignal,
    usage: usage || null, argv_hash: argvHash, ready_ms: state.readyMs, later_inits: state.laterInits,
    killed_after_close: state.killedAfterClose, surface: state.surface, instructions: state.instructions, // ADR 0024, S2 fix round F4; amendment 1
    ...(state.init || initFacts(null, null)),
  };
}

module.exports = { buildOrchestratorBlock };
