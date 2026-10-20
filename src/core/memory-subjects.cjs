'use strict';
// memory-subjects.cjs — memory.noteSubjects, a read: the subjects the notes of a project already use, most used first. The
// hand-back question shows them to a worker and asks it to reuse one if it fits, so the same thing is not filed under three
// spellings. Nothing here judges a subject: it counts what the live notes carry. A refuted note and a replaced one do not count,
// and neither does a note the two-clock gate hides from the caller (another run's, still open; a promoted or pending one).
// The list is bounded twice, by number and by bytes, because it is text in a worker's opening message.

const { err } = require('./errors.cjs');
const gate = require('./memory-note-gate.cjs');

const LIMIT_MAX = 20;
const BYTES_MAX = 400;
const SUBJECT_BYTES_MAX = 40; // a longer subject is a sentence, not a subject

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

// { project, limit? } -> { project, subjects: [{ subject, notes }], bytes, considered }
async function noteSubjects(E, caller, args = {}) {
  if (typeof args.project !== 'string' || !args.project) throw err('E_ARGS', 'memory.noteSubjects needs a project', { field: 'project' });
  const limit = args.limit === undefined ? LIMIT_MAX : args.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) throw err('E_ARGS', `memory.noteSubjects limit must be an integer from 1 to ${LIMIT_MAX}`, { field: 'limit' });
  const ns = `project/${args.project}`;
  let rows = [];
  try {
    const g = gate.and({ where: '', params: [] }, E, caller, { namespaces: [ns] }); // the notes the caller could see, and no others
    rows = E.store.p(`SELECT e.body AS body FROM memory_entries e WHERE e.type = 'note' AND e.namespace = ? AND COALESCE(e.status, 'unverified') <> 'refuted' AND NOT EXISTS (SELECT 1 FROM memory_entries s WHERE s.supersedes = e.id AND s.namespace = e.namespace)${g.where ? ` AND ${g.where}` : ''}`).all(ns, ...g.params);
  } catch { rows = []; }
  const counts = new Map(); // lower-cased spelling -> { subject: the first spelling seen, n }
  for (const r of rows) {
    let b = null;
    try { b = JSON.parse(r.body); } catch { b = null; }
    const seen = new Set();
    for (const raw of (b && Array.isArray(b.subjects) ? b.subjects : [])) {
      if (typeof raw !== 'string') continue;
      const s = norm(raw);
      if (!s || Buffer.byteLength(s) > SUBJECT_BYTES_MAX || seen.has(s.toLowerCase())) continue;
      seen.add(s.toLowerCase());
      const c = counts.get(s.toLowerCase());
      if (c) c.n++; else counts.set(s.toLowerCase(), { subject: s, n: 1 });
    }
  }
  const ranked = [...counts.values()].sort((a, b) => b.n - a.n || (a.subject.toLowerCase() < b.subject.toLowerCase() ? -1 : 1));
  const subjects = [];
  let bytes = 0;
  for (const c of ranked) {
    if (subjects.length >= limit) break;
    const add = Buffer.byteLength(c.subject) + (subjects.length ? 2 : 0); // ", " between
    if (bytes + add > BYTES_MAX) continue;
    bytes += add;
    subjects.push({ subject: c.subject, notes: c.n });
  }
  return { project: args.project, subjects, bytes, considered: rows.length };
}

module.exports = { noteSubjects, LIMIT_MAX, BYTES_MAX };
