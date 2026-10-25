'use strict';
// memory-withhold.cjs — ADR 0047 amendments (2026-10-22, widened 2026-10-25): a WORKER whose run has memory.held_visibility 'withhold'
// (the default) does not see a note under an active hold of kind wrong, superseded or duplicate (heldWithheld below); a hold on a report
// withholds while any report on it still withholds (`withhold` not false). Released as correct, archived or settled, the hold leaves state 'held' and the note reappears at once;
// undecided keeps state 'held' and stays withheld. A read filter: SELECTs only, no model, nothing written (invariants 6 and 9).
//
// Who is withheld FROM is the recipient, never a request field. A worker's own tool call is its recipient; the run manager's injected
// index is built through the harness core for a worker it spawned, and memory.index marks that recipient with a symbol property
// (WITHHOLD_FOR) that no wire message can carry. Duplicate matching at a hand-back marks MATCHING: it decides, it delivers nothing.
// The orchestrator, the knowledge agent and the operator are never withheld from.

const rows = require('./rows.cjs');

const WITHHOLD_FOR = Symbol('belay.withholdFor');
const MATCHING = Symbol('belay.matching');

// { who } for a caller who is withheld from (when the run's lever says so), else null. `who` is the recipient worker id ('' when unknown).
function recipientOf(E, caller) {
  if (!caller || caller[MATCHING]) return null;
  let who = null;
  if (typeof caller[WITHHOLD_FOR] === 'string') who = caller[WITHHOLD_FOR];
  else if (caller.role === 'worker' && caller.channel !== 'harness') who = typeof caller.worker_id === 'string' ? caller.worker_id : '';
  if (who === null || who.startsWith('knowledge-')) return null;
  try {
    const run = rows.current(E.store, 'run', caller.run_id);
    const raw = run ? run.memory_levers : null;
    const lv = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return lv && typeof lv === 'object' && lv.notes === true && lv.held_visibility !== 'warn' ? { who } : null;
  } catch { return null; }
}
const withholds = (E, caller) => recipientOf(E, caller) !== null;

// The active harness holds, by namespace range (alias h), and a reported hold's test that some report on it still withholds.
const HELD_ROWS = `h.type = 'held' AND h.namespace >= 'held/' AND h.namespace < 'held0' AND h.written_by = 'harness' AND json_extract(h.body, '$.state') = 'held'`;
const WITHHOLDING = `EXISTS (SELECT 1 FROM json_each(h.body, '$.reports') r WHERE json_extract(r.value, '$.withhold') IS NOT 0)`;

const scan = (E, where) => {
  const out = new Map();
  let found = [];
  try {
    found = E.store.db.prepare(`SELECT json_extract(h.body, '$.note_id') AS nid, substr(h.namespace, 6) AS p FROM memory_entries h WHERE ${HELD_ROWS} AND ${where}`).all();
  } catch { return out; }
  for (const r of found) if (typeof r.nid === 'string') out.set(r.nid, r.p);
  return out;
};

// Note id -> project for every active hold on a report that still withholds (a resolution against a disputed note is refused on it).
const heldReported = (E) => scan(E, `json_extract(h.body, '$.ground') = 'reported' AND json_extract(h.body, '$.kind') IN ('wrong', 'superseded') AND ${WITHHOLDING}`);

// Note id -> project for every hold that withholds its note from a worker (ADR 0047 amendment of 2026-10-25, proposed): a hold of kind
// wrong, superseded or duplicate on any ground, except a reported hold whose every report was written past the breaker. An `unsupported`
// row is a verification queue, not a dispute, and is not withheld.
const heldWithheld = (E) => scan(E, `json_extract(h.body, '$.kind') IN ('wrong', 'superseded', 'duplicate') AND (json_extract(h.body, '$.ground') IS NOT 'reported' OR ${WITHHOLDING})`);

// The active hold of each note among `ids` whose note is live in its project, whoever reads (the orchestrator's and the operator's mark):
// note id -> { kind, ground, reason }. Every kind, unsupported included. A read of the hold rows.
function holdsAmong(E, ids) {
  const out = new Map();
  if (!ids.length) return out;
  let found = [];
  try {
    found = E.store.db.prepare(`SELECT json_extract(h.body, '$.note_id') AS nid, json_extract(h.body, '$.kind') AS kind, json_extract(h.body, '$.ground') AS ground,
      json_extract(h.body, '$.reason') AS reason FROM memory_entries h WHERE ${HELD_ROWS} AND json_extract(h.body, '$.note_id') IN (SELECT value FROM json_each(?))
      AND EXISTS (SELECT 1 FROM memory_entries n WHERE n.id = json_extract(h.body, '$.note_id') AND n.type = 'note' AND n.namespace = 'project/' || substr(h.namespace, 6))
      ORDER BY h.created_at, h.rowid`).all(JSON.stringify(ids));
  } catch { return out; }
  for (const r of found) if (typeof r.nid === 'string') out.set(r.nid, { kind: r.kind || null, ground: r.ground || null, reason: typeof r.reason === 'string' ? r.reason : null });
  return out;
}

// The notes among the rows being read (`lim`/`lp`: the gate's bounds) that a hold withholds and that are live in their project.
function noteIds(E, lim = [], lp = [], held = heldWithheld(E)) {
  if (!held.size) return [];
  const R = lim.length ? ` AND ${lim.join(' AND ')}` : '';
  try {
    return E.store.db.prepare(`SELECT e.id AS id, e.namespace AS ns FROM memory_entries e WHERE e.type = 'note' AND e.id IN (SELECT value FROM json_each(?))${R}`)
      .all(JSON.stringify([...held.keys()]), ...lp).filter((r) => r.ns === `project/${held.get(r.id)}`).map((r) => r.id);
  } catch { return []; }
}

// What the gate hides from `caller` among the rows being read.
function withheldIds(E, caller, lim, lp) {
  return withholds(E, caller) ? noteIds(E, lim, lp) : [];
}

// A task reviewer whose brief lists the note's report is shown the note: it is the one reader who must judge it. Derived from the store
// (the review task the worker holds, the tasks it depends on, the open reports about their notes), never from the request.
function reviewerSees(E, caller, noteRow) {
  try {
    if (!caller || caller.role !== 'worker' || !caller.worker_id) return false;
    const RV = require('./note-report-verdicts.cjs');
    const project = String(noteRow.namespace).slice(8);
    for (const l of rows.leasesHeldBy(E.store, caller.worker_id)) {
      const t = rows.current(E.store, 'task', l.task_id);
      if (!t || t.run_id !== caller.run_id || !t.acceptance || t.acceptance.verdict !== true) continue;
      const deps = Array.isArray(t.depends_on) ? t.depends_on : [];
      if (RV.reportsAbout(E, deps, project).some((r) => r.note.id === noteRow.id)) return true;
    }
  } catch { /* not a reviewer */ }
  return false;
}

// For a read by explicit id: the subset of `rowsById` ({ id, namespace, type }) withheld from this caller and not owed to a reviewer.
function withheldAmong(E, caller, list) {
  const out = new Set();
  if (!withholds(E, caller)) return out;
  const notes = list.filter((r) => r && r.type === 'note');
  if (!notes.length) return out;
  const held = heldWithheld(E);
  for (const r of notes) if (held.has(r.id) && r.namespace === `project/${held.get(r.id)}` && !reviewerSees(E, caller, r)) out.add(r.id);
  return out;
}

module.exports = { WITHHOLD_FOR, MATCHING, withholds, withheldIds, withheldAmong, heldReported, heldWithheld, holdsAmong, noteIds };
