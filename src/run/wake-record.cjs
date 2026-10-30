'use strict';
// wake-record.cjs — the run receipt's entry for one wake written to the orchestrator (orchestrator.cjs writeWake): what the wake was
// and what established it. Moved out of orchestrator.cjs unchanged, to keep that file under its line budget.

const { exceptionOf } = require('./policy-wakes.cjs');

const establishedBy = (ev) => (ev.event === 'note_refuted' || ev.event === 'scrub_alarm' ? `${ev.event} receipt seq ${ev.seq}` : ev.event === 'budget_pause' ? 'the budget guard' : ev.event === 'evaluated' ? `task ${ev.task_id} results at ${ev.seq}` : ev.event === 'pre_close' ? 'task.worktreeSweep dry run' : `worker.list row seq ${ev.seq} for the run`);

// `idle` is read by the caller at the instant of the write (5b), never a stale snapshot.
function wakeRecord(ev, text, atMs, idle) {
  const rec = {
    at_ms: atMs, worker_id: ev.worker_id, event: ev.event, turn: ev.turn,
    bytes: Buffer.byteLength(text, 'utf8'), orchestrator_idle_at_write: idle,
    established_by: establishedBy(ev),
    exception: exceptionOf(ev), task_id: ev.task_id || null, // ADR 0073: E1 to E10, or null for a wake that is not an exception
  };
  if (ev.event === 'death') {
    rec.exit_code = ev.exit_code; rec.exit_signal = ev.exit_signal; rec.death_established_by = ev.death_established_by;
  }
  if (ev.event === 'paused') rec.paused_by = ev.paused_by;
  if (ev.turns_skipped) rec.turns_skipped = ev.turns_skipped;
  return rec;
}

module.exports = { wakeRecord };
