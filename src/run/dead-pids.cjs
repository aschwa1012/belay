'use strict';
// dead-pids.cjs — a process seen dead stays dead for the run. worker.list reads pid_alive by a bare pid check, and Windows hands a
// dead process's pid to another process within seconds, so a row whose pid read dead can read alive again while a stranger holds
// the number (ADR 0039). The run's polls decide holds and wakes from that field; this remembers each {pid, pid_created} that
// has read dead and keeps reading it dead, with no process snapshot. A relaunch is a different process: its pid or creation time
// differs, so it is a new key.
function createDeadPids() {
  const seen = new Set();
  const key = (w) => `${w.id}|${w.pid}|${w.pid_created == null ? '' : w.pid_created}`;
  // -> rows, with pid_alive false on any row whose process this run has already seen dead.
  function apply(rows) {
    return rows.map((w) => {
      if (w.pid == null || typeof w.pid_alive !== 'boolean') return w;
      const k = key(w);
      if (!w.pid_alive) { seen.add(k); return w; }
      return seen.has(k) ? { ...w, pid_alive: false } : w;
    });
  }
  return { apply };
}

module.exports = { createDeadPids };
