'use strict';
// memory-facts.cjs — safeguard S4 of the notes lifecycle: the facts a hide mark needs before it is written, and again
// when it is applied. Code reads stored facts and refuses; it never judges whether a note is true. Reads only (every
// statement is a SELECT; the embedding library is never loaded: a similarity is the cosine of two stored vectors).
//
//   duplicate   a stored similarity of at least 0.80 between the two notes, or a worker's report on the note naming
//               `of` as `replaced_by`; and `of` is a live, kept note (not refuted, not superseded, not itself held).
//   superseded  `of` is a live, newer note, not refuted, not itself held.
//   wrong       a trigger fact: a report from a writer other than the note's own, or a refuting review (status refuted).

const { err } = require('./errors.cjs');
const { standing } = require('./report-marks.cjs');
const { DUP_SIMILARITY } = require('./memory-lifecycle.cjs');

const COLS = 'id, namespace, type, written_by, run_id, task_id, title, text, text_hash, embedding, embedding_model, dim, body, status, status_receipt, created_at, supersedes, text_template';
const parse = s => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
const refuse = (message, detail) => err('E_PRECONDITION', message, detail);
const round3 = x => Math.round(x * 1000) / 1000;

function loadNote(E, id) {
  const r = E.store.p(`SELECT ${COLS} FROM memory_entries WHERE id = ?`).get(id);
  if (!r) return null;
  return { ...r, b: parse(r.body) };
}

