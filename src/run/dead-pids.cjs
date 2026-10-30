'use strict';
// dead-pids.cjs — a process seen dead stays dead for that life of the row. worker.list reads pid_alive by a bare pid check, and
// Windows hands a dead process's pid to another process within seconds, so a row whose pid read dead can read alive again while
// a stranger holds the number (ADR 0039). The polls that decide holds and wakes (the headless orchestrator's, the interactive wake
// publisher's) read their rows through this: a row in a life-claiming state whose pid read dead keeps reading dead until its row
// changes. No process snapshot is taken for that.
//
// A life is named by the row's seq, never by a possibly-null pid_created: a relaunch, a restating write or a terminal row is a new
// seq, which forgets the memory, so the worst a forgotten entry does is read the pid as the bare check does. Only `starting`,
// `running` and `stopping` rows are remembered; a terminal or parked row has no life to hold open.
//
const LIFE = new Set(['starting', 'running', 'stopping']);

function createDeadPids({ now = Date.now } = {}) {
  const seen = new Map();    // worker id -> { pid, created, seq, seenAt, by }

  // -> rows, with pid_alive false (and pid_dead_seen_at, pid_dead_by) on any life-claiming row whose process was seen dead.
  function apply(rows) {
    return rows.map((w) => {
      if (w.pid == null || typeof w.pid_alive !== 'boolean' || !LIFE.has(w.state)) { seen.delete(w.id); return w; }
      let e = seen.get(w.id);
      if (e && (e.pid !== w.pid || e.created !== w.pid_created || e.seq !== w.seq)) { seen.delete(w.id); e = undefined; }
      if (w.pid_alive === false) {
        if (!e) seen.set(w.id, { pid: w.pid, created: w.pid_created, seq: w.seq, seenAt: now(), by: 'pid check' });
        return w;
      }
      if (e) return { ...w, pid_alive: false, pid_dead_seen_at: e.seenAt, pid_dead_by: e.by };
      return w;
    });
  }
  return { apply };
}

module.exports = { createDeadPids };
