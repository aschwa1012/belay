'use strict';
// memory-notes.cjs — ADR 0047 decision 2: the shape of a note, checked by the core and refused by name, never
// truncated. Pure: no I/O, no store, nothing from the embedder, so any path may load it.
//
// A note is stored as a memory row of type `note`. `checkNote` returns the fields a caller may state (kind, title,
// basis, evidence, applies_to, subjects). The writer, its model and the run come from the harness, never from here:
// an unknown key (`model`, `written_by`, `id`) is refused, because invariant 3 says a model cannot name itself.

const { err } = require('./errors.cjs');
const { validId } = require('./memory-rows.cjs');

const KINDS = Object.freeze(['lesson', 'flag', 'recurring', 'gotcha']);
const BASES = Object.freeze(['observed', 'inferred', 'relayed']);
const RESOLVES = Object.freeze(['new', 'repeats', 'supersedes', 'refines']);
const TITLE_MAX = 160;
const NOTES_MAX = 10; // notes in one hand-back
const EVIDENCE_MAX = 8, WHERE_MAX = 300, SAW_MAX = 500;
const LIST_MAX = 8, ITEM_MAX = 300;
const WRONG_MAX = 20, WHY_MAX = 500;
const RESOLUTIONS_MAX = 20;
const NOTE_KEYS = ['kind', 'title', 'basis', 'evidence', 'applies_to', 'subjects'];

const bad = (message, detail) => err('E_NOTE_SHAPE', message, detail);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const bytes = s => Buffer.byteLength(s, 'utf8');
// One line: control characters become spaces and whitespace runs collapse (the memory.store title rule).
const oneLine = s => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();

function checkTitle(title, at) {
  if (typeof title !== 'string') throw bad(`${at}title must be a string: the claim itself`, { field: 'title' });
  const t = oneLine(title);
  if (!t) throw bad(`${at}title is empty: it must be the claim itself`, { field: 'title' });
  if (bytes(t) > TITLE_MAX) throw bad(`${at}title is ${bytes(t)} bytes and the limit is ${TITLE_MAX}; it is never truncated, so state the claim shorter`, { field: 'title', bytes: bytes(t), max: TITLE_MAX });
  return t;
}

function checkEvidence(list, at, required) {
  if (list === undefined || list === null) list = [];
  if (!Array.isArray(list)) throw bad(`${at}evidence must be an array of { where, saw }`, { field: 'evidence' });
  if (list.length > EVIDENCE_MAX) throw bad(`${at}evidence holds ${list.length} entries and the most is ${EVIDENCE_MAX}`, { field: 'evidence', max: EVIDENCE_MAX });
  const out = list.map((e, i) => {
    if (!isObj(e)) throw bad(`${at}evidence[${i}] must be an object { where, saw }`, { field: 'evidence', index: i });
    for (const k of Object.keys(e)) if (k !== 'where' && k !== 'saw') throw bad(`${at}evidence[${i}].${k} is not a field; use where and saw`, { field: 'evidence', index: i });
    for (const [k, max] of [['where', WHERE_MAX], ['saw', SAW_MAX]]) {
      if (typeof e[k] !== 'string' || !e[k].trim()) throw bad(`${at}evidence[${i}].${k} must be a non-empty string`, { field: 'evidence', index: i });
      if (bytes(e[k]) > max) throw bad(`${at}evidence[${i}].${k} is over ${max} bytes`, { field: 'evidence', index: i, max });
    }
    return { where: e.where.trim(), saw: e.saw.trim() };
  });
  if (required && !out.length) throw bad(`${at}a note with basis observed needs at least one evidence entry { where, saw }`, { field: 'evidence', basis: 'observed' });
  return out;
}

function checkList(v, name, at) {
  if (v === undefined || v === null) return [];
  const list = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(list) || list.length > LIST_MAX || list.some(x => typeof x !== 'string' || !x.trim() || bytes(x) > ITEM_MAX)) {
    throw bad(`${at}${name} must be a string or an array of at most ${LIST_MAX} non-empty strings of at most ${ITEM_MAX} bytes`, { field: name });
  }
  return list.map(x => oneLine(x)).filter(Boolean);
}

