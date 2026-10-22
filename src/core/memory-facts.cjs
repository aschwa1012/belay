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
const { DUP_SIMILARITY, HARNESS_GROUNDS } = require('./memory-lifecycle.cjs');

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

// The similarity a note's recorded match (body.matches) names for `target`, or -1 when none binds to both vectors.
function recordedSimilarity(note, target) {
  const m = (note.b.matches || []).find(x => x && x.id === target.id && typeof x.similarity === 'number');
  if (!m || !m.embedding_model || !m.dim) return -1;
  if ((m.template || 'v1') !== templateOf(note) || templateOf(note) !== templateOf(target)) return -1;
  return m.embedding_model === note.embedding_model && m.embedding_model === target.embedding_model && m.dim === note.dim && m.dim === target.dim ? m.similarity : -1;
}

// Whether a note is held now: its pointer is set, or an active harness hold row of any kind (an unsupported queue row included) names it.
function isHeldNow(E, note) {
  if (!note || note.type !== 'note') return false;
  if (note.b && note.b.held) return true;
  const project = typeof note.namespace === 'string' && note.namespace.startsWith('project/') ? note.namespace.slice(8) : null;
  if (!project) return false;
  return !!E.store.p("SELECT 1 AS x FROM memory_entries WHERE namespace = ? AND type = 'held' AND written_by = 'harness' AND json_extract(body, '$.note_id') = ? AND json_extract(body, '$.state') = 'held' LIMIT 1").get(`held/${project}`, note.id);
}

