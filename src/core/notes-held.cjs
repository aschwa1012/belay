'use strict';
// notes-held.cjs — the notes waiting on the Opus archive reviewer, as a plain read of the rows (every held kind: wrong, duplicate,
// superseded). A hold keeps the note live and visible with its warning; only the on-demand reviewer (`belay memory review`, the panel's button) archives it. This module only counts
// and lists, in the shape of notes-unembedded.cjs, and imports nothing that can reach the embedder, so status, notices and the panel may
// read it (invariants 6 and 9). Also the reports of "wrong" with no verdict applied, for the operator.

const HELD_PREFIX = 'held/';
const ENTRIES_MAX = 200;
// The same set count() counts: an active harness hold row whose note is still live in the project.
const ACTIVE = `h.type = 'held' AND h.namespace LIKE 'held/%' AND h.written_by = 'harness' AND json_extract(h.body, '$.state') = 'held'
  AND EXISTS (SELECT 1 FROM memory_entries n WHERE n.id = json_extract(h.body, '$.note_id') AND n.type = 'note' AND n.namespace = 'project/' || substr(h.namespace, 6))`;
// The JS twin of AWAITING below, for one held row's body: the archive reviewer answered undecided at the hold's current revision. memory.heldSettle's
// compare-and-set (`if_awaiting`) and the listing's awaiting_operator both use it.
// Both revisions must be integers (the SQL compares JSON values of one type): a string, a float, null or a missing mark never awaits, so this is never looser than AWAITING.
function isAwaiting(b) {
  if (!b || !b.undecided || typeof b.undecided !== 'object') return false;
  const rev = b.rev == null ? 0 : b.rev;
  return Number.isInteger(b.undecided.rev) && Number.isInteger(rev) && b.undecided.rev === rev;
}

const AWAITING = "(json_extract(h.body, '$.undecided.rev') IS NOT NULL AND json_extract(h.body, '$.undecided.rev') = COALESCE(json_extract(h.body, '$.rev'), 0))";
const parse = (t) => { try { return t ? JSON.parse(t) : {}; } catch { return {}; } };

// { total, unsupported, by_project: { <project>: n }, unsupported_by_project, oldest_age_runs, oldest_at, newest_at }. `total` counts every queued
// note; `unsupported` is the part of it that carries no warning (a note a reviewer could not prove or disprove). A hold counts while its row is `held` and its note is
// still live in the project. A store whose table is absent has none. `oldest_age_runs` is the most runs of one project that started
// after its oldest hold (what the review's `runs_waited` says).
function count(store) {
  let rows;
  try {
    rows = store.p(`SELECT h.namespace AS namespace, COUNT(*) AS n, SUM(CASE WHEN json_extract(h.body, '$.kind') = 'unsupported' THEN 1 ELSE 0 END) AS u, MIN(h.created_at) AS oldest, MAX(h.created_at) AS newest FROM memory_entries h
      WHERE h.type = 'held' AND h.namespace LIKE 'held/%' AND h.written_by = 'harness' AND json_extract(h.body, '$.state') = 'held'
      AND EXISTS (SELECT 1 FROM memory_entries n WHERE n.id = json_extract(h.body, '$.note_id') AND n.type = 'note' AND n.namespace = 'project/' || substr(h.namespace, 6))
      GROUP BY h.namespace`).all();
  } catch { rows = []; }
  const by_project = {}, age_by_project = {}, unsupported_by_project = {};
  let total = 0, unsupported = 0, oldest = null, newest = null, age = 0;
  for (const r of rows) {
    const project = r.namespace.slice(HELD_PREFIX.length);
    by_project[project] = Number(r.n);
    total += Number(r.n);
    if (Number(r.u) > 0) { unsupported_by_project[project] = Number(r.u); unsupported += Number(r.u); }
    if (r.oldest != null && (oldest === null || Number(r.oldest) < oldest)) oldest = Number(r.oldest);
    if (r.newest != null && (newest === null || Number(r.newest) > newest)) newest = Number(r.newest);
    age_by_project[project] = 0;
    try { age_by_project[project] = Number(store.p('SELECT COUNT(DISTINCT id) AS n FROM run WHERE project = ? AND COALESCE(started_at, written_at) > ?').get(project, r.oldest).n); } catch { /* no run table */ }
    age = Math.max(age, age_by_project[project]);
  }
  // By ground (a reported hold, a scrubber's duplicate, an unsupported row...) and how many wait on the operator (the archive reviewer answered undecided at their revision).
  const by_ground = {}, by_ground_by_project = {}, awaiting_by_project = {};
  let awaiting_operator = 0;
  try {
    for (const r of store.p(`SELECT substr(h.namespace, 6) AS p, COALESCE(json_extract(h.body, '$.ground'), 'none') AS g, COUNT(*) AS n, SUM(CASE WHEN ${AWAITING} THEN 1 ELSE 0 END) AS a FROM memory_entries h WHERE ${ACTIVE} GROUP BY h.namespace, g`).all()) {
      by_ground[r.g] = (by_ground[r.g] || 0) + Number(r.n);
      (by_ground_by_project[r.p] = by_ground_by_project[r.p] || {})[r.g] = Number(r.n);
      if (Number(r.a) > 0) { awaiting_operator += Number(r.a); awaiting_by_project[r.p] = (awaiting_by_project[r.p] || 0) + Number(r.a); }
    }
  } catch { /* no table */ }
  return { total, unsupported, by_project, unsupported_by_project, by_ground, by_ground_by_project, awaiting_operator, awaiting_by_project, age_by_project, oldest_age_runs: age, oldest_at: oldest, newest_at: newest };
}

