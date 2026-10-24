'use strict';
// list.cjs — build step 6e-4, design item 1. `list` moved
// verbatim out of manager.cjs to keep that file under the repository's 500-line rule.

const PI = require('./pid-identity.cjs');

function listWorkers(workers) {
  return {
    workers: [...workers.values()].map((w) => ({
      id: w.id, pid: w.pid, state: w.state, last_event_at: w.lastEventAt, turns: w.turns,
      substrate: w.substrate, session_id: w.sessionId, pid_alive: PI.pidLive(w), // a settled or terminal record's pid may be reused: never read as alive
      context_tokens: w.contextTokens, task_id: w.taskId,
    })),
  };
}

module.exports = { listWorkers };
