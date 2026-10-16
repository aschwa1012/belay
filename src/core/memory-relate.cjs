'use strict';
// memory-relate.cjs — the scrubber's relation verdicts on two LIVE notes of a project (the pairs the writer left unsettled: a
// worker's `replaced_by`, a `memory embed` match). A relation applies directly, with no hold and no reviewer, behind three gates:
//   (a) a score or a report: the stored cosine of the two notes (the same model and dimension) or a recorded match at or above
//       `notes_match_threshold`, or a worker report on one naming the other as `replaced_by`;
//   (b) both notes are live: in project/<p>, notes, not refuted, not superseded by another row, not held (a hold waits on a
//       reviewer and is settled there first);
//   (c) a non-empty reason, which memory-lifecycle.cjs's shape check already requires.
// The relations (the writer's set too):
//   new         the notes are distinct; the judgement is recorded on the note so the pair is not offered again.
//   repeats     one note is kept (the older, or the one `keep` names) and the other is archived; its sightings and delivery history move to the kept note.
//   supersedes  the newer note carries information the older lacked, a different lesson: the older is archived and keeps its history.
//   refines     the newer note is the same lesson plus a caveat: the older is archived and its history moves to the newer.
// Nothing is deleted: an archived note keeps its row and `memory.noteRestore` brings it back (a moved history goes back with it).

const { err } = require('./errors.cjs');
const { loadNote, storedCosine } = require('./memory-facts.cjs');
const { archiveNote } = require('./memory-archive.cjs');

const JUDGED_KEEP = 20;
const round3 = x => Math.round(x * 1000) / 1000;
const refuse = (message, detail) => err('E_PRECONDITION', message, detail);

// A live note of the project for a relation (gate b). Throws E_PRECONDITION, or E_NOT_FOUND for no such note.
function liveNote(E, project, id) {
  const r = loadNote(E, id);
  if (!r || r.type !== 'note') throw err('E_NOT_FOUND', `no note ${id}`, { id });
  if (r.namespace !== `project/${project}`) throw refuse(`note ${id} is not live: it is in ${r.namespace}, and a relation acts on two live notes of the project`, { id, namespace: r.namespace });
  if ((r.status || 'unverified') === 'refuted') throw refuse(`note ${id} is refuted`, { id });
  const gone = E.store.p('SELECT id FROM memory_entries WHERE supersedes = ? AND namespace = ?').get(id, r.namespace);
  if (gone) throw refuse(`note ${id} was superseded by ${gone.id}`, { id, superseded_by: gone.id });
  if (r.b.held) throw refuse(`note ${id} is held for archive (${r.b.held.row}); the reviewer settles that first`, { id, held: r.b.held.row });
  return r;
}

// Gates (a) and (b). Returns the facts that held, or throws E_PRECONDITION naming the one that did not.
function relationFacts(E, project, a, b, threshold) {
  if (a === b) throw refuse('a note cannot be related to itself', { id: a });
  const x = liveNote(E, project, a), y = liveNote(E, project, b);
  const cos = storedCosine(x, y);
  const listed = [x, y].flatMap(n => (n.b.matches || []).filter(m => m && m.id === (n === x ? y.id : x.id) && typeof m.similarity === 'number').map(m => m.similarity));
  const best = Math.max(cos === null ? -1 : cos, ...listed, -1);
  const reported = [x, y].some(n => (n.b.reported_wrong || []).some(w => w && w.replaced_by === (n === x ? y.id : x.id)));
  const facts = { notes: [x.id, y.id], similarity: best < 0 ? null : round3(best), threshold, reported };
  if (best >= threshold) return { ...facts, via: 'similarity', x, y };
  if (reported) return { ...facts, via: 'report', x, y };
  throw refuse(`notes ${x.id} and ${y.id} are not shown to be related: the stored similarity is ${best < 0 ? 'unavailable' : round3(best)} (needs ${threshold}) and no worker report names one as the replacement of the other`, facts);
}

// Which of the pair a relation archives and which it keeps, by the notes' own facts. `keep` ('id' | 'of') picks the survivor of a repeat.
function sides(relation, x, y, keep) {
  if (relation === 'repeats') {
    const older = x.created_at < y.created_at || (x.created_at === y.created_at && x.id < y.id) ? x : y;
    const kept = keep === 'id' ? x : keep === 'of' ? y : older;
    return { kept, gone: kept === x ? y : x };
  }
  if (x.created_at === y.created_at) throw refuse(`notes ${x.id} and ${y.id} were written at the same instant, so neither is the newer`, { id: x.id, of: y.id });
  const neu = x.created_at > y.created_at ? x : y;
  return { kept: neu, gone: neu === x ? y : x };
}

// Applies one verdict inside the caller's transaction. `ent` is the checked scrub entry { id, of, relation, keep?, reason }. Returns the proof.
function applyRelation(E, ctx, ent) {
  const f = relationFacts(E, ctx.project, ent.id, ent.of, ctx.threshold);
  const { x, y } = f;
  const meta = { run_id: ctx.runId, head_sha: ctx.evidence && ctx.evidence.head_sha, direct: true, reason: ent.reason, relation: ent.relation, receipt: ctx.receipt || null };
  if (ent.relation === 'new') {
    for (const [n, other] of [[x, y], [y, x]]) {
      E.store.patchBody(n.id, b => { b.pair_judged = [...(b.pair_judged || []), { of: other.id, run_id: ctx.runId, at: Date.now(), reason: ent.reason }].slice(-JUDGED_KEEP); return b; });
    }
    return { relation: 'new', facts: strip(f), archived: null, kept: null };
  }
  const { kept, gone } = sides(ent.relation, x, y, ent.keep);
  const done = ent.relation === 'repeats'
    ? archiveNote(E, ctx.project, gone, { ...meta, kind: 'duplicate', of: kept.id, ground: 'same_claim', via: 'repeats' }, kept)
    : archiveNote(E, ctx.project, gone, { ...meta, kind: 'superseded', of: kept.id, ground: 'replaced_by_newer', refines: ent.relation === 'refines', via: ent.relation }, kept);
  return { relation: ent.relation, facts: strip(f), archived: gone.id, kept: kept.id, archived_as: done.to, history_moved: done.history_moved };
}

const strip = ({ x, y, ...facts }) => facts;

module.exports = { relationFacts, applyRelation, liveNote, sides };
