'use strict';
// note-report-in.cjs — the one body of a report that a note is wrong (ADR 0047 amendments of 2026-10-21 and 2026-10-22). A worker's hand-back, the
// operator's and the orchestrator's memory.noteReport, the orchestrator's `refuted` and a task reviewer's `refuted` all mark the note and hold it
// for the archive review here, so the mark, the hold and the one-report-per-reporter rule are the same whoever reports. It runs INSIDE the
// caller's transaction and writes the mark and the hold; the caller has already checked the note is live in the project.

const { err } = require('./errors.cjs');
const NW = require('./note-write.cjs');
const { loadNote } = require('./memory-facts.cjs');

const WRONG_KEEP = 20;

// `by` is the reporter (the caller's role, or worker:<id> for a worker or a reviewer), never an argument. One report per reporter per note: a repeat
// replaces that reporter's own report and never pushes out another's. Each report gets the next number of the note's counter, which is its key.
// `refused` ends the error sentence when the report cannot be kept on the note. Returns { report, reports, held }.
function reportIn(E, caller, p) {
  const RH = require('./memory-report-hold.cjs');
  const t = Date.now();
  let report = null;
  const next = E.store.patchBody(p.note, (b) => {
    const seq = (Number(b.report_seq) || 0) + 1;
    b.report_seq = seq;
    report = {
      by: p.by, worker_id: p.worker_id || null, task_id: p.task_id || null, run_id: p.run_id || null, why: p.why, replaced_by: p.replaced_by || null, at: t, seq,
      ...(Array.isArray(p.cites) && p.cites.length ? { cites: p.cites } : {}), ...(p.extra || {}),
    };
    b.reported_wrong = [...(b.reported_wrong || []).filter((x) => x.by !== p.by), report].slice(-WRONG_KEEP);
    return NW.fitBody(b, report, p.note);
  });
  if (!next.reported_wrong.includes(report) && !next.reported_wrong.some((x) => x.seq === report.seq)) {
    throw err('E_NOTE_SHAPE', `the report on note ${p.note} could not be kept on it${p.refused ? `, ${p.refused}` : ''}`, { id: p.note });
  }
  const held = RH.holdReported(E, caller, { project: p.project, runId: p.run_id || null, threshold: p.threshold, headSha: p.headSha || null }, loadNote(E, p.note), report);
  return { report, reports: next.reported_wrong.length, held };
}

module.exports = { reportIn, WRONG_KEEP };
