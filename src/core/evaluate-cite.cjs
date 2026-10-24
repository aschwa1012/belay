'use strict';
// evaluate-cite.cjs — ADR 0057 decision 7 (C10): a note's evidence, or a reviewer's cite, may name a task_evaluate result, and belay checks it.
// `where` is `evaluate:<task_id>` (the task's latest evaluation) or `evaluate:<task_id>@<rev>` (the task row version task.evaluate wrote, rev
// being its seq). The row must carry an evaluation (results.evaluated_at), and the quoted text must appear in what the evaluation recorded:
// each check's kind, argv, exit code, passed or failed, reason, and stdout and stderr tails. The rule is memory-citations.cjs's (whitespace
// collapsed; a quote under six characters must be a whole line). It proves the evaluation printed what the note says, not that the claim
// follows; a note's status stays a review's. Reads only: no write, no git, no process.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const { quoteHolds } = require('./memory-citations.cjs');

const WHERE = /^evaluate:([A-Za-z0-9][A-Za-z0-9_.:-]{0,127}?)(?:@(\d{1,15}))?$/;
const isEvaluateCite = (where) => typeof where === 'string' && where.startsWith('evaluate:');

// What one evaluation recorded, as lines a quote is looked for in.
function renderResults(results) {
  const out = [results.passed ? 'passed' : 'failed'];
  if (typeof results.note === 'string') out.push(results.note);
  for (const c of Array.isArray(results.checks) ? results.checks : []) {
    const d = c.detail && typeof c.detail === 'object' ? c.detail : {};
    out.push([c.kind, Array.isArray(c.argv) ? c.argv.join(' ') : '', c.exit_code === undefined || c.exit_code === null ? '' : `exit ${c.exit_code}`, c.passed ? 'passed' : 'failed'].filter(Boolean).join(' '));
    for (const k of ['reason', 'stdout_tail', 'stderr_tail']) if (typeof d[k] === 'string' && d[k]) out.push(d[k]);
  }
  return out.join('\n');
}

// { ok: true, task_id, rev, evaluated_at, passed } or { ok: false, reason }.
function check(E, where, quote) {
  const m = WHERE.exec(String(where).trim());
  if (!m) return { ok: false, reason: 'an evaluate cite is evaluate:<task_id> or evaluate:<task_id>@<rev>' };
  const [, taskId, revText] = m;
  const versions = rows.history(E.store, 'task', taskId);
  if (!versions.length) return { ok: false, reason: `there is no task ${taskId}` };
  const evaluated = versions.filter((v) => v.results && typeof v.results === 'object' && v.results.evaluated_at);
  let row;
  if (revText !== undefined) {
    row = versions.find((v) => v.seq === Number(revText));
    if (!row) return { ok: false, reason: `task ${taskId} has no row version ${revText}` };
    if (!evaluated.includes(row)) return { ok: false, reason: `task ${taskId} at ${revText} carries no evaluation` };
  } else {
    if (!evaluated.length) return { ok: false, reason: `task ${taskId} has never been evaluated` };
    const latest = evaluated[evaluated.length - 1].results.evaluated_at;
    row = evaluated.find((v) => v.results.evaluated_at === latest); // the version task.evaluate wrote, not one that carried it forward
  }
  if (!quoteHolds(renderResults(row.results), quote)) return { ok: false, reason: `the quote is not in what the evaluation of task ${taskId} at ${row.seq} recorded (its checks' argv, exit codes, reasons and output tails)` };
  return { ok: true, task_id: taskId, rev: row.seq, evaluated_at: row.results.evaluated_at, passed: !!row.results.passed };
}

// A note's evidence entries that cite an evaluation, each checked. Refuses E_CITATION on the first that fails, naming it; nothing is written by
// the caller then. Returns body.evidence_checked: [{ index, ok: true, by: 'evaluate', task_id, rev, evaluated_at, passed }].
function checkNoteEvidence(E, evidence, noteIndex) {
  const out = [];
  for (const [i, e] of (evidence || []).entries()) {
    if (!e || !isEvaluateCite(e.where)) continue;
    const r = check(E, e.where, e.saw);
    const at = noteIndex === undefined ? '' : `notes[${noteIndex}]: `;
    if (!r.ok) throw err('E_CITATION', `${at}evidence[${i}] (${e.where}) refused: ${r.reason}`, { index: i, where: e.where, reason: r.reason, ...(noteIndex === undefined ? {} : { note_index: noteIndex }) });
    out.push({ index: i, ok: true, by: 'evaluate', task_id: r.task_id, rev: r.rev, evaluated_at: r.evaluated_at, passed: r.passed });
  }
  return out;
}

module.exports = { isEvaluateCite, check, checkNoteEvidence, renderResults };
