'use strict';
// memory-withhold.cjs — ADR 0047 amendments (2026-10-22, widened 2026-10-25): a WORKER whose run has memory.held_visibility 'withhold'
// (the default) does not see a note under an active hold of kind wrong, superseded or duplicate (heldWithheld below); a hold on a report
// is written only while a report on it withholds (`withhold` not false), so every such hold hides its note. Released as correct, archived or settled, the hold leaves state 'held' and the note reappears at once;
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

// The active harness holds in state held, by namespace range (alias h). A body that is not valid JSON is kept (CASE evaluates lazily, so no
// json_extract ever meets it): the rule below judges it, closed.
// A body that is valid JSON but not an object is kept too: judge() reads it as malformed and closes its project, so no held row leaves its note open.
const HELD_ROWS = `h.type = 'held' AND h.namespace >= 'held/' AND h.namespace < 'held0' AND h.written_by = 'harness' AND CASE WHEN json_valid(h.body) AND json_type(h.body) = 'object' THEN json_extract(h.body, '$.state') = 'held' ELSE 1 END`;

// Note id -> project for every hold that withholds its note from a worker (ADR 0047 amendment of 2026-10-25, proposed): a hold in state held of
// kind wrong, superseded or duplicate, on any ground. A report past the breaker now writes a `queued` hold, which this never reads. A reported
// hold an older store wrote in state held with every report past the breaker still hides nothing: `judge` keeps that rule, read, with no
// rewrite of the row. A reported hold this code writes in state held says so (`hides: true`): it may hide on a hold it took over, with every
// report past the breaker. An `unsupported` row is a verification queue, not a dispute, and is not withheld.
const HIDING_KINDS = ['wrong', 'superseded', 'duplicate'];

// One hold body, judged in JS so that no shape of it can throw: { hides, malformed }. A body this rule cannot read (not an object, or a reported
// hold whose reports are not a list of objects) fails CLOSED: it hides its note, and it is named as malformed so the operator is told.
function judge(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { hides: true, malformed: true };
  // A hold must name its note: one that does not cannot be matched to a note, so it closes its project (heldWithheld) and is named as malformed.
  if (typeof b.note_id !== 'string' || !b.note_id) return { hides: b.state === 'held', malformed: true };
  if (b.state !== 'held' || !HIDING_KINDS.includes(b.kind)) return { hides: false, malformed: false };
  if (b.ground !== 'reported' || b.hides === true) return { hides: true, malformed: false };
  if (b.reports !== undefined && (!Array.isArray(b.reports) || b.reports.some((r) => !r || typeof r !== 'object' || Array.isArray(r)))) return { hides: true, malformed: true };
  return { hides: (b.reports || []).some((r) => r.withhold !== false), malformed: false };
}
const hidesNote = (b) => judge(b).hides;
// A legacy past-breaker hold (state held, a hiding kind, ground reported, hiding nothing) is counted, listed and ranked as queued.
const effectiveState = (b) => (b && b.state === 'held' && HIDING_KINDS.includes(b.kind) && b.ground === 'reported' && !judge(b).hides ? 'queued' : b && b.state);
const parseBody = (t) => { try { const b = JSON.parse(t); return b && typeof b === 'object' && !Array.isArray(b) ? b : null; } catch { return null; } };
const NOTE_ID = /"note_id"\s*:\s*"([^"\\]{1,128})"/; // a note id read from a body that is not JSON, to hide that note (closed)

// Malformed holds are told on stderr (the owner's or the adapter's log) once per row and process: a read writes nothing to the store.
const told = new Set();
function tell(id, why, project) {
  if (told.has(id)) return;
  told.add(id);
  const what = project ? `every note of project ${project} is withheld from workers` : 'its note is withheld from workers';
  try { process.stderr.write(`belay: held row ${id} cannot be read (${why}); ${what} until the operator settles it\n`); } catch { /* no stderr */ }
}

// Every active hold in state held, judged: [{ id, project, note_id (null when none can be named), hides, malformed, why }]. One scan of the held rows by
// namespace range; a body is parsed and judged in JS, so no shape of one can throw. Throws only when the query itself fails.
function readHolds(db) {
  const out = [];
  for (const r of db.prepare(`SELECT h.id AS id, substr(h.namespace, 6) AS p, h.body AS body FROM memory_entries h WHERE ${HELD_ROWS}`).all()) {
    const b = parseBody(r.body);
    const j = judge(b);
    const named = b && typeof b.note_id === 'string' && b.note_id ? b.note_id : null;
    // A note id is read out of a body only when it is not JSON at all; valid JSON that is not an object names no note, so it closes its project.
    let json = true;
    if (!b) { try { JSON.parse(r.body); } catch { json = false; } }
    const nid = named || (b || json ? null : (NOTE_ID.exec(String(r.body || '')) || [])[1] || null);
    const why = !j.malformed ? null : !b ? (json ? 'its body is not a JSON object' : 'its body is not JSON') : !named ? 'its note_id is not a non-empty string' : 'its reports are not a list of objects';
    out.push({ id: r.id, project: r.p, note_id: nid, hides: j.hides, malformed: j.malformed, why });
  }
  return out;
}

