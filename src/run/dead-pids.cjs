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
// The one case a memory cannot cover is a pid reused before it was ever read dead. For a row that records its creation time, whose
// adapter is gone and whose last event is older than the death grace, one identity check (live-as.cjs, one snapshot) is started in
// the background and its verdict used by a later poll; it never delays a poll and runs once per row seq.
const LIFE = new Set(['starting', 'running', 'stopping']);
const CHECK_TIMEOUT_MS = 5000; // a stalled snapshot leaves the row reading as the bare check does

function createDeadPids({ now = Date.now, graceMs = 8000, adapterAlive = null, prepare = null, checkTimeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const seen = new Map();    // worker id -> { pid, created, seq, seenAt, by }
  const inflight = new Set();
  const checked = new Set(); // `${id}|${pid}|${created}|${seq}` whose identity check was started
  const preparer = () => prepare || require('../core/live-as.cjs').prepare;

  function check(w, k) {
    checked.add(k);
    const done = (async () => {
      const id = await preparer()([{ pid: w.pid, created: w.pid_created }]);
      if (!id.runsAs(w.pid, w.pid_created)) seen.set(w.id, { pid: w.pid, created: w.pid_created, seq: w.seq, seenAt: now(), by: 'identity' });
    })().catch(() => {}); // an unreadable snapshot is not proof of death
    const timer = new Promise((r) => { const t = setTimeout(r, checkTimeoutMs); if (t.unref) t.unref(); });
    const p = Promise.race([done, timer]).then(() => inflight.delete(p));
    inflight.add(p);
  }

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
      if (w.pid_created != null && adapterAlive && !adapterAlive(w.adapter_pid)) {
        const age = w.last_event_age_ms != null ? w.last_event_age_ms : now() - Number(w.started_at || now());
        const k = `${w.id}|${w.pid}|${w.pid_created}|${w.seq}`;
        if (age > graceMs && !checked.has(k)) check(w, k);
      }
      return w;
    });
  }
  return { apply, settled: () => Promise.all([...inflight]) }; // settled(): for a test to wait on the real event
}

module.exports = { createDeadPids };
