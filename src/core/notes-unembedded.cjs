'use strict';
// notes-unembedded.cjs — the notes that have no vector, as a plain read of the rows. Under `on_embedder_failure: keyword`
// a hand-back stores its notes without one, and they stay that way until the operator runs `belay memory embed`: nothing
// else embeds them (not a run's warm-up, not a search, not a run start). This module only counts and lists; it imports
// nothing that can reach the embedder, so status and notices may read it (invariants 6 and 9).

const PROJECT_PREFIX = 'project/';

// { total, by_project: { <project>: n }, newest_at } over the notes of every project namespace that have no vector.
// A store whose table is absent (a copy that predates it) has none.
function count(store) {
  let rows;
  try {
    rows = store.p("SELECT namespace, COUNT(*) AS n, MAX(created_at) AS newest FROM memory_entries WHERE type = 'note' AND embedding IS NULL AND namespace LIKE 'project/%' GROUP BY namespace").all();
  } catch { rows = []; }
  const by_project = {};
  let total = 0, newest = null;
  for (const r of rows) {
    const n = Number(r.n);
    by_project[r.namespace.slice(PROJECT_PREFIX.length)] = n;
    total += n;
    if (r.newest != null && (newest === null || Number(r.newest) > newest)) newest = Number(r.newest);
  }
  return { total, by_project, newest_at: newest };
}

// The same notes one by one, oldest first, for one project or for all.
function list(store, project) {
  const ns = project ? `${PROJECT_PREFIX}${project}` : null;
  const sql = `SELECT id, namespace, title, status, created_at FROM memory_entries WHERE type = 'note' AND embedding IS NULL AND ${ns ? 'namespace = ?' : "namespace LIKE 'project/%'"} ORDER BY created_at, id`;
  const stmt = store.p(sql);
  return (ns ? stmt.all(ns) : stmt.all()).map(r => ({ id: r.id, project: r.namespace.slice(PROJECT_PREFIX.length), title: r.title, status: r.status || 'unverified', created_at: Number(r.created_at) }));
}

// memory.unembedded, a read: { project?, list? } -> count, and the notes themselves when asked for.
async function unembedded(E, caller, args = {}) {
  const c = count(E.store);
  const project = typeof args.project === 'string' && args.project ? args.project : null;
  const scoped = project ? { total: c.by_project[project] || 0, by_project: c.by_project[project] ? { [project]: c.by_project[project] } : {} } : c;
  return { ...scoped, ...(args.list ? { notes: list(E.store, project) } : {}) };
}

module.exports = { count, list, unembedded };
