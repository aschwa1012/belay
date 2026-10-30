'use strict';
// dead-pids.cjs — a process seen dead stays dead for that life of the row. worker.list reads pid_alive by a bare pid check, and
// Windows hands a dead process's pid to another process within seconds, so a row whose pid read dead can read alive again while
// a stranger holds the number (ADR 0039). The polls that decide holds and wakes (the headless orchestrator's, the interactive wake
// publisher's) read their rows through this: a row in a life-claiming state whose pid read dead keeps reading dead until its row
// changes. No process snapshot is taken for that.
//
// A life is named by the process the row records and by the `starting` row that opened it, never by a possibly-null pid_created or by
// the row's seq (a turn end, a mid-turn refresh and a compaction all restate a live row, and none of them is a new life). The memory
// is forgotten when the pid or creation time changes, when the state leaves a life-claiming one, or when a newer `starting` row lands:
// every launch, fresh or resumed, writes `starting` first. The worst a forgotten entry does is read the pid as the bare check does. Only `starting`,
// `running` and `stopping` rows are remembered; a terminal or parked row has no life to hold open.
//
// The one case a memory cannot cover is a pid reused before it was ever read dead. For a row that records its creation time, whose
// adapter is gone and whose last event is older than the death grace, one identity check (live-as.cjs, one snapshot) is started in
// the background and its verdict used by a later poll; it never delays a poll and runs once per life. The adapter's own pid can be
// reused too, and a bare pid check then calls a dead adapter alive for good; so a row silent for STALE_MS gets the same check whatever
// the adapter's pid answers (an adapter that is alive writes its worker's exit long before then).
const LIFE = new Set(['starting', 'running', 'stopping']);
const STALE_MS = 15 * 60000;
const CHECK_TIMEOUT_MS = 5000; // a stalled snapshot leaves the row reading as the bare check does

function createDeadPids({ now = Date.now, graceMs = 8000, adapterAlive = null, prepare = null, checkTimeoutMs = CHECK_TIMEOUT_MS, staleMs = STALE_MS } = {}) {
  const seen = new Map();    // worker id -> { pid, created, seq, seenAt, by }
  const inflight = new Set();
  const lives = new Map();   // worker id -> { pid, created, lifeSeq }: the life the row is in now
  const checked = new WeakSet(); // lives whose identity check was started
  const preparer = () => prepare || require('../core/live-as.cjs').prepare;

  function check(w, life) {
    checked.add(life);
    const done = (async () => {
      const id = await preparer()([{ pid: w.pid, created: w.pid_created }]);
      if (!id.runsAs(w.pid, w.pid_created) && lives.get(w.id) === life) seen.set(w.id, { pid: w.pid, created: w.pid_created, seenAt: now(), by: 'identity' });
    })().catch(() => {}); // an unreadable snapshot is not proof of death
    const timer = new Promise((r) => { const t = setTimeout(r, checkTimeoutMs); if (t.unref) t.unref(); });
    const p = Promise.race([done, timer]).then(() => inflight.delete(p));
    inflight.add(p);
  }

  // -> rows, with pid_alive false (and pid_dead_seen_at, pid_dead_by) on any life-claiming row whose process was seen dead.
  function apply(rows) {
    return rows.map((w) => {
      if (w.pid == null || typeof w.pid_alive !== 'boolean' || !LIFE.has(w.state)) { seen.delete(w.id); lives.delete(w.id); return w; }
      let life = lives.get(w.id);
      if (!life || life.pid !== w.pid || life.created !== w.pid_created || (w.state === 'starting' && w.seq !== life.lifeSeq)) {
        life = { pid: w.pid, created: w.pid_created, lifeSeq: w.seq };
        lives.set(w.id, life); seen.delete(w.id);
      }
      const e = seen.get(w.id);
      if (w.pid_alive === false) {
        if (!e) seen.set(w.id, { pid: w.pid, created: w.pid_created, seenAt: now(), by: 'pid check' });
        return w;
      }
      if (e) return { ...w, pid_alive: false, pid_dead_seen_at: e.seenAt, pid_dead_by: e.by };
      if (w.pid_created != null && adapterAlive) {
        const age = w.last_event_age_ms != null ? w.last_event_age_ms : now() - Number(w.started_at || now());
        const orphan = !adapterAlive(w.adapter_pid);
        if (((orphan && age > graceMs) || age > staleMs) && !checked.has(life)) check(w, life);
      }
      return w;
    });
  }
  return { apply, settled: () => Promise.all([...inflight]) }; // settled(): for a test to wait on the real event
}

module.exports = { createDeadPids };
