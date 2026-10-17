'use strict';
// memory-report-hold.cjs — the `wrong` hold an upheld report creates. It is the scrubber's hold, through the same writer (`hold` in
// methods-memory-scrub.cjs: a row in held/<project> that waits on the Opus archive reviewer, and a `held` pointer on the note so its
// warning stays visible), with the ground `report_confirmed` and the report that made it, the verdict's author and its reference
// recorded on the row. Inside a transaction. The note is never hidden here: only the archive reviewer archives a `wrong` hold.
// The cites were checked by the review's citation check against the reporter's evidence (not by the scrubber's verbatim rule).

const { hold } = require('./methods-memory-scrub.cjs');

// ctx: { project, runId, headSha, reviewer, ref, report: { by, task_id, why, replaced_by, at } }
// ent: { reason, cites } (already redacted). Returns the held row.
function holdWrongFromReport(E, caller, ctx, note, ent) {
  const entry = { action: 'hold', kind: 'wrong', of: null, ground: 'report_confirmed', reason: ent.reason, cites: ent.cites };
  const hctx = {
    project: ctx.project, runId: ctx.runId, mode: 'report', evidence: { head_sha: ctx.headSha || null },
    heldExtra: { report: { ...ctx.report, upheld_by: ctx.reviewer, ref: ctx.ref }, scrub: null },
  };
  return hold(E, caller, hctx, entry, 0, [], { note, pending: false }).held;
}

module.exports = { holdWrongFromReport };
