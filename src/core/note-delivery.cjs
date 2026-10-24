'use strict';
// note-delivery.cjs — the seam for "which workers were shown note X". The refuted-note wake and the review brief ask
// it, and nothing else decides who was shown a note.
//
// TODAY this reads belay's `index_injected` receipts: the first-message index a worker was handed names the note's id in
// the receipt's row_ids. A search or retrieve result handed to a worker is not recorded yet, and priming from the repository
// or an orchestrator's relay is invisible, so the answer is a floor, not a census (`via` says what established each row).
// The delivery-record work replaces `shownTo` with a query over its own records (index, search and retrieve); it must
// keep this return shape, so the wake and the brief do not change:
//   [{ run_id, worker_id, task_id, at, via }]    one entry per (worker, task), earliest delivery
// Read-only: SELECTs and nothing else.

const rows = require('./rows.cjs');

const EVENTS_MAX = 5000;

function shownTo(E, noteId) {
  let events;
  try {
    events = E.store.p("SELECT run_id, worker_id, task_id, row_ids, written_at FROM memory_event WHERE kind = 'index_injected' AND ok = 1 AND row_ids LIKE ? ORDER BY seq LIMIT ?").all(`%${JSON.stringify(noteId)}%`, EVENTS_MAX);
  } catch { return []; }
  const out = new Map();
  for (const ev of events) {
    let ids;
    try { ids = JSON.parse(ev.row_ids); } catch { continue; }
    if (!Array.isArray(ids) || !ids.includes(noteId) || !ev.worker_id) continue;
    let taskId = ev.task_id;
    if (!taskId) { const w = rows.current(E.store, 'worker', ev.worker_id); taskId = w ? w.task_id : null; }
    const key = `${ev.worker_id}|${taskId || ''}`;
    if (!out.has(key)) out.set(key, { run_id: ev.run_id, worker_id: ev.worker_id, task_id: taskId || null, at: ev.written_at, via: 'index_injected' });
  }
  return [...out.values()];
}

module.exports = { shownTo };
