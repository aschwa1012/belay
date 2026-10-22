'use strict';
// memory-report-hold.cjs — a report that a note is wrong holds the note at once (ADR 0047 amendment of 2026-10-21). `holdReported` runs inside the
// transaction that releases the lease, after the report is marked on the note, and writes (through the one shared hold writer, `hold` in
// methods-memory-scrub.cjs, so the facts it checks are the facts it stores) a hold row in held/<project> with the ground `reported` and the
// reports on it, on belay's own harness channel: only a harness hold is counted and reviewed, and the report keeps the worker's identity.
//
// A note has ONE hold for its reports. A report on a note already held for a report is appended to that hold; a report on a note held for any
// other reason (a scrubber's mark, an older report_confirmed hold, a write-time replacement, an open unsupported queue row) merges that hold into a
// new reported hold: the old row is closed as `merged` and names the new one, so the note is counted once. Every change to a hold's reports,
// verdicts, kind, `of`, state or prior hold goes through `bumpHold`, which raises its `rev`: an archive verdict is bound to the revision it saw.

const { hold } = require('./methods-memory-scrub.cjs');
const { reportedKind, loadNote, activeHoldOf } = require('./memory-facts.cjs');
const { unsettled, reportKey } = require('./report-marks.cjs');
const { redact } = require('./redact.cjs');
const N = require('./methods-memory-notes.cjs');

const REPORTS_KEEP = 20;      // the newest reports the hold keeps: never fewer than the note keeps
const KIND_HISTORY_KEEP = 10;

// A report as the hold carries it. The text is redacted again here (a report made before redaction was applied once is copied clean too).
function copyOf(note, w) {
  return { key: reportKey(w), ...(Number.isInteger(w.seq) ? { seq: w.seq } : {}), by: w.by, worker_id: w.worker_id || null, task_id: w.task_id || null, run_id: w.run_id || null, why: redact(String(w.why || '')).text, replaced_by: w.replaced_by || null, ...(Array.isArray(w.cites) && w.cites.length ? { cites: w.cites } : {}), at: w.at, ...(typeof w.withhold === 'boolean' ? { withhold: w.withhold, ...(w.breaker ? { breaker: w.breaker } : {}) } : {}), ...(w.by === note.written_by ? { self_report: true } : {}) };
}

// Every report on the note that is not settled (new and legacy), newest REPORTS_KEEP, oldest first.
function holdReportsOf(note) {
  return unsettled(note.b).slice(-REPORTS_KEEP).map((w) => copyOf(note, w));
}

// Applies fn to a hold's body and raises its revision. The one way a hold's reports, verdicts, kind, of, state or prior hold change.
function bumpHold(E, heldId, fn) {
  return E.store.patchBody(heldId, (b) => {
    const was = Number(b.rev) || 0;
    const out = fn(b) || b;
    out.rev = was + 1;
    return out;
  });
}

const selfOnly = (reports) => reports.length > 0 && reports.every((r) => r.self_report);

// Appends to an existing reported hold and classifies it again over its current reports (the newest report that names a passing replacement
// decides). A change of kind or `of` replaces the hold's, keeps the earlier in kind_history, and moves the note's pointer in the same transaction.
function appendTo(E, ctx, note, active, reports, newReport) {
  const replaced = !!(newReport && (active.b.reports || []).some((r) => r.by === newReport.by)); // a reporter's repeat replaces its own
  const rk = reportedKind(E, ctx.project, note, reports, ctx.threshold, active.b.prior_hold || null);
  const changed = rk.kind !== active.b.kind || (rk.of || null) !== (active.b.of || null);
  const next = bumpHold(E, active.id, (b) => {
    b.reports = reports;
    b.reports_total = (Number(b.reports_total) || (b.reports || []).length) + (replaced ? 0 : 1);
    b.reports_dropped = Math.max(0, b.reports_total - reports.length);
    b.self_report = selfOnly(reports);
    if (changed) {
      b.kind_history = [...(b.kind_history || []), { kind: b.kind, of: b.of || null, facts: b.facts || null, rev: Number(b.rev) || 0, at: Date.now() }].slice(-KIND_HISTORY_KEEP);
      b.kind = rk.kind; b.of = rk.of || null; b.facts = rk.facts;
    }
    return b;
  });
  if (changed) E.store.patchBody(note.id, (b) => { if (b.held && b.held.row === active.id) { b.held.kind = rk.kind; b.held.of = rk.of || null; } return b; });
  return { row: active.id, kind: next.kind, rev: next.rev, already_held: true, ...(changed ? { reclassified: true } : {}) };
}