// One note as the caller states it. `index` only names the entry in a refusal.
function checkNote(raw, index) {
  const at = index === undefined ? '' : `notes[${index}]: `;
  if (!isObj(raw)) throw bad(`${at}a note must be an object`, { index });
  for (const k of Object.keys(raw)) {
    if (!NOTE_KEYS.includes(k)) throw bad(`${at}${k} is not a note field (use ${NOTE_KEYS.join(', ')}); the writer, its model and the run are taken from how the worker was spawned`, { field: k, index });
  }
  if (!KINDS.includes(raw.kind)) throw bad(`${at}kind must be one of ${KINDS.join(', ')}`, { field: 'kind', index });
  const title = checkTitle(raw.title, at);
  if (!BASES.includes(raw.basis)) throw bad(`${at}basis is required and must be one of ${BASES.join(', ')}`, { field: 'basis', index });
  const evidence = checkEvidence(raw.evidence, at, raw.basis === 'observed');
  return { kind: raw.kind, title, basis: raw.basis, evidence, applies_to: checkList(raw.applies_to, 'applies_to', at), subjects: checkList(raw.subjects, 'subjects', at) };
}

function checkNotes(list) {
  if (!Array.isArray(list)) throw err('E_ARGS', 'notes must be an array ([] when there is nothing to share)', { field: 'notes' });
  if (list.length > NOTES_MAX) throw bad(`notes holds ${list.length} entries and one hand-back may carry at most ${NOTES_MAX}`, { field: 'notes', max: NOTES_MAX });
  return list.map((n, i) => checkNote(n, i));
}

// The text a note is embedded and keyword-indexed by: the claim first, then what it applies to and what was seen.
function noteText(n) {
  const lines = [n.title];
  if (n.applies_to.length) lines.push(`applies to: ${n.applies_to.join('; ')}`);
  if (n.subjects.length) lines.push(`subjects: ${n.subjects.join('; ')}`);
  for (const e of n.evidence) lines.push(`evidence: ${e.where} - ${e.saw}`);
  return lines.join('\n');
}

// reported_wrong: [{ id, why, replaced_by? }]. `replaced_by` is a note id, `notes[<i>]` (the i-th note of the same
// call, resolved after it is stored) or null.
const SELF_REF = /^notes\[(\d+)\]$/;
function checkReportedWrong(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > WRONG_MAX) throw err('E_ARGS', `reported_wrong must be an array of at most ${WRONG_MAX} { id, why, replaced_by }`, { field: 'reported_wrong' });
  return list.map((w, i) => {
    if (!isObj(w)) throw err('E_ARGS', `reported_wrong[${i}] must be an object { id, why, replaced_by }`, { field: 'reported_wrong', index: i });
    for (const k of Object.keys(w)) if (!['id', 'why', 'replaced_by'].includes(k)) throw err('E_ARGS', `reported_wrong[${i}].${k} is not a field; use id, why, replaced_by`, { field: 'reported_wrong', index: i });
    if (!validId(w.id)) throw err('E_ARGS', `reported_wrong[${i}].id must be a note id`, { field: 'reported_wrong', index: i });
    if (typeof w.why !== 'string' || !w.why.trim() || bytes(w.why) > WHY_MAX) throw err('E_ARGS', `reported_wrong[${i}].why must be a non-empty string of at most ${WHY_MAX} bytes`, { field: 'reported_wrong', index: i });
    const rb = w.replaced_by === undefined ? null : w.replaced_by;
    if (rb !== null && !(validId(rb) || SELF_REF.test(rb))) throw err('E_ARGS', `reported_wrong[${i}].replaced_by must be null, a note id or notes[<index>]`, { field: 'reported_wrong', index: i });
    return { id: w.id, why: oneLine(w.why), replaced_by: rb };
  });
}

