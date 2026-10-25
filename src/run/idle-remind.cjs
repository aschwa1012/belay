'use strict';
// idle-remind.cjs — ADR 0058 amendment 1 (proposed): nothing reminded the orchestrator of a worker it left idle with no task, so
// one ran on until someone asked. A worker is `idle_without_task` when its process is live, it is between turns, it has been so
// for at least the reminder threshold, and it holds no unreleased worker lease. All four are derived (invariant 4): the record's
// or the row's own state, a pid check, the last turn's or event's age, and the task rows' leases. belay's own jobs are never named.
// worker_wait's answer carries the ids; a wake carries them once per idle period when the text has room under the interactive
// budget (WAKE_TEXT_MAX), never as a wake of its own.

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

// A wake's view: this poll's worker.list rows (decorated with pid_alive and last_event_age_ms). A Claude Code worker between turns
// reads `running` with mid_turn 0; a Codex `idle` row has no process by design and costs nothing, so it is not named.
async function idleRows(core, rows, runId, ms = thresholdMs()) {
  const idle = (rows || []).filter((r) => r.run_id === runId && r.pid_alive === true && r.state === 'running' && r.mid_turn === 0 && !isJobId(String(r.id))
    && r.last_event_age_ms != null && r.last_event_age_ms >= ms);
  if (!idle.length) return [];
  const held = await holders(core);
  return held ? idle.filter((r) => !held.has(r.id)) : [];
}

// Puts the ids on the first of this poll's events whose text has room for them, once per idle period (`reminded`: a Set of
// `id:turns` the caller carries across polls). Returns the events. Reads the tasks only when there is an event and an idle row.
async function remindIdle(core, runId, rows, events, reminded, ms = thresholdMs()) {
  if (!events.length) return events;
  const due = (await idleRows(core, rows, runId, ms)).filter((r) => !reminded.has(`${r.id}:${r.turns || 0}`));
  if (!due.length) return events;
  const { wakeText } = require('./wake.cjs');
  for (const ev of events) {
    const plain = wakeText(ev);
    ev.idle_without_task = due.map((r) => r.id);
    if (wakeText(ev) !== plain) { for (const r of due) reminded.add(`${r.id}:${r.turns || 0}`); return events; }
    delete ev.idle_without_task;
  }
  return events;
}

// The clause a wake text gains: the ids when they fit under `max` bytes, else their count, else nothing.
function withIdle(text, ids, max) {
  if (!Array.isArray(ids) || !ids.length) return text;
  const fits = (c) => Buffer.byteLength(text + c, 'utf8') <= max;
  const list = ` Idle without a task: ${ids.join(', ')}.`;
  if (fits(list)) return text + list;
  const count = ` ${ids.length} worker${ids.length === 1 ? '' : 's'} idle without a task.`;
  return fits(count) ? text + count : text;
}

module.exports = { idleRecords, idleRows, remindIdle, withIdle, IDLE_REMIND_MS };
