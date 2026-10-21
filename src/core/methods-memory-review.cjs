'use strict';
// methods-memory-review.cjs — memory.reviewApply: the Opus reviewer's verdicts on held notes ("hold, then decide"). Harness caller only.
// For a hold with a warning the reviewer has three outcomes (operator, 2026-10-21):
//   archive    on its own cites that show the note is wrong: S4's facts are checked again at this moment, then the note moves to archive/<project>
//              keeping its id (a duplicate hands its sightings and delivery history to the note it duplicates);
//   release    for a hold of kind wrong or ground reported, ONLY on its own cites that show the note is correct, checked as an archive's are:
//              a release is a verify (the note becomes verified through the same write a note review uses, its reports are settled, the hold
//              ends), and it names the hash of the whole note the brief showed (shown_hash). For a scrubber duplicate or superseded hold a release
//              keeps its meaning (the two notes do not make the same claim, or the other does not replace it) and needs no cites;
//   undecided  with a reason: the hold stays held, with its warning, marked reviewed-undecided at its revision; it waits for the operator.
// A queue row of kind `unsupported` (a note a reviewer could not prove or disprove; it carries no warning) has its own three answers
// (memory-review-unsupported.cjs): verify, refute, still_unsupported.
// Every verdict is bound to the hold row and revision it was offered (a hold that changed since refuses it, with the refusal on the row), and every
// verdict, applied or refused, is written on the held row and returned with a `review:` receipt, so a refusal is a fact on the row and not a silence.
// Nothing is deleted.

const { err } = require('./errors.cjs');
const L = require('./memory-lifecycle.cjs');
const C = require('./lifecycle-common.cjs');
const { loadNote, checkHoldFacts, reportedKind, ownTexts, sawsOf } = require('./memory-facts.cjs');
const { checkCitations, evidenceOf } = require('./memory-citations.cjs');
const { archiveNote } = require('./memory-archive.cjs');
const N = require('./methods-memory-notes.cjs');
const { applyOneIn } = require('./methods-memory-note-review.cjs');
const { reportKey } = require('./report-marks.cjs');
const BC = require('./note-brief-capture.cjs');
const R = require('./memory-review-common.cjs');

const KEYS = ['verdicts', 'run_id', 'head_sha', 'worktree', 'evidence_files'];
const isReported = (b) => b.ground === 'reported' || b.ground === 'report_confirmed';
// Whether a release of this hold verifies the note (a wrong hold of any ground, or any hold made by a report).
const verifying = (b) => b.kind === 'wrong' || isReported(b);

// The keys of every report on a hold at the revision read (the new and the legacy), which a release settles.
function settledKeys(note, held) {
  const keys = new Set((held.b.reports || []).map((r) => r.key).filter(Boolean));
  if (held.b.report) {
    const w = (note.b.reported_wrong || []).find((x) => x && x.task_id === held.b.report.task_id && x.at === held.b.report.at);
    if (w) keys.add(reportKey(w));
  }
  return [...keys];
}

// Ends the hold as released and drops the warning. `extra` goes on the review entry and the proof.
function release(E, ctx, held, v, extra = {}, patchNote = null) {
  const entry = R.review(ctx, held, v, 'released', extra);
  R.record(E, held.id, entry, { state: 'released', released_at: entry.at });
  E.store.patchBody(held.b.note_id, (b) => {
    delete b.held;
    b.releases = [...(b.releases || []), { held_row: held.id, at: entry.at, receipt: entry.receipt, reason: v.reason }].slice(-R.REVIEWS_KEEP);
    if (patchNote) patchNote(b);
    return N.fitBody(b);
  });
  return { id: held.b.note_id, verdict: 'release', outcome: 'released', receipt: entry.receipt, held: C.rowOut(E, held.id), row: C.rowOut(E, held.b.note_id) };
}