// The one active hold row of a note, as { id, namespace, b } (b the parsed body), or null: a harness row of held/<project> in state `held` that names the note.
function activeHoldOf(E, project, noteId) {
  const r = E.store.p("SELECT id, namespace, body FROM memory_entries WHERE namespace = ? AND type = 'held' AND written_by = 'harness' AND json_extract(body, '$.note_id') = ? AND json_extract(body, '$.state') = 'held' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(`held/${project}`, noteId);
  return r ? { id: r.id, namespace: r.namespace, b: parse(r.body) } : null;
}

// Every active hold of a project at once: a Map from note id to { id, b }. A read.
function activeHoldsOf(E, project) {
  const out = new Map();
  for (const r of E.store.p("SELECT id, body FROM memory_entries WHERE namespace = ? AND type = 'held' AND written_by = 'harness' AND json_extract(body, '$.state') = 'held' ORDER BY created_at, rowid").all(`held/${project}`)) {
    const b = parse(r.body);
    if (b.note_id) out.set(b.note_id, { id: r.id, b });
  }
  return out;
}

// A live, kept note of the project: in project/<p>, a note, not refuted, not replaced by another row, not held.
function liveKept(E, project, id, what) {
  const r = loadNote(E, id);
  if (!r || r.type !== 'note') throw refuse(`${what} ${id} is not a note`, { of: id });
  if (r.namespace !== `project/${project}`) throw refuse(`${what} ${id} is not live: it is in ${r.namespace}`, { of: id, namespace: r.namespace });
  if ((r.status || 'unverified') === 'refuted') throw refuse(`${what} ${id} is refuted`, { of: id });
  const gone = E.store.p('SELECT id FROM memory_entries WHERE supersedes = ? AND namespace = ?').get(id, r.namespace);
  if (gone) throw refuse(`${what} ${id} was superseded by ${gone.id}`, { of: id, superseded_by: gone.id });
  if (isHeldNow(E, r)) throw refuse(`${what} ${id} is itself held for archive, so it cannot be what another note stands against`, { of: id, held: r.b.held ? r.b.held.row : null });
  return r;
}

// The note's own words: a quote of these is no evidence about the note.
function ownTexts(note) {
  return [note.title, note.when !== undefined ? note.when : note.b.when, note.text, ...((note.b.evidence || []).flatMap(e => [e && e.saw, e && e.where]))].filter(t => typeof t === 'string' && t.trim());
}

// The part of the note's own words that is a copy of printed output by contract: the `saw` of each evidence entry (see echoOf).
function sawsOf(note) {
  return (note.b.evidence || []).map(e => e && e.saw).filter(t => typeof t === 'string' && t.trim());
}

const lower = list => new Set((Array.isArray(list) ? list : []).filter(x => typeof x === 'string').map(x => x.trim().toLowerCase()).filter(Boolean));
const shares = (a, b) => [...a].some(x => b.has(x));

// The ground a hold states must be one its facts bear out.
const GROUND_TRIGGER = { refuted_review: 'refuted_review', report_confirmed: 'report_from_other_writer' };

// The replacement test of a report-made hold (ground `reported`): `targetId` is a live, kept note other than the note, and about the same thing (a
// shared path or subject, or a stored cosine at the threshold). The direction comes from the report, so the age rule does not apply and no report
// stands in for this test. Throws E_PRECONDITION, else returns the facts.
function supersededFacts(E, project, note, targetId, threshold) {
  const target = liveKept(E, project, targetId, 'the replacement');
  if (target.id === note.id) throw refuse('a note cannot stand against itself', { id: note.id });
  const sim = storedCosine(note, target);
  const path = shares(lower(note.b.applies_to), lower(target.b.applies_to)), subject = shares(lower(note.b.subjects), lower(target.b.subjects));
  if (!path && !subject && !(sim !== null && sim >= threshold)) throw refuse(`${target.id} shares no path or subject with ${note.id} and its stored similarity is ${sim === null ? 'unavailable' : round3(sim)} (needs ${threshold}), so it is not shown to replace it`, { id: note.id, of: target.id });
  return { replacement: target.id, replacement_created_at: target.created_at, note_created_at: note.created_at, shared: path ? 'path' : subject ? 'subject' : 'similarity', similarity: sim === null ? null : round3(sim), template: templateOf(note), replacement_template: templateOf(target) };
}

// The kind of a report-made hold, from its reports: one function at hold time and at archive time. Candidates in order: each report's
// replaced_by, newest report first, then the merged prior hold's `of` when it was a superseded or duplicate hold. The first that passes
// supersededFacts decides: { kind: 'superseded', of, facts }. Otherwise { kind: 'wrong', of: null, facts } with the replacement recorded and why it was refused.
function reportedKind(E, project, note, reports, threshold = DUP_SIMILARITY, prior = null) {
  const candidates = [];
  for (const w of [...(reports || [])].reverse()) if (w && typeof w.replaced_by === 'string' && w.replaced_by && !candidates.includes(w.replaced_by)) candidates.push(w.replaced_by);
  if (prior && (prior.kind === 'superseded' || prior.kind === 'duplicate') && typeof prior.of === 'string' && prior.of && !candidates.includes(prior.of)) candidates.push(prior.of);
  let refused = null;
  for (const id of candidates) {
    try { return { kind: 'superseded', of: id, facts: { ...supersededFacts(E, project, note, id, threshold), via: 'reported' } }; } catch (e) {
      if (e.code !== 'E_PRECONDITION') throw e;
      refused = refused || { of: id, reason: e.message };
    }
  }
  return { kind: 'wrong', of: null, facts: { trigger: 'report', reports: (reports || []).length, status: note.status || 'unverified', ...(candidates.length ? { replaced_by: candidates[0] } : {}), ...(refused ? { superseded_refused: refused.reason } : {}) } };
}

// The facts of a hold with ground `reported`. `held` is the hold body (its reports and, for superseded, its `of`): the facts are checked against
// the body that is stored. Kind wrong needs a report on the hold (whoever made it, whatever a reviewer said of it); kind superseded needs that
// and a replacement that still passes.
function reportedFacts(E, project, note, kind, ofId, threshold, held) {
  const reports = held && Array.isArray(held.reports) ? held.reports : [];
  if (!reports.length) throw refuse(`note ${note.id} has no report recorded on its hold, so a reported hold has no trigger fact`, { id: note.id, kind });
  if (kind === 'wrong') return { trigger: 'report', reports: reports.length, status: note.status || 'unverified' };
  if (kind !== 'superseded' || !ofId) throw refuse(`a reported hold is wrong or superseded of a named note, and this one is ${kind}`, { id: note.id, kind });
  return { ...supersededFacts(E, project, note, ofId, threshold), via: 'reported' };
}

// Throws E_PRECONDITION naming the missing fact, else returns the facts that held. `ground`, when given, must be
// one the facts support (refuted_review needs a refuted status; report_confirmed a report from another writer). `held` is the hold body
// that will be stored: required for ground `reported`, ignored for the other grounds.
function checkHoldFacts(E, project, note, kind, ofId, ground, threshold = DUP_SIMILARITY, runId = null, held = null) {
  if (ground === 'reported') {
    if (!(HARNESS_GROUNDS[kind] || []).includes('reported')) throw refuse(`ground reported is for a wrong or superseded hold, and this one is ${kind}`, { id: note.id, kind });
    return reportedFacts(E, project, note, kind, ofId, threshold, held);
  }
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
  // As a relation does (memory-relate.cjs): the stored cosine is the current fact and decides alone; a recorded match, made when the note was
  // written and possibly on a vector since replaced, counts only when there is no cosine and it names the model, dimension and template of both.
  const sim = storedCosine(note, target);
  const best = sim !== null ? sim : recordedSimilarity(note, target);
  const reported = standing(note.b).some(w => w && w.replaced_by === target.id);
  const template = templateOf(note);
  if (best >= threshold) return { via: 'similarity', similarity: round3(best), kept: target.id, template };
  if (reported) return { via: 'report', similarity: best < 0 ? null : round3(best), kept: target.id, template };
  throw refuse(`note ${note.id} is not shown to duplicate ${target.id}: the stored similarity is ${best < 0 ? 'unavailable' : round3(best)} (needs ${threshold}) and no worker report names ${target.id} as the replacement`, { id: note.id, of: target.id, similarity: best < 0 ? null : round3(best) });
}

module.exports = { ownTexts, sawsOf, loadNote, storedCosine, liveKept, isHeldNow, activeHoldOf, activeHoldsOf, checkHoldFacts, reportedKind, supersededFacts, parse, COLS };
