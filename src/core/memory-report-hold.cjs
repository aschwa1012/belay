'use strict';
// memory-report-hold.cjs — the `wrong` hold an upheld report creates. Same machinery as the scrubber's hold (a row in held/<project>
// that waits on the Opus archive reviewer, and a `held` pointer on the note so its warning stays visible), but the ground is
// `report_confirmed` and the verdict that made it is a task reviewer's (or the Haiku review job's), recorded on the row. Inside a
// transaction. The note is never hidden here: only the archive reviewer archives a `wrong` hold.

const { err } = require('./errors.cjs');
const L = require('./memory-lifecycle.cjs');
const C = require('./lifecycle-common.cjs');
const N = require('./methods-memory-notes.cjs');
const { checkHoldFacts } = require('./memory-facts.cjs');

// ctx: { project, runId, headSha, reviewer, ref, report: { by, task_id, why, replaced_by, at } }
// ent: { reason, cites } (already redacted). Returns the held row.
function holdWrongFromReport(E, caller, ctx, note, ent) {
  if (note.b.held) throw err('E_EXISTS', `note ${note.id} is already held (${note.b.held.row}); the archive reviewer settles it first`, { id: note.id, held_row: note.b.held.row });
  const facts = checkHoldFacts(E, ctx.project, note, 'wrong', null, 'report_confirmed');
  const held = C.putRow(E, caller, {
    ns: L.nsOf('held', ctx.project), type: 'held', runId: ctx.runId,
    text: `held wrong: ${note.id} (upheld report, run ${ctx.runId})`,
    title: `held wrong: ${note.title || note.id}`,
    body: {
      state: 'held', note_id: note.id, kind: 'wrong', of: null, ground: 'report_confirmed', reason: ent.reason, run_id: ctx.runId,
      head_sha: ctx.headSha || null, cites: ent.cites, facts, scrub: null,
      report: { ...ctx.report, upheld_by: ctx.reviewer, ref: ctx.ref }, reviews: [],
    },
  });
  E.store.patchBody(note.id, (b) => { b.held = { row: held.id, kind: 'wrong', of: null, reason: ent.reason, run_id: ctx.runId, at: Date.now() }; return N.fitBody(b); });
  return held;
}

module.exports = { holdWrongFromReport };
