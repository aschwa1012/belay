'use strict';
// notes-held.cjs — the notes waiting on the Opus archive reviewer, as a plain read of the rows. A `wrong` hold keeps the note live and
// visible with its warning; only the on-demand reviewer (`belay memory review`, the panel's button) archives it. This module only counts
// and lists, in the shape of notes-unembedded.cjs, and imports nothing that can reach the embedder, so status, notices and the panel may
// read it (invariants 6 and 9). Also the reports of "wrong" no review will judge, for the operator.

const HELD_PREFIX = 'held/';

// { total, by_project: { <project>: n }, oldest_age_runs, oldest_at, newest_at }. A hold counts while its row is `held` and its note is
// still live in the project. A store whose table is absent has none. `oldest_age_runs` is the most runs of one project that started
// after its oldest hold (what the review's `runs_waited` says).
function count(store) {
  let rows;
  try {
    rows = store.p(`SELECT h.namespace AS namespace, COUNT(*) AS n, MIN(h.created_at) AS oldest, MAX(h.created_at) AS newest FROM memory_entries h
      WHERE h.type = 'held' AND h.namespace LIKE 'held/%' AND h.written_by = 'harness' AND json_extract(h.body, '$.state') = 'held' AND json_extract(h.body, '$.kind') = 'wrong'
      AND EXISTS (SELECT 1 FROM memory_entries n WHERE n.id = json_extract(h.body, '$.note_id') AND n.type = 'note' AND n.namespace = 'project/' || substr(h.namespace, 6))
      GROUP BY h.namespace`).all();
  } catch { rows = []; }
  const by_project = {}, age_by_project = {};
  let total = 0, oldest = null, newest = null, age = 0;
  for (const r of rows) {
    const project = r.namespace.slice(HELD_PREFIX.length);
    by_project[project] = Number(r.n);
    total += Number(r.n);
    if (r.oldest != null && (oldest === null || Number(r.oldest) < oldest)) oldest = Number(r.oldest);
    if (r.newest != null && (newest === null || Number(r.newest) > newest)) newest = Number(r.newest);
    age_by_project[project] = 0;
    try { age_by_project[project] = Number(store.p('SELECT COUNT(DISTINCT id) AS n FROM run WHERE project = ? AND COALESCE(started_at, written_at) > ?').get(project, r.oldest).n); } catch { /* no run table */ }
    age = Math.max(age, age_by_project[project]);
  }
  return { total, by_project, age_by_project, oldest_age_runs: age, oldest_at: oldest, newest_at: newest };
}

// Reports of "wrong" that no review will judge (the reporter's task ended with no reviewer and no review job), every project.
function unjudged(store) {
  let projects;
  try { projects = store.p("SELECT DISTINCT substr(namespace, 9) AS p FROM memory_entries WHERE type = 'note' AND namespace LIKE 'project/%' AND body LIKE '%reported_wrong%'").all().map((r) => r.p); } catch { return []; }
  const RV = require('./note-report-verdicts.cjs');
  return projects.flatMap((p) => RV.unjudgedReports({ store }, p).map((r) => ({ project: p, ...r })));
}

// memory.held, a read: { project?, list? } -> the count, and the unjudged reports when asked for.
async function held(E, caller, args = {}) {
  const c = count(E.store);
  const project = typeof args.project === 'string' && args.project ? args.project : null;
  const scoped = project ? { total: c.by_project[project] || 0, by_project: c.by_project[project] ? { [project]: c.by_project[project] } : {}, oldest_age_runs: c.age_by_project[project] || 0, oldest_at: c.oldest_at, newest_at: c.newest_at } : c;
  return { ...scoped, ...(args.reports ? { unjudged_reports: unjudged(E.store).filter((r) => !project || r.project === project) } : {}) };
}

module.exports = { count, unjudged, held };