// Runs whose reports hit the circuit breaker (ADR 0047 amendment, decision 9): an active reported hold with a report of the run that does not
// withhold. `disputed` is the distinct notes of the project the run's reports hold now. A read of the rows, newest first.
function breakers(store) {
  const by = new Map();
  try {
    for (const r of store.p(`SELECT substr(h.namespace, 6) AS p, h.created_at AS at, json_extract(h.body, '$.note_id') AS nid, json_extract(r.value, '$.run_id') AS run,
        json_extract(r.value, '$.withhold') AS w, json_extract(r.value, '$.breaker.limit') AS lim FROM memory_entries h, json_each(h.body, '$.reports') r
      WHERE ${ACTIVE} AND json_extract(h.body, '$.ground') = 'reported' AND json_extract(r.value, '$.run_id') IS NOT NULL AND json_extract(r.value, '$.by') <> 'operator'`).all()) {
      const k = `${r.p}|${r.run}`;
      const e = by.get(k) || { run_id: r.run, project: r.p, notes: new Set(), tripped: false, limit: null, at: 0 };
      e.notes.add(r.nid);
      if (r.w === 0) { e.tripped = true; e.at = Math.max(e.at, Number(r.at) || 0); if (r.lim != null) e.limit = Number(r.lim); }
      by.set(k, e);
    }
  } catch { return []; }
  return [...by.values()].filter((e) => e.tripped).sort((a, b) => b.at - a.at).map((e) => ({ run_id: e.run_id, project: e.project, disputed: e.notes.size, limit: e.limit, at: e.at }));
}

// One entry per active hold, oldest first, at most ENTRIES_MAX: what `belay memory held` lists. `projects` limits the projects read (null: every one); `awaiting`
// keeps the holds waiting on the operator. A read of the copy.
function entries(store, { projects = null, awaiting = false } = {}) {
  let rows;
  try {
    rows = store.p(`SELECT h.id AS held_row, h.namespace AS namespace, h.created_at AS marked_at, h.body AS body, n.title AS title FROM memory_entries h JOIN memory_entries n ON n.id = json_extract(h.body, '$.note_id') AND n.type = 'note'
      WHERE ${ACTIVE} ORDER BY h.created_at, h.id`).all();
  } catch { rows = []; }
  const out = [];
  for (const r of rows) {
    const project = r.namespace.slice(HELD_PREFIX.length);
    if (projects && !projects.includes(project)) continue;
    const b = parse(r.body);
    const rev = Number(b.rev) || 0;
    const waiting = isAwaiting(b);
    if (awaiting && !waiting) continue;
    let waited = 0;
    try { waited = Number(store.p('SELECT COUNT(DISTINCT id) AS n FROM run WHERE project = ? AND COALESCE(started_at, written_at) > ?').get(project, r.marked_at).n); } catch { /* no run table */ }
    out.push({
      project, note_id: b.note_id, title: r.title, held_row: r.held_row, rev, kind: b.kind, ground: b.ground || null, of: b.of || null,
      reports: Array.isArray(b.reports) ? b.reports.length : (b.report ? 1 : 0), reports_total: Number(b.reports_total) || (Array.isArray(b.reports) ? b.reports.length : (b.report ? 1 : 0)), self_report: !!b.self_report,
      undecided: b.undecided ? { reason: b.undecided.reason, at: b.undecided.at, receipt: b.undecided.receipt } : null, awaiting_operator: waiting, marked_at: r.marked_at, runs_waited: waited,
    });
  }
  return { truncated: out.length > ENTRIES_MAX, entries: out.slice(0, ENTRIES_MAX) };
}