// Inside the transaction. A failed precondition does not throw: it is written on the held row and returned.
function archive(E, ctx, held, v, sources) {
  const note = loadNote(E, held.b.note_id);
  const refuse = (code, message, detail) => {
    const entry = R.review(ctx, held, v, 'refused', { code, message, verified: sources });
    R.record(E, held.id, entry);
    return { id: held.b.note_id, verdict: 'archive', outcome: 'refused', receipt: entry.receipt, code, message, ...(detail ? { detail } : {}), held: C.rowOut(E, held.id), row: C.rowOut(E, held.b.note_id) };
  };
  if (!note || note.namespace !== N.projectNs(ctx.project)) return refuse('E_NOT_FOUND', `note ${held.b.note_id} is no longer a live note of the project (${note ? note.namespace : 'gone'}), so there is nothing to archive`);
  // A report-made hold is classified again here, by the same function that classified it: a replacement that is no longer live, kept and related
  // (archived or held meanwhile) makes the archive a wrong one (or one of another passing replacement), recorded as kind_changed.
  let kind = held.b.kind, of = held.b.of || null, kindChanged = null;
  if (held.b.ground === 'reported') {
    const rk = reportedKind(E, ctx.project, note, held.b.reports || [], ctx.threshold, held.b.prior_hold || null);
    if (rk.kind !== kind || (rk.of || null) !== of) { kindChanged = `${kind}->${rk.kind}`; kind = rk.kind; of = rk.of || null; }
  }
  let facts;
  try { facts = checkHoldFacts(E, ctx.project, note, kind, of, held.b.ground, ctx.threshold, held.b.run_id, { ...held.b, kind, of }); } catch (e) {
    if (e.code !== 'E_PRECONDITION') throw e;
    return refuse(e.code, `S4 no longer holds at apply time: ${e.message}`, e.detail);
  }
  const entry = R.review(ctx, held, v, 'archived', { facts, verified: sources, ...(kindChanged ? { kind_changed: kindChanged } : {}) });
  const kept = kind === 'duplicate' ? loadNote(E, of) : null;
  const done = archiveNote(E, ctx.project, note, {
    kind, of, ground: held.b.ground, reason: held.b.reason, cites: held.b.cites, run_id: held.b.run_id, head_sha: held.b.head_sha,
    held_row: held.id, receipt: entry.receipt, ...(kindChanged ? { kind_changed: kindChanged } : {}), ...(held.b.relation ? { relation: held.b.relation, refines: held.b.relation === 'refines', via: held.b.relation } : {}),
  }, kept || (held.b.relation === 'refines' ? loadNote(E, of) : null));
  R.record(E, held.id, entry, { state: 'archived', archived_at: done.at });
  return { id: note.id, verdict: 'archive', outcome: 'archived', receipt: entry.receipt, facts, ...(kindChanged ? { kind_changed: kindChanged } : {}), history_moved: done.history_moved, replaced_also_archived: done.replaced_also_archived, held: C.rowOut(E, held.id), row: C.rowOut(E, note.id) };
}

// A verifying release, inside the transaction and the review's grant: the note becomes verified on the reviewer's cites (applyOneIn, route
// archreview-<run>), every report on the hold is settled, and the hold ends. The whole note the brief showed is bound by hash.
function releaseVerifying(E, ctx, held, v, sources) {
  const refuse = (code, message) => R.refuseOn(E, ctx, held.id, held, v, code, message);
  const note = loadNote(E, held.b.note_id);
  if (!note || note.namespace !== N.projectNs(ctx.project)) return refuse('E_NOT_FOUND', `note ${held.b.note_id} is no longer a live note of the project, so there is nothing to release`);
  if (v.shown_hash !== BC.hashOfRow(note)) return refuse('E_PRECONDITION', 'the note changed after the brief showed it, or the brief did not bind it (shown_hash), so it is not verified');
  const route = { reviewer: `archreview-${ctx.runId}`, ref: `${ctx.runId}:${held.id}`, keyBase: `archreview:${held.id}` };
  let status;
  try { status = applyOneIn(E, ctx.caller, route, { id: note.id, verdict: 'confirmed', reason: v.reason, cites: v.cites }, note); } catch (e) {
    if (e.code !== 'E_ARGS') throw e;
    return refuse('E_PRECONDITION', `the note cannot be verified: ${e.message}`);
  }
  const keys = settledKeys(note, held);
  const out = release(E, ctx, held, v, { verified: sources, settled: keys, status: status.status }, (b) => { b.reports_settled = [...new Set([...(b.reports_settled || []), ...keys])]; });
  return { ...out, status: status.status, event_id: status.event_id, settled: { keys, count: keys.length } };
}

