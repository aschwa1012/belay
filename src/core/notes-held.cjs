'use strict';
// notes-held.cjs — the notes waiting on the Opus archive reviewer, as a plain read of the rows (every held kind: wrong, duplicate,
// superseded). A hold keeps the note live and visible with its warning; only the on-demand reviewer (`belay memory review`, the panel's button) archives it. This module only counts
// and lists, in the shape of notes-unembedded.cjs, and imports nothing that can reach the embedder, so status, notices and the panel may
// read it (invariants 6 and 9). Also the reports of "wrong" with no verdict applied, for the operator.

const HELD_PREFIX = 'held/';

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
  return { total, unsupported, by_project, unsupported_by_project, age_by_project, oldest_age_runs: age, oldest_at: oldest, newest_at: newest };
}

// Reports of "wrong" with no verdict applied (a review or job may have run and left the report out), every project, and the
// upheld ones the Haiku job could only recommend because a review verified the note (`recommended: true`).
function unjudged(store) {
  let projects;
  try { projects = store.p("SELECT DISTINCT substr(namespace, 9) AS p FROM memory_entries WHERE type = 'note' AND namespace LIKE 'project/%' AND body LIKE '%reported_wrong%'").all().map((r) => r.p); } catch { return []; }
  if (!projects.length) return []; // the report code is loaded only when some note carries a report
  const RV = require('./note-report-verdicts.cjs');
  return projects.flatMap((p) => [...RV.unjudgedReports({ store }, p), ...RV.recommendedReports({ store }, p)].map((r) => ({ project: p, ...r })));
}

// Work the default propose mode leaves for the operator: open proposals whose mark is still unsettled, and pending notes whose writer's run
// has ended (nothing but a scrub or `belay memory resolve` settles them). Nothing closes a proposal row, so the mark is read against the notes:
// a `resolve` counts while its note is still pending; a `relate` while both notes pass the relation's liveness gate (live, not refuted, not
// superseded, not held) and neither records a `new` verdict on the other; a `draft` while the note's newest nomination is still open, the draft is
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
    const note = (id) => store.p("SELECT namespace, status, body FROM memory_entries WHERE id = ? AND type = 'note'").get(id);
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
    const judges = (n, other) => { try { return (JSON.parse(n.body).pair_judged || []).some((j) => j && j.of === other); } catch { return false; } };
    for (const r of store.p(`SELECT namespace, created_at AS at, json_extract(body, '$.note_id') AS note_id, json_extract(body, '$.entry.action') AS action, json_extract(body, '$.entry.of') AS other
      FROM memory_entries WHERE type = 'proposal' AND namespace LIKE 'proposal/%' AND json_extract(body, '$.state') = 'open' ORDER BY created_at, id`).all()) {
      const project = r.namespace.slice(9), live = `project/${project}`, pend = `pending/${project}`;
      const n = note(r.note_id);
      if (!n) continue;
      let open;
      if (r.action === 'resolve') open = n.namespace === pend;
      else if (r.action === 'relate') {
        const o = r.other ? note(r.other) : null;
        open = relatable(r.note_id, n, live) && !!o && relatable(r.other, o, live) && !judges(n, r.other) && !judges(o, r.note_id);
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
  const scoped = project ? { total: c.by_project[project] || 0, unsupported: c.unsupported_by_project[project] || 0, unsupported_by_project: c.unsupported_by_project[project] ? { [project]: c.unsupported_by_project[project] } : {}, by_project: c.by_project[project] ? { [project]: c.by_project[project] } : {}, oldest_age_runs: c.age_by_project[project] || 0, oldest_at: c.oldest_at, newest_at: c.newest_at } : c;
  // One call (one copy of the store) answers notices: the counts, the unjudged reports and the archive reviews' claims.
  const reviews = args.reviews ? (await require('./review-claim.cjs').reviewState(E, caller, project ? { project } : {})).reviews : undefined;
  return { ...scoped, ...(reviews ? { reviews } : {}), ...(args.reports ? { unjudged_reports: unjudged(E.store).filter((r) => !project || r.project === project), stranded: stranded(E.store, project) } : {}) };
}

module.exports = { count, unjudged, stranded, held };