// ctx: { project, runId, threshold, headSha }; note: the note as loaded now (the new report is already on it); newReport: the report just marked.
// Returns { row, kind, rev, already_held?, merged?, replaced_stale_pointer? } or { skipped }.
function holdReported(E, caller, ctx, note, newReport) {
  if (!note || note.type !== 'note' || note.namespace !== N.projectNs(ctx.project)) return { skipped: 'not_live' };
  const reports = holdReportsOf(note);
  if (!reports.length) return { skipped: 'no_standing_report' };
  const active = activeHoldOf(E, ctx.project, note.id);
  if (active && active.b.ground === 'reported' && active.b.kind !== 'unsupported') return appendTo(E, ctx, note, active, reports, newReport);

  // A new hold, or a merge of another into it. Every pointer decision is made here, so hold() never meets its own E_EXISTS guard.
  let prior = null, merged = null, stale = null;
  if (active) {
    prior = { row: active.id, kind: active.b.kind, of: active.b.of || null, ground: active.b.ground || null, relation: active.b.relation || null, reason: active.b.reason || null, cites: active.b.cites || [] };
    if (active.b.report) prior.report = active.b.report;
    merged = active.id;
  } else if (note.b.held && note.b.held.row) {
    stale = note.b.held.row;
  }
  if (note.b.held) E.store.patchBody(note.id, (b) => { delete b.held; return b; }); // the old pointer is replaced by the new hold's
  const fresh = loadNote(E, note.id);
  const rk = reportedKind(E, ctx.project, fresh, reports, ctx.threshold, prior);
  const why = newReport && newReport.why ? newReport.why : reports[reports.length - 1].why;
  const entry = { action: 'hold', kind: rk.kind, of: rk.of || null, ground: 'reported', reason: redact(String(why || 'reported wrong')).text.slice(0, 500), cites: [] };
  const hctx = {
    project: ctx.project, runId: ctx.runId, threshold: ctx.threshold, mode: 'report', evidence: { head_sha: ctx.headSha || null },
    heldExtra: { reports, reports_total: reports.length, reports_dropped: 0, report_verdicts: [], self_report: selfOnly(reports), classified: rk.facts, ...(prior ? { prior_hold: prior } : {}), ...(stale ? { replaced_stale_pointer: stale } : {}), ...(ctx.extra || {}), rev: 0, scrub: null },
  };
  const out = hold(E, { ...caller, channel: 'harness' }, hctx, entry, 0, [], { note: fresh, pending: false });
  const row = out.held.id;
  if (merged) {
    bumpHold(E, merged, (b) => { b.state = 'merged'; b.merged_into = row; b.merged_at = Date.now(); return b; });
    if (note.b.unsupported && note.b.unsupported.state === 'open') E.store.patchBody(note.id, (b) => { b.unsupported = { ...b.unsupported, state: 'merged', merged_into: row }; return b; });
  }
  return { row, kind: rk.kind, rev: 0, ...(merged ? { merged } : {}), ...(stale ? { replaced_stale_pointer: stale } : {}) };
}

module.exports = { holdReported, bumpHold, holdReportsOf, copyOf, REPORTS_KEEP };
