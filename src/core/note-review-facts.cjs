'use strict';
// note-review-facts.cjs — the facts around a note's review, read from the store (no write, no model):
//   refutationOf(E, noteId)   what a refuted note's wake carries: the reason and cites, who was shown the note, and what they wrote
//   notesUnderReview(E, taskIds, project)  the live notes the tasks wrote that a review should judge
//   refutedShownTo(E, taskIds)  the refuted notes any worker of these tasks was shown, for a review's brief
// "Who was shown" comes from note-delivery.cjs, the one seam; this module never reads delivery records itself.

const rows = require('./rows.cjs');
const { shownTo } = require('./note-delivery.cjs');

const NOTES_MAX = 50;
const FINISHED = new Set(['done', 'released']);

const parse = (t) => { try { return t ? JSON.parse(t) : {}; } catch { return {}; } };
const COLS = 'id, namespace, title, status, task_id, written_by, run_id, body';

function noteRow(E, id) {
  const r = E.store.p(`SELECT ${COLS} FROM memory_entries WHERE id = ? AND type = 'note'`).get(id);
  return r ? { ...r, b: parse(r.body) } : null;
}

// Whether a finished task's hand-back named the note among the memory rows it cited. null while the task is running.
function citedBy(task, noteId) {
  if (!task || !FINISHED.has(task.state)) return null;
  const r = task.handoff && task.handoff.result;
  return !!(r && Array.isArray(r.memory_ids) && r.memory_ids.includes(noteId));
}

// The review tasks over the shown tasks, running or finished: the orchestrator's flag for a review that is already under way.
function reviewsOf(E, taskIds) {
  if (!taskIds.length) return [];
  const out = [];
  for (const t of rows.currentAll(E.store, 'task')) {
    if (!t.acceptance || t.acceptance.verdict !== true || !Array.isArray(t.depends_on)) continue;
    for (const d of t.depends_on) if (taskIds.includes(d)) out.push({ review_task_id: t.id, task_id: d, state: FINISHED.has(t.state) ? 'finished' : 'running' });
  }
  return out.slice(0, NOTES_MAX);
}

function refutationOf(E, noteId) {
  const n = noteRow(E, noteId);
  if (!n) return null;
  const review = n.b && n.b.review && typeof n.b.review === 'object' ? n.b.review : null;
  const shown = shownTo(E, noteId).map((s) => {
    const task = s.task_id ? rows.current(E.store, 'task', s.task_id) : null;
    return {
      task_id: s.task_id, worker_id: s.worker_id, run_id: s.run_id, via: s.via,
      state: !task ? 'unknown' : FINISHED.has(task.state) ? 'finished' : 'running',
      cited: citedBy(task, noteId),
    };
  });
  const taskIds = [...new Set(shown.map((s) => s.task_id).filter(Boolean))];
  let written = [];
  if (taskIds.length) {
    written = E.store.p(`SELECT ${COLS} FROM memory_entries WHERE type = 'note' AND id <> ? AND task_id IN (${taskIds.map(() => '?').join(', ')}) ORDER BY created_at, id LIMIT ${NOTES_MAX}`)
      .all(noteId, ...taskIds).map((r) => ({ id: r.id, title: r.title, task_id: r.task_id, written_by: r.written_by, status: r.status || 'unverified', state: parse(r.body).state || null, namespace: r.namespace }));
  }
  return {
    note: { id: n.id, title: n.title, namespace: n.namespace, status: n.status || 'unverified', task_id: n.task_id, written_by: n.written_by, run_id: n.run_id },
    review: review && { verdict: review.verdict, by: review.by, ref: review.ref, at: review.at, reason: review.reason, cites: review.cites },
    shown, reviews_of_shown: reviewsOf(E, taskIds), notes_written_by_shown: written,
  };
}

// The notes the reviewed tasks wrote, live in the project and not yet judged (unverified), for a reviewer to judge.
function notesUnderReview(E, taskIds, project) {
  if (!taskIds.length || !project) return [];
  return E.store.p(`SELECT ${COLS} FROM memory_entries WHERE type = 'note' AND namespace = ? AND COALESCE(status, 'unverified') = 'unverified' AND json_extract(body, '$.unsupported') IS NULL AND task_id IN (${taskIds.map(() => '?').join(', ')}) ORDER BY created_at, id LIMIT ${NOTES_MAX}`)
    .all(`project/${project}`, ...taskIds).map((r) => {
      const b = parse(r.body);
      return { id: r.id, title: r.title, when: typeof b.when === 'string' ? b.when : null, task_id: r.task_id, written_by: r.written_by, kind: b.kind || null, basis: b.basis || null, evidence: Array.isArray(b.evidence) ? b.evidence : [], applies_to: Array.isArray(b.applies_to) ? b.applies_to : [] };
    });
}

// Refuted notes (anywhere) that a worker of one of these tasks was shown: [{ note_id, reason, task_id, worker_id }].
function refutedShownTo(E, taskIds) {
  if (!taskIds.length) return [];
  const refuted = E.store.p("SELECT id, body FROM memory_entries WHERE type = 'note' AND status = 'refuted' ORDER BY status_at DESC LIMIT 200").all();
  const want = new Set(taskIds);
  const out = [];
  for (const r of refuted) {
    const reason = parse(r.body).review && parse(r.body).review.reason;
    for (const s of shownTo(E, r.id)) if (s.task_id && want.has(s.task_id)) out.push({ note_id: r.id, reason: typeof reason === 'string' ? reason : null, task_id: s.task_id, worker_id: s.worker_id });
  }
  return out;
}

module.exports = { refutationOf, notesUnderReview, refutedShownTo, citedBy };
