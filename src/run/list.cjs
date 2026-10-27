'use strict';
// list.cjs — build step 6e-4, design item 1. `list` moved
// verbatim out of manager.cjs to keep that file under the repository's 500-line rule.

const PI = require('./pid-identity.cjs');

// The worker's task is the one its newest lease names (core's worker.list derives it); the record's taskId is spawn-only, so it
// stays the answer only when the core cannot be read.
async function listWorkers(workers, core) {
  let tasks = null;
  try { tasks = new Map(((await core.worker.list({})).workers || []).map((r) => [r.id, r.task_id])); } catch { tasks = null; }
  return {
    workers: [...workers.values()].map((w) => ({
      id: w.id, pid: w.pid, state: w.state, last_event_at: w.lastEventAt, turns: w.turns,
      substrate: w.substrate, session_id: w.sessionId, pid_alive: PI.pidLive(w), // a settled or terminal record's pid may be reused: never read as alive
      context_tokens: w.contextTokens, task_id: tasks && tasks.has(w.id) ? tasks.get(w.id) : w.taskId,
    })),
  };
}

module.exports = { listWorkers };
