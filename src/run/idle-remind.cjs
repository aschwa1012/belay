'use strict';
// idle-remind.cjs — ADR 0058, the idle-workers amendment (proposed): nothing reminded the orchestrator of a worker it left idle with no task, so
// one ran on until someone asked. A worker is `idle_without_task` when its process is live, it is between turns, it has been so
// for at least the reminder threshold, and it holds no unreleased worker lease. All four are derived (invariant 4): the record's
// or the row's own state, a pid check, the last turn's or event's age, and the task rows' leases. belay's own jobs are never named.
// worker_wait's answer carries the ids. A wake does not: a coder kept idle for its review's fix round is not a worker to stop.

const { isJobId } = require('./job-prefixes.cjs');

const IDLE_REMIND_MS = 120000;
const thresholdMs = () => {
  const n = Number(process.env.BELAY_IDLE_REMIND_MS);
  return process.env.BELAY_TEST_MODE === '1' && Number.isInteger(n) && n >= 0 ? n : IDLE_REMIND_MS; // the knob is test-only
};

// The ids of workers holding an unreleased worker lease, from one task read. null when the tasks cannot be read: no claim then.
async function holders(core) {
  try {
    const tasks = ((await core.task.list({ states: ['assigned'] })) || {}).tasks || [];
    return new Set(tasks.filter((t) => t.lease && t.lease.holder_role === 'worker').map((t) => t.lease.holder));
  } catch { return null; }
}

// worker_wait: this run manager's own records. The tasks are read only when some record is idle long enough.
async function idleRecords(core, records, now = Date.now(), ms = thresholdMs()) {
  const idle = [...records].filter((w) => w.child && !w.settled && w.turnEnded && !w.stopRequested && !w.parkRequested && !w.op && !isJobId(String(w.id))
    && now - (w.lastTurnEndAt || w.lastEventAt || now) >= ms);
  if (!idle.length || !core || !core.task) return [];
  const held = await holders(core);
  return held ? idle.filter((w) => !held.has(w.id)).map((w) => w.id) : [];
}

module.exports = { idleRecords, IDLE_REMIND_MS };
