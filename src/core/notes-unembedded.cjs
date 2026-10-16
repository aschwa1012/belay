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

// memory.retemplate, a read: { project, template: 'v2' } -> the project's embedded notes whose vector was made from another
// template, split into those that can be rebuilt (they carry a `when`) and those that cannot and so stay as they are.
async function retemplate(E, caller, args = {}) {
  if (args.template !== 'v2') throw require('./errors.cjs').err('E_ARGS', 'memory.retemplate template must be v2', { field: 'template' });
  const ns = `${PROJECT_PREFIX}${args.project}`;
  let rows = [];
  try { rows = E.store.p("SELECT id, title, body, text_template FROM memory_entries WHERE type = 'note' AND embedding IS NOT NULL AND namespace = ? ORDER BY created_at, id").all(ns); } catch { rows = []; }
  const out = { project: args.project, template: 'v2', total: rows.length, already: 0, eligible: [], stays: [] };
  for (const r of rows) {
    const from = r.text_template || 'v1';
    if (from === 'v2') { out.already++; continue; }
    let when = null;
    try { when = (JSON.parse(r.body) || {}).when; } catch { when = null; }
    if (typeof when === 'string' && when) out.eligible.push({ id: r.id, title: r.title, from });
    else out.stays.push({ id: r.id, title: r.title, from, reason: 'no_when' });
  }
  return out;
}

module.exports = { count, list, unembedded, retemplate };
