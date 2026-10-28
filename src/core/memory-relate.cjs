'use strict';
// memory-relate.cjs — the scrubber's relation verdicts on two LIVE notes of a project (the pairs the writer left unsettled: a
// worker's `replaced_by`, a `memory embed` match). A relation applies directly, with no hold and no reviewer, behind three gates:
//   (a) a score or a report:
//       - the stored cosine of the two notes' vectors, whenever both have one of the same model, dimension and text template
//         (storedCosine). It is the current fact and it decides alone: a recorded match is never added to it;
//       - only when no such cosine exists, a recorded match (body.matches) that names the same model, dimension and template as both
//         notes' vectors, at or above `notes_match_threshold`;
//       - or a worker report from THIS run, by a writer other than the reported note's own, naming the other note as `replaced_by`.
//         The report gives the direction: the reported note is the one archived.
//   (b) both notes are live: in project/<p>, notes, not refuted, not superseded by another row, not held (a hold waits on a reviewer and
//       is settled there first);
//   (c) a non-empty reason, which memory-lifecycle.cjs's shape check already requires.
// The relations (the writer's set too):
//   new         the notes are distinct; the judgement is recorded on both notes, with the text and vector it was made on.
//   repeats     one note is kept (the older, or the one `keep` names) and the other is archived; its history moves to the kept note.
//   supersedes  the newer note carries information the older lacked, a different lesson: the older is archived and keeps its history.
//   refines     the newer note is the same lesson plus a caveat: the older is archived and its history moves to the newer.
// "Older" is created_at, then insertion order. A relation that would archive a review-verified note is not applied: the scrubber makes it
// a hold for the Opus reviewer instead (a verified note is never hidden without the reviewer). Nothing is deleted: an archived note keeps
// its row and `memory.noteRestore` brings it back (a moved history goes back with it).

const { err } = require('./errors.cjs');
const { loadNote, storedCosine, isHeldNow } = require('./memory-facts.cjs');
const { archiveNote } = require('./memory-archive.cjs');
const { upheld } = require('./report-marks.cjs');

const JUDGED_KEEP = 20;
const round3 = x => Math.round(x * 1000) / 1000;
const refuse = (message, detail) => err('E_PRECONDITION', message, detail);
const templateOf = r => r.text_template || 'v1';
// What a judgement was made on: a note's text, its vector's model and dimension, and its template. A change in any reopens the pair.
const keyOf = n => `${n.text_hash}|${n.embedding_model || ''}|${n.dim || ''}|${templateOf(n)}`;
// A `new` verdict recorded by `n` on `other` holds only while both notes still have the text, vector model, dimension and template it was made on.
// `n` and `other` are loaded notes (`.b` is the parsed body). The one rule every reader of a judged pair applies.
const judgedPair = (n, other) => ((n.b && n.b.pair_judged) || []).some(j => j && j.of === other.id && j.own_key === keyOf(n) && j.of_key === keyOf(other));

// A live note of the project for a relation (gate b). Throws E_PRECONDITION, or E_NOT_FOUND for no such note.
function liveNote(E, project, id) {
  const r = loadNote(E, id);
  if (!r || r.type !== 'note') throw err('E_NOT_FOUND', `no note ${id}`, { id });
  if (r.namespace !== `project/${project}`) throw refuse(`note ${id} is not live: it is in ${r.namespace}, and a relation acts on two live notes of the project`, { id, namespace: r.namespace });
  if ((r.status || 'unverified') === 'refuted') throw refuse(`note ${id} is refuted`, { id });
  const gone = E.store.p('SELECT id FROM memory_entries WHERE supersedes = ? AND namespace = ?').get(id, r.namespace);
  if (gone) throw refuse(`note ${id} was superseded by ${gone.id}`, { id, superseded_by: gone.id });
  if (isHeldNow(E, r)) throw refuse(`note ${id} is held for archive (${r.b.held ? r.b.held.row : 'queued for review'}); the reviewer settles that first`, { id, held: r.b.held ? r.b.held.row : null });
  const o = E.store.p('SELECT rowid AS rid FROM memory_entries WHERE id = ?').get(id);
  return { ...r, rid: o ? o.rid : 0 };
}

// The recorded matches that bind: same model, dimension and template as both notes' vectors.
function bindingMatches(x, y) {
  const out = [];
  for (const [n, other] of [[x, y], [y, x]]) {
    for (const m of (n.b.matches || [])) {
      if (!m || m.id !== other.id || typeof m.similarity !== 'number') continue;
      if (!m.embedding_model || !m.dim || (m.template || 'v1') !== templateOf(x) || templateOf(x) !== templateOf(y)) continue;
      if (m.embedding_model === x.embedding_model && m.embedding_model === y.embedding_model && m.dim === x.dim && m.dim === y.dim) out.push(m.similarity);
    }
  }
  return out;
}

// A report that opens the gate (only one a reviewer upheld: never a rejected or an unjudged one; report-marks.cjs): from this run, naming `to` as the replacement of `from`, by a writer other than from's own.
const reportOn = (from, to, runId) => upheld(from.b).some(w => w && w.replaced_by === to.id && w.run_id === runId && w.by !== from.written_by);

