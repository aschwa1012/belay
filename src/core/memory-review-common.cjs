'use strict';
// memory-review-common.cjs — what the archive review's verdict paths share: the one active hold of a note, the review log on a hold row, the
// receipt a verdict carries, the grant that lets the review's cited outcome change a held note (held-guard.cjs), and the binding of a verdict
// to the hold row and revision it was offered (ADR 0047 amendment 2026-10-21, R4).

const C = require('./lifecycle-common.cjs');
const HG = require('./held-guard.cjs');
const { activeHoldOf } = require('./memory-facts.cjs');

const REVIEWS_KEEP = 20;
const pick = (e) => ({ reason: e.reason, cites: e.cites });
const activeHold = (E, project, noteId) => activeHoldOf(E, project, noteId);
const revOf = (held) => Number(held.b.rev) || 0;

// A refusal, an undecided mark and a settled outcome go on the row's review log; none of these raises its revision (only a change to the
// hold's reports, verdicts, kind, of, state or prior hold does: bumpHold).
function record(E, heldId, entry, patch) {
  E.store.patchBody(heldId, (b) => {
    b.reviews = [...(b.reviews || []), entry].slice(-REVIEWS_KEEP);
    if (patch) Object.assign(b, patch);
    return b;
  });
}

const review = (ctx, held, v, outcome, extra) => ({ receipt: `review:${ctx.runId}:${held.id}`, run_id: ctx.runId, at: Date.now(), verdict: v.verdict, outcome, reason: v.reason, cites: v.cites, ...(v.same_claim === undefined ? {} : { same_claim: v.same_claim }), ...extra });

// The review's cited outcome on one note, in one synchronous transaction: the only authority besides the operator's own command that may change a held note.
const granted = (noteId, fn) => HG.grant('archive_review', noteId, fn);

// The refusal of a verdict, written on `rowId` (the row the verdict was offered) and returned. Inside the caller's transaction.
function refuseOn(E, ctx, rowId, held, v, code, message, detail) {
  const entry = review(ctx, { id: rowId }, v, 'refused', { code, message, ...(detail ? { detail } : {}) });
  record(E, rowId, entry);
  return { id: held.b.note_id, verdict: v.verdict, outcome: 'refused', receipt: entry.receipt, code, message, ...(detail ? { detail } : {}), held: C.rowOut(E, rowId), row: C.rowOut(E, held.b.note_id) };
}

// Whether the hold the verdict will write against is the one it read: the same row at the same revision. Returns null, or the detail of the mismatch.
// `offered` is what the verdict said it was offered ({ row, rev } or empty); `read` is the hold as `one()` read it.
function mismatch(E, ctx, v, read, readRev) {
  const fresh = activeHold(E, ctx.project, v.id);
  if (fresh && fresh.id === read.id && revOf(fresh) === readRev) return null;
  return { offered_row: v.held_row || read.id, offered_rev: v.rev !== undefined ? v.rev : readRev, current_row: fresh ? fresh.id : null, current_rev: fresh ? revOf(fresh) : null };
}

const STALE = 'the hold changed after the review was offered it (a new report, a verdict, a merge or a settlement), so the verdict is refused and the hold is offered again with its current revision';

module.exports = { REVIEWS_KEEP, pick, activeHold, revOf, record, review, granted, refuseOn, mismatch, STALE };