// The malformed holds of the store, for the operator's count and notice: [{ id, project, note_id, why }]; [] when the query cannot run.
function unreadable(db) {
  try { return readHolds(db).filter((h) => h.malformed).map(({ id, project, note_id, why }) => ({ id, project, note_id, why })); } catch { return []; }
}

// Note id -> project for every hold that withholds its note, and `closed`: the projects with a malformed hold whose note cannot be named, every
// note of which is withheld. A query that fails outright returns { failed } and the caller withholds every note it reads. Memoized on the store
// until it changes (this connection's total_changes() and SQLite's data_version, which counts other connections' commits). Never inside a
// transaction, whose writes a rollback can take back with the key unchanged; and Store.tx drops the memo when it rolls back.
function heldWithheld(E) {
  const db = E.store.db;
  let key = null;
  try { if (!db.isTransaction) key = `${E.store.p('SELECT total_changes() AS c').get().c}|${E.store.p('PRAGMA data_version').get().data_version}`; } catch { key = null; }
  const memo = E.store.heldMemo;
  if (key !== null && memo && memo.key === key) return memo.value;
  const out = new Map();
  out.closed = new Set();
  let holds;
  try { holds = readHolds(db); } catch (e) { out.failed = e; tell('(query)', e.message, null); return out; }
  for (const h of holds) {
    if (!h.hides) continue;
    if (h.malformed) tell(h.id, h.why, h.note_id ? null : h.project);
    if (h.note_id) out.set(h.note_id, h.project);
    else out.closed.add(h.project);
  }
  if (key !== null) E.store.heldMemo = { key, value: out };
  return out;
}

// The active hold of each note among `ids` whose note is live in its project, whoever reads (the orchestrator's and the operator's mark):
// note id -> { kind, ground, reason }. Only a hold that hides its note is marked: an `unsupported` row and a hold that hides nothing (a legacy
// hold past the breaker, shown as queued) leave the note a normal one for every reader, with no mark and no demotion (note-unsupported.cjs).
function holdsAmong(E, ids) {
  const out = new Map();
  if (!ids.length) return out;
  let found = [];
  try {
    found = E.store.db.prepare(`SELECT h.body AS body, substr(h.namespace, 6) AS p FROM memory_entries h WHERE ${HELD_ROWS}
      AND CASE WHEN json_valid(h.body) THEN json_extract(h.body, '$.note_id') IN (SELECT value FROM json_each(?)) ELSE 0 END
      ORDER BY h.created_at, h.rowid`).all(JSON.stringify(ids));
  } catch { return out; }
  const live = new Set();
  try {
    for (const r of E.store.db.prepare("SELECT id, namespace FROM memory_entries WHERE type = 'note' AND id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids))) live.add(`${r.namespace}|${r.id}`);
  } catch { return out; }
  for (const r of found) {
    const b = parseBody(r.body);
    if (!b || typeof b.note_id !== 'string' || !live.has(`project/${r.p}|${b.note_id}`) || !hidesNote(b)) continue;
    out.set(b.note_id, { kind: b.kind || null, ground: b.ground || null, reason: typeof b.reason === 'string' ? b.reason : null });
  }
  return out;
}

// The notes among the rows being read (`lim`/`lp`: the gate's bounds) that a hold withholds and that are live in their project. Closed on
// failure: a hold query that fails, or a project with a malformed hold no note of which can be named, withholds every note it covers.
function noteIds(E, lim = [], lp = [], held = heldWithheld(E)) {
  if (!held.size && !(held.closed && held.closed.size) && !held.failed) return [];
  const R = lim.length ? ` AND ${lim.join(' AND ')}` : '';
  const all = E.store.db.prepare(`SELECT e.id AS id, e.namespace AS ns FROM memory_entries e WHERE e.type = 'note'${held.failed ? '' : ' AND (e.id IN (SELECT value FROM json_each(?)) OR substr(e.namespace, 9) IN (SELECT value FROM json_each(?)))'}${R}`);
  const got = held.failed ? all.all(...lp) : all.all(JSON.stringify([...held.keys()]), JSON.stringify([...(held.closed || [])]), ...lp);
  return got.filter((r) => held.failed || r.ns === `project/${held.get(r.id)}` || (held.closed && held.closed.has(r.ns.slice(8)))).map((r) => r.id);
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
  const closed = (r) => held.failed || (held.closed.has(String(r.namespace).slice(8)) && String(r.namespace).startsWith('project/'));
  for (const r of notes) if (((held.has(r.id) && r.namespace === `project/${held.get(r.id)}`) || closed(r)) && !reviewerSees(E, caller, r)) out.add(r.id);
  return out;
}

module.exports = { WITHHOLD_FOR, MATCHING, HIDING_KINDS, judge, hidesNote, effectiveState, parseBody, withholds, withheldIds, withheldAmong, heldWithheld, holdsAmong, noteIds, unreadable };
