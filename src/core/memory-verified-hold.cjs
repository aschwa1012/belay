'use strict';
// memory-verified-hold.cjs — a write-time refines or supersedes of a review-verified note. A verified note is never hidden without the
// reviewer, so the new note goes live and the old one stays where it is, with a held row for the on-demand reviewer (the same row a
// scrubber's relate on a verified note writes). Only the operator replaces a verified note directly.

const { err } = require('./errors.cjs');
const L = require('./memory-lifecycle.cjs');
const C = require('./lifecycle-common.cjs');

const isVerified = n => (n.status || 'unverified') === 'verified';
const mustHold = (caller, target, relation) => (relation === 'refines' || relation === 'supersedes') && caller.role !== 'operator' && isVerified(target);

// Throws E_EXISTS when the verified note already waits on a reviewer. Writes the held row and puts the pointer on the note. `evidence` is the
// writer's own { where, saw } for the refinement or replacement: it is data on the row for the reviewer, never a cite (the reviewer's cites are its own).
function holdVerified(E, caller, project, target, newId, relation, reason, evidence) {
  if (target.b.held) throw err('E_EXISTS', `note ${target.id} is already held (${target.b.held.row}); the reviewer settles it before another hold`, { id: target.id, held_row: target.b.held.row });
  const runId = caller.run_id;
  const kind = 'superseded', ground = 'replaced_by_newer';
  const held = C.putRow(E, { ...caller, channel: 'harness' }, {
    ns: L.nsOf('held', project), type: 'held', runId,
    text: `held ${kind}: ${target.id} against ${newId} (run ${runId})`,
    title: `held ${kind}: ${target.title || target.id}`,
    body: { state: 'held', note_id: target.id, kind, relation, of: newId, ground, reason, run_id: runId, head_sha: null, cites: [], facts: { via: `write_time_${relation}`, by: E.memoryWriter(caller), ...(Array.isArray(evidence) && evidence.length ? { writer_evidence: evidence } : {}) }, scrub: null, reviews: [] },
  });
  E.store.patchBody(target.id, b => { b.held = { row: held.id, kind, of: newId, reason, run_id: runId, at: Date.now() }; return b; });
  return held;
}

module.exports = { holdVerified, mustHold };