// The cosine of two stored vectors, or null when either has none or they were not made by the same model or from the same text
// template (the 0.80 threshold was measured on v1 text; a v1 vector against a v2 one is never compared).
const templateOf = r => r.text_template || 'v1';
function storedCosine(a, b) {
  if (templateOf(a) !== templateOf(b)) return null;
  if (!a.embedding || !b.embedding || !a.dim || a.dim !== b.dim || a.embedding_model !== b.embedding_model) return null;
  const va = new Float32Array(a.embedding.buffer.slice(a.embedding.byteOffset, a.embedding.byteOffset + a.dim * 4));
  const vb = new Float32Array(b.embedding.buffer.slice(b.embedding.byteOffset, b.embedding.byteOffset + b.dim * 4));
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < va.length; i += 1) { dot += va[i] * vb[i]; na += va[i] * va[i]; nb += vb[i] * vb[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : null;
}

// A live, kept note of the project: in project/<p>, a note, not refuted, not replaced by another row, not held.
function liveKept(E, project, id, what) {
  const r = loadNote(E, id);
  if (!r || r.type !== 'note') throw refuse(`${what} ${id} is not a note`, { of: id });
  if (r.namespace !== `project/${project}`) throw refuse(`${what} ${id} is not live: it is in ${r.namespace}`, { of: id, namespace: r.namespace });
  if ((r.status || 'unverified') === 'refuted') throw refuse(`${what} ${id} is refuted`, { of: id });
  const gone = E.store.p('SELECT id FROM memory_entries WHERE supersedes = ? AND namespace = ?').get(id, r.namespace);
  if (gone) throw refuse(`${what} ${id} was superseded by ${gone.id}`, { of: id, superseded_by: gone.id });
  if (r.b.held) throw refuse(`${what} ${id} is itself held for archive, so it cannot be what another note stands against`, { of: id, held: r.b.held.row });
  return r;
}

// The note's own words: a quote of these is no evidence about the note.
function ownTexts(note) {
  return [note.title, note.when !== undefined ? note.when : note.b.when, note.text, ...((note.b.evidence || []).flatMap(e => [e && e.saw, e && e.where]))].filter(t => typeof t === 'string' && t.trim());
}

const lower = list => new Set((Array.isArray(list) ? list : []).filter(x => typeof x === 'string').map(x => x.trim().toLowerCase()).filter(Boolean));
const shares = (a, b) => [...a].some(x => b.has(x));

// The ground a hold states must be one its facts bear out.
const GROUND_TRIGGER = { refuted_review: 'refuted_review', report_confirmed: 'report_from_other_writer' };

// Throws E_PRECONDITION naming the missing fact, else returns the facts that held. `ground`, when given, must be
// one the facts support (refuted_review needs a refuted status; report_confirmed a report from another writer).
function checkHoldFacts(E, project, note, kind, ofId, ground, threshold = DUP_SIMILARITY, runId = null) {
  if (kind === 'wrong') {
    const others = standing(note.b).filter(w => w && w.by !== note.written_by);
    const refuted = (note.status || 'unverified') === 'refuted';
    if (!others.length && !refuted) throw refuse(`note ${note.id} has no trigger fact for a wrong hold: no report from a writer other than its own, and no refuting review`, { id: note.id, kind });
    const triggers = [...(refuted ? ['refuted_review'] : []), ...(others.length ? ['report_from_other_writer'] : [])];
    const need = GROUND_TRIGGER[ground];
    if (need && !triggers.includes(need)) throw refuse(`ground ${ground} is not borne out: the facts are ${triggers.join(' and ')}`, { id: note.id, ground, triggers });
    return { trigger: triggers[0], triggers, reports: others.length, status: note.status || 'unverified' };
  }
  const target = liveKept(E, project, ofId, kind === 'duplicate' ? 'the kept note' : 'the replacement');
  if (target.id === note.id) throw refuse('a note cannot stand against itself', { id: note.id });
  if (kind === 'superseded') {
    // A report of the hold's own run, by another writer, naming the replacement stands for the direction (a verified note a worker reported may be the newer one).
    const reportedBy = standing(note.b).some(w => w && w.replaced_by === target.id && w.by !== note.written_by && runId && w.run_id === runId);
    if (!(target.created_at > note.created_at) && !reportedBy) throw refuse(`${target.id} is not newer than ${note.id}, so it cannot replace it`, { id: note.id, of: target.id });
    // REPORT S4: the replacement must also be about the same thing: a shared path or subject, or a stored cosine at the threshold.
    const sim = storedCosine(note, target);
    const path = shares(lower(note.b.applies_to), lower(target.b.applies_to)), subject = shares(lower(note.b.subjects), lower(target.b.subjects));
    if (!path && !subject && !reportedBy && !(sim !== null && sim >= threshold)) throw refuse(`${target.id} shares no path or subject with ${note.id} and its stored similarity is ${sim === null ? 'unavailable' : round3(sim)} (needs ${threshold}), so it is not shown to replace it`, { id: note.id, of: target.id });
    return { replacement: target.id, replacement_created_at: target.created_at, note_created_at: note.created_at, shared: path ? 'path' : subject ? 'subject' : reportedBy ? 'report' : 'similarity', similarity: sim === null ? null : round3(sim), template: templateOf(note), replacement_template: templateOf(target) };
  }
  const sim = storedCosine(note, target);
  const matched = (note.b.matches || []).find(m => m && m.id === target.id);
  const best = Math.max(sim === null ? -1 : sim, matched && typeof matched.similarity === 'number' ? matched.similarity : -1);
  const reported = standing(note.b).some(w => w && w.replaced_by === target.id);
  const template = templateOf(note);
  if (best >= threshold) return { via: 'similarity', similarity: round3(best), kept: target.id, template };
  if (reported) return { via: 'report', similarity: best < 0 ? null : round3(best), kept: target.id, template };
  throw refuse(`note ${note.id} is not shown to duplicate ${target.id}: the stored similarity is ${best < 0 ? 'unavailable' : round3(best)} (needs ${threshold}) and no worker report names ${target.id} as the replacement`, { id: note.id, of: target.id, similarity: best < 0 ? null : round3(best) });
}

module.exports = { ownTexts, loadNote, storedCosine, liveKept, checkHoldFacts, parse, COLS };