// Reports of "wrong" with no verdict applied and no hold covering them (older data: a report now holds its note at once), every project.
function unjudged(store) {
  let projects;
  try { projects = store.p("SELECT DISTINCT substr(namespace, 9) AS p FROM memory_entries WHERE type = 'note' AND namespace LIKE 'project/%' AND body LIKE '%reported_wrong%'").all().map((r) => r.p); } catch { return []; }
  if (!projects.length) return []; // the report code is loaded only when some note carries a report
  const RV = require('./note-report-verdicts.cjs');
  return projects.flatMap((p) => RV.unjudgedReports({ store }, p).map((r) => ({ project: p, ...r })));
}

// Work the default propose mode leaves for the operator: open proposals whose mark is still unsettled, and pending notes whose writer's run
// has ended (nothing but a scrub or `belay memory resolve` settles them). Nothing closes a proposal row, so the mark is read against the notes:
// a `resolve` counts while its note is still pending; a `relate` while both notes pass the relation's liveness gate (live, not refuted, not
// superseded, not held) and neither records a `new` verdict on the other that still matches both notes' keys (memory-relate.cjs judgedPair); a `draft` while the note's newest nomination is still open, the draft is
// not older than it and the note is not promoted; any other action while its note is live or pending. A plain read of the rows.
// { open_proposals, pending, total, by_project: { <project>: n }, note_ids, newest_at }; `total` and `by_project` count distinct notes.
function stranded(store, only = null) {
  const by_project = {}, ids = new Set();
  let open_proposals = 0, pending = 0, newest = null;
  const add = (project, id, at) => {
    if (only && project !== only) return false;
    if (at != null && (newest === null || Number(at) > newest)) newest = Number(at);
    if (!ids.has(id)) { ids.add(id); by_project[project] = (by_project[project] || 0) + 1; }
    return true;
  };
  try {
    const { fresh } = require('./proposal-open.cjs');
    const { judgedPair } = require('./memory-relate.cjs');
    const { loadNote } = require('./memory-facts.cjs');
    const note = (id) => { const r = loadNote({ store }, id); return r && r.type === 'note' ? r : null; };
    const bodyOf = (n) => { try { return JSON.parse(n.body) || {}; } catch { return {}; } };
    // Gate (b) of the relation (memory-relate.cjs liveNote): live in the project, not refuted, not superseded by another row, not held.
    const relatable = (id, n, live) => !!n && n.namespace === live && (n.status || 'unverified') !== 'refuted' && !bodyOf(n).held
      && !store.p('SELECT 1 AS x FROM memory_entries WHERE supersedes = ? AND namespace = ?').get(id, live);
    // A draft waits on the operator while the note's newest nomination is still open (no later decision) and the proposal is not older than it;
    // a promoted note, a rejected or promoted nomination, or a draft made for an earlier nomination leaves nothing to decide.
    const draftOpen = (project, n, id, at) => {
      if (n.namespace !== `project/${project}` || bodyOf(n).promoted_to) return false;
      const nom = store.p("SELECT created_at, json_extract(body, '$.state') AS state FROM memory_entries WHERE type = 'nomination' AND namespace = ? AND json_extract(body, '$.note_id') = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(`nomination/${project}`, id);
      return !!nom && nom.state === 'nominated' && Number(at) >= Number(nom.created_at);
    };
    for (const r of store.p(`SELECT namespace, created_at AS at, json_extract(body, '$.note_id') AS note_id, json_extract(body, '$.entry.action') AS action, json_extract(body, '$.entry.of') AS other, body
      FROM memory_entries WHERE type = 'proposal' AND namespace LIKE 'proposal/%' AND json_extract(body, '$.state') = 'open' ORDER BY created_at, id`).all()) {
      const project = r.namespace.slice(9), live = `project/${project}`, pend = `pending/${project}`;
      const n = note(r.note_id);
      if (!n) continue;
      if (!fresh({ store }, bodyOf(r))) continue; // the same freshness rule as proposal-open.cjs: complete stored keys, all still matching
      let open;
      if (r.action === 'resolve') open = n.namespace === pend;
      else if (r.action === 'relate') {
        const o = r.other ? note(r.other) : null;
        open = relatable(r.note_id, n, live) && !!o && relatable(r.other, o, live) && !judgedPair(n, o) && !judgedPair(o, n);
      } else if (r.action === 'draft') open = draftOpen(project, n, r.note_id, r.at);
      else open = n.namespace === live || n.namespace === pend;
      if (open && add(project, r.note_id, r.at)) open_proposals += 1;
    }
  } catch { /* no table */ }
  try {
    for (const r of store.p(`SELECT id, namespace, created_at FROM memory_entries WHERE type = 'note' AND namespace LIKE 'pending/%'
      AND (run_id IS NULL OR run_id NOT IN (SELECT r.id FROM run r WHERE r.ended_at IS NULL AND r.seq = (SELECT MAX(seq) FROM run WHERE id = r.id))) ORDER BY created_at, id`).all()) {
      if (add(r.namespace.slice(8), r.id, r.created_at)) pending += 1;
    }
  } catch { /* no run table */ }
  return { open_proposals, pending, total: ids.size, by_project, note_ids: [...ids].slice(0, 20), newest_at: newest };
}

// memory.held, a read: { project?, reports?, reviews? } -> the count, and the unjudged reports when asked for.
async function held(E, caller, args = {}) {
  const c = count(E.store);
  const project = typeof args.project === 'string' && args.project ? args.project : null;
  // The listing: a run's caller sees its own project (another is E_ROLE); the operator sees the named project, or every project.
  let listing = null;
  if (args.list) {
    const { err } = require('./errors.cjs');
    let projects = project ? [project] : null;
    if (caller.role !== 'operator') {
      const mine = require('./methods-memory.cjs').projectOf(E, caller);
      if (project && project !== mine) throw err('E_ROLE', `the held listing of project ${project} is not this run's (${mine || 'no project'})`, { role: caller.role, project });
      projects = mine ? [mine] : [];
    }
    listing = entries(E.store, { projects, awaiting: !!args.awaiting });
  }
  const scoped = project ? { awaiting_operator: c.awaiting_by_project[project] || 0, by_ground: c.by_ground_by_project[project] || {}, total: c.by_project[project] || 0, unsupported: c.unsupported_by_project[project] || 0, unsupported_by_project: c.unsupported_by_project[project] ? { [project]: c.unsupported_by_project[project] } : {}, by_project: c.by_project[project] ? { [project]: c.by_project[project] } : {}, oldest_age_runs: c.age_by_project[project] || 0, oldest_at: c.oldest_at, newest_at: c.newest_at } : c;
  // One call (one copy of the store) answers notices: the counts, the unjudged reports and the archive reviews' claims.
  const reviews = args.reviews ? (await require('./review-claim.cjs').reviewState(E, caller, project ? { project } : {})).reviews : undefined;
  return { ...scoped, ...(listing ? listing : {}), ...(reviews ? { reviews } : {}), ...(args.reports ? { breakers: breakers(E.store).filter((b) => !project || b.project === project), unjudged_reports: unjudged(E.store).filter((r) => !project || r.project === project), stranded: stranded(E.store, project) } : {}) };
}

module.exports = { count, breakers, entries, unjudged, stranded, held, isAwaiting, AWAITING };