// The cites of an archive of a wrong or superseded note, and of a verifying release: at least one, checked verbatim against the evidence. A duplicate is
// archived on the reviewer's explicit "same claim, not contradicting" and S4's facts (rechecked in archive()), no cites.
async function citesFor(E, ctx, held, v) {
  if (v.verdict === 'archive' && held.b.kind === 'duplicate') {
    if (v.same_claim !== true) throw err('E_PRECONDITION', 'archiving a duplicate needs same_claim: true, the reviewer\'s statement that both notes make the same claim and do not contradict; release it if they differ', { id: v.id });
    return { v: { ...v, cites: [] }, sources: [] };
  }
  if (!v.cites.length) throw err('E_CITATION', v.verdict === 'release' ? `a release of a ${isReported(held.b) ? 'reported' : 'wrong'} note verifies it, and needs at least one cite { where, quote }, verbatim, that shows the note is correct` : `archiving a ${held.b.kind} note needs at least one cite { where, quote }, verbatim`, { id: v.id });
  const own = loadNote(E, v.id);
  const sources = await checkCitations(v.cites, { ...ctx.evidence, head_sha: held.b.head_sha || ctx.evidence.head_sha, own: own ? ownTexts(own) : [], saws: own ? sawsOf(own) : [], title: own ? own.title : undefined });
  if (v.verdict === 'archive' && held.b.ground === 'code_contradicts' && !sources.some((s) => s.source !== 'stream')) throw err('E_CITATION', 'a hold on the ground code_contradicts is archived on a citation of a file at the head commit', { id: v.id });
  return { v, sources };
}