// memory_ids: the note ids the worker actually applied, [] when none. A claim, so an id need not exist; the shape is
// checked and never truncated.
const MEMORY_IDS_MAX = 50;
function checkMemoryIds(list) {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list) || list.length > MEMORY_IDS_MAX || list.some(x => !validId(x))) {
    throw err('E_ARGS', `memory_ids must be an array of at most ${MEMORY_IDS_MAX} memory ids ([] when no note was applied)`, { field: 'memory_ids' });
  }
  return [...new Set(list)];
}

// memory.noteResolve: [{ id, resolve: 'new' | 'repeats' | 'supersedes' | 'refines', of?, evidence? }]. `supersedes` needs evidence
// (it says the old note is out of date); `refines` (the same lesson plus a caveat) takes it as optional, because the new note
// carries its own evidence and the old lesson is not called wrong.
function checkResolutions(list) {
  if (!Array.isArray(list) || !list.length || list.length > RESOLUTIONS_MAX) throw err('E_ARGS', `resolutions must be an array of 1 to ${RESOLUTIONS_MAX} entries`, { field: 'resolutions' });
  const seen = new Set();
  return list.map((r, i) => {
    const at = `resolutions[${i}]`;
    if (!isObj(r)) throw err('E_ARGS', `${at} must be an object { id, resolve, of, evidence }`, { field: 'resolutions', index: i });
    for (const k of Object.keys(r)) if (!['id', 'resolve', 'of', 'evidence', 'title'].includes(k)) throw err('E_ARGS', `${at}.${k} is not a field; use id, resolve, of, evidence, title`, { field: 'resolutions', index: i });
    if (!validId(r.id)) throw err('E_ARGS', `${at}.id must be a pending note id`, { field: 'resolutions', index: i });
    if (seen.has(r.id)) throw err('E_ARGS', `${at}.id ${r.id} is resolved twice in one call`, { field: 'resolutions', index: i });
    seen.add(r.id);
    if (!RESOLVES.includes(r.resolve)) throw err('E_ARGS', `${at}.resolve must be one of ${RESOLVES.join(', ')}`, { field: 'resolutions', index: i });
    if (r.resolve === 'new') {
      if (r.of !== undefined || r.evidence !== undefined) throw err('E_ARGS', `${at}: resolve new takes neither of nor evidence`, { field: 'resolutions', index: i });
      // A changed title is how a note that clashes with a row of the same text is made distinct.
      return r.title === undefined ? { id: r.id, resolve: 'new' } : { id: r.id, resolve: 'new', title: checkTitle(r.title, `${at}.`) };
    }
    if (!validId(r.of) || r.of === r.id) throw err('E_ARGS', `${at}.of must be the id of the live note this ${r.resolve}`, { field: 'resolutions', index: i });
    if (r.resolve === 'repeats') {
      if (r.evidence !== undefined) throw err('E_ARGS', `${at}: resolve repeats takes no evidence`, { field: 'resolutions', index: i });
      return { id: r.id, resolve: 'repeats', of: r.of };
    }
    if (r.resolve === 'refines') {
      if (r.evidence === undefined) return { id: r.id, resolve: 'refines', of: r.of };
      try { return { id: r.id, resolve: 'refines', of: r.of, evidence: checkEvidence(r.evidence, `${at}: `, false) }; } catch (e) { throw err('E_ARGS', e.message, { field: 'resolutions', index: i }); }
    }
    let evidence;
    try { evidence = checkEvidence(r.evidence, `${at}: `, true); } catch (e) {
      throw err('E_ARGS', e.message.replace('a note with basis observed needs', 'supersedes needs'), { field: 'resolutions', index: i });
    }
    return { id: r.id, resolve: 'supersedes', of: r.of, evidence };
  });
}

module.exports = { checkTitle, KINDS, BASES, RESOLVES, TITLE_MAX, NOTES_MAX, checkNote, checkNotes, noteText, checkReportedWrong, checkMemoryIds, checkResolutions, oneLine, SELF_REF };