// Gates (a) and (b). Returns the facts that held, or throws E_PRECONDITION naming the one that did not.
function relationFacts(E, project, a, b, threshold, runId) {
  if (a === b) throw refuse('a note cannot be related to itself', { id: a });
  const x = liveNote(E, project, a), y = liveNote(E, project, b);
  const cos = storedCosine(x, y);
  const best = cos !== null ? cos : Math.max(-1, ...bindingMatches(x, y));
  const facts = { notes: [x.id, y.id], similarity: best < 0 ? null : round3(best), threshold, source: cos !== null ? 'stored_cosine' : best >= 0 ? 'recorded_match' : null, template: templateOf(x) };
  // A report of this run that names the pair gives the direction whatever the score says: the reported note is the one archived, so a
  // note the worker vouched for is never the one hidden. (Two opposing reports give no direction: age decides.)
  const xy = reportOn(x, y, runId), yx = reportOn(y, x, runId);
  const reported = xy !== yx ? (xy ? x.id : y.id) : undefined;
  if (best >= threshold) return { ...facts, via: 'similarity', ...(reported ? { reported } : {}), x, y };
  if (xy || yx) return { ...facts, via: 'report', ...(reported ? { reported } : {}), x, y };
  throw refuse(`notes ${x.id} and ${y.id} are not shown to be related: the stored similarity is ${best < 0 ? 'unavailable' : round3(best)} (needs ${threshold}) and no worker report of this run, by another writer, names one as the replacement of the other`, facts);
}

const older = (x, y) => x.created_at < y.created_at || (x.created_at === y.created_at && x.rid < y.rid);

// Which of the pair a relation archives and which it keeps. When a report of this run names the pair, the reported note is archived,
// whatever the score; with none, the direction is the notes' own: the older of a repeat is kept (or the one `keep` names), and the newer of supersedes and refines stays.
function sides(relation, f, keep) {
  const { x, y } = f;
  if (f.reported) { const gone = f.reported === x.id ? x : y; return { gone, kept: gone === x ? y : x }; }
  if (relation === 'repeats') {
    const kept = keep === 'id' ? x : keep === 'of' ? y : (older(x, y) ? x : y);
    return { kept, gone: kept === x ? y : x };
  }
  const neu = older(x, y) ? y : x;
  return { kept: neu, gone: neu === x ? y : x };
}

const verified = n => (n.status || 'unverified') === 'verified';

// The plan for one verdict, before anything is written: the facts, who is archived and who is kept.
function plan(E, ctx, ent) {
  const f = relationFacts(E, ctx.project, ent.id, ent.of, ctx.threshold, ctx.runId);
  if (ent.relation === 'new') return { f, relation: 'new' };
  const { gone, kept } = sides(ent.relation, f, ent.keep);
  return { f, relation: ent.relation, gone, kept, needsHold: verified(gone) };
}

// Applies a planned verdict inside the caller's transaction. Returns the proof.
function applyPlan(E, ctx, ent, p) {
  const { f } = p;
  const strip = ({ x, y, ...facts }) => facts;
  const meta = { run_id: ctx.runId, head_sha: ctx.evidence && ctx.evidence.head_sha, direct: true, reason: ent.reason, relation: ent.relation, receipt: ctx.receipt || null };
  if (ent.relation === 'new') {
    const at = Date.now();
    for (const [n, other] of [[f.x, f.y], [f.y, f.x]]) {
      E.store.patchBody(n.id, b => {
        const all = [...(b.pair_judged || []).filter(j => j && j.of !== other.id), { of: other.id, run_id: ctx.runId, at, reason: ent.reason, own_key: keyOf(n), of_key: keyOf(other) }];
        const cut = Math.max(0, all.length - JUDGED_KEEP);
        if (cut) b.pair_judged_cut = { count: ((b.pair_judged_cut && b.pair_judged_cut.count) || 0) + cut, at, note: 'the oldest judged pairs were dropped and may be offered again' };
        b.pair_judged = all.slice(cut);
        return b;
      });
    }
    return { relation: 'new', facts: strip(f), archived: null, kept: null };
  }
  const { gone, kept } = p;
  const done = ent.relation === 'repeats'
    ? archiveNote(E, ctx.project, gone, { ...meta, kind: 'duplicate', of: kept.id, ground: 'same_claim', via: 'repeats' }, kept)
    : archiveNote(E, ctx.project, gone, { ...meta, kind: 'superseded', of: kept.id, ground: 'replaced_by_newer', refines: ent.relation === 'refines', via: ent.relation }, kept);
  return { relation: ent.relation, facts: strip(f), archived: gone.id, kept: kept.id, archived_as: done.to, history_moved: done.history_moved, replaced_also_archived: done.replaced_also_archived };
}

module.exports = { relationFacts, plan, applyPlan, liveNote, sides, keyOf, judgedPair, JUDGED_KEEP };