async function one(E, ctx, raw, index) {
  let v = raw;
  const held = R.activeHold(E, ctx.project, v.id);
  if (!held) throw err('E_NOT_FOUND', `note ${v.id} has no active hold in held/${ctx.project}`, { id: v.id });
  const readRev = R.revOf(held);
  const isUns = held.b.kind === 'unsupported';
  if (isUns !== ['verify', 'refute', 'still_unsupported'].includes(v.verdict)) {
    throw err('E_PRECONDITION', isUns ? `note ${v.id} is queued as unsupported: answer verify, refute or still_unsupported, not ${v.verdict}` : `note ${v.id} is held with a warning (${held.b.kind}): answer archive, release or undecided, not ${v.verdict}`, { id: v.id });
  }
  const tx = (fn) => C.openTx(E, ctx.caller, 'memory.reviewApply', fn);
  const clean = (x) => ({ ...x, ...R.pick(C.redactEntry(x)) }); // anything written on a row is redacted first
  // The verdict is bound to the row and revision it was offered. At the first read: a different row or revision is refused, and a release or an
  // undecided of a reported hold must say which revision it saw (what was settled, or left undecided, has to be known).
  const offeredRow = v.held_row && E.store.p("SELECT 1 AS x FROM memory_entries WHERE id = ? AND type = 'held'").get(v.held_row) ? v.held_row : held.id;
  const detail = { offered_row: v.held_row || held.id, offered_rev: v.rev !== undefined ? v.rev : readRev, current_row: held.id, current_rev: readRev };
  if ((v.held_row !== undefined && v.held_row !== held.id) || (v.rev !== undefined && v.rev !== readRev)) return tx(() => R.refuseOn(E, ctx, offeredRow, held, clean(v), 'E_PRECONDITION', R.STALE, detail));
  if (isReported(held.b) && (v.verdict === 'release' || v.verdict === 'undecided') && v.rev === undefined) return tx(() => R.refuseOn(E, ctx, held.id, held, clean(v), 'E_PRECONDITION', `a ${v.verdict} of a reported hold must carry the rev it saw (the settlement and the undecided mark must know what was seen)`, detail));
  if (isUns) return require('./memory-review-unsupported.cjs').unsupported(E, ctx, held, v, readRev);
  const stale = () => { const d = R.mismatch(E, ctx, v, held, readRev); return d ? R.refuseOn(E, ctx, held.id, held, clean(v), 'E_PRECONDITION', R.STALE, d) : null; };
  if (v.verdict === 'undecided') {
    v = { ...v, ...R.pick(C.redactEntry(v)) };
    return tx(() => stale() || (() => {
      const entry = R.review(ctx, held, v, 'undecided');
      R.record(E, held.id, entry, { undecided: { rev: readRev, at: entry.at, receipt: entry.receipt, reason: v.reason } }); // marks, does not bump
      return { id: v.id, verdict: 'undecided', outcome: 'undecided', receipt: entry.receipt, rev: readRev, held: C.rowOut(E, held.id), row: C.rowOut(E, v.id) };
    })());
  }
  if (v.verdict === 'release' && !verifying(held.b)) {
    v = { ...v, ...R.pick(C.redactEntry(v)) };
    return tx(() => stale() || R.granted(v.id, () => release(E, ctx, held, v)));
  }
  let sources = [];
  try { ({ v, sources } = await citesFor(E, ctx, held, v)); } catch (e) {
    if (e.code !== 'E_CITATION' && e.code !== 'E_PRECONDITION') throw e;
    v = { ...v, ...R.pick(C.redactEntry(v)) };
    return tx(() => stale() || (() => {
      const entry = R.review(ctx, held, v, 'refused', { code: e.code, message: e.message });
      R.record(E, held.id, entry);
      return { id: v.id, verdict: v.verdict, outcome: 'refused', receipt: entry.receipt, code: e.code, message: e.message, held: C.rowOut(E, held.id), row: C.rowOut(E, v.id) };
    })());
  }
  v = { ...v, ...R.pick(C.redactEntry(v)) };
  return tx(() => {
    const bad = stale(); // the state at the write: the same row at the same revision, else the verdict is refused
    if (bad) return bad;
    const fresh = R.activeHold(E, ctx.project, v.id);
    if (!fresh) throw err('E_NOT_FOUND', `the hold on note ${v.id} was settled while the verdict was being checked`, { id: v.id });
    return R.granted(v.id, () => (v.verdict === 'release' ? releaseVerifying(E, ctx, fresh, v, sources) : archive(E, ctx, fresh, v, sources)));
  });
}

async function reviewApply(E, caller, args) {
  C.needHarness(caller, 'memory.reviewApply');
  C.allowKeys(args, KEYS, 'memory.reviewApply');
  const { lv, project, runId } = C.notesContext(E, caller, 'memory.reviewApply');
  if (args.run_id !== undefined && args.run_id !== runId) throw err('E_ARGS', `memory.reviewApply acts for the caller's own run (${runId}), and this call named ${args.run_id}`, { field: 'run_id' });
  const verdicts = L.checkVerdicts(args.verdicts);
  const ctx = { project, runId, caller, evidence: evidenceOf(args), threshold: lv.notes_match_threshold };
  const applied = [], refused = [];
  for (const [i, v] of verdicts.entries()) {
    try {
      const r = await one(E, ctx, v, i);
      (r.outcome === 'refused' ? refused : applied).push({ index: i, ...r });
    } catch (e) {
      if (!e || !['E_NOT_FOUND', 'E_CITATION', 'E_PRECONDITION', 'E_EXISTS', 'E_HELD'].includes(e.code)) throw e;
      refused.push({ index: i, id: v.id, verdict: v.verdict, outcome: 'refused', code: e.code, message: e.message, ...(e.detail ? { detail: e.detail } : {}) });
    }
  }
  E.noteWrite();
  return { run_id: runId, project, counts: { verdicts: verdicts.length, applied: applied.length, refused: refused.length }, applied, refused };
}

module.exports = { reviewApply, activeHold: R.activeHold };
