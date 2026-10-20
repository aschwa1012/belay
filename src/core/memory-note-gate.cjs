'use strict';
// memory-note-gate.cjs — the two-clock gate: which notes a caller may see in memory.index, memory.search, memory.list and
// memory.timeline. One filter for all four, so a note is visible on one route exactly when it is visible on the others. A read
// module: every statement is a SELECT over the store's own rows (note row, task row, lease rows, run row) and no model is called.
//
// A note is visible to a caller when it is LIVE, and either the caller's own run wrote it or its writer has ENDED:
//   live        - the row is a note not refuted, not promoted (`promoted_to` set), not still `state: pending`, and (unless the
//                 caller asked for them) not superseded by another row. A held note (`body.held`) stays in project/<p> and stays
//                 visible; its warning line is the index's.
//   own run     - `run_id` equals the caller's: visible at once, before its task ends (live is still required).
//   ended       - for another run: the writer can no longer retract the note, which is any one of
//                   (1) the note's task is `done`,
//                   (2) the lease the note was written under was released BY THE WRITER'S HAND-BACK: of the writer's leases on that
//                       task, the latest one granted at or before the note's time has a released row written by the writer itself.
//                       A lease taken over by the operator (take-control) is released by the operator, not handed back; and a lease
//                       the writer was granted again after an earlier hand-back is a new lease, still open,
//                   (3) the note's run row is closed (`ended_at` set),
//                   (4) the note has no run, or its run has no row: nothing in the store says its writer is still working.
// `unverified` and `verified` are both visible; a pending or absent review hides nothing. "The scrubber passed it" is no clause.
//
// The lifecycle namespaces (archive/, held/, pending/, proposal/, draft/, nomination/) are not read through the gate at all: a gated
// caller on the tool channel that NAMES one on memory.index, memory.search, memory.list or memory.timeline is refused E_ROLE
// (checkNamespaces, called from checkReach in memory-reach.cjs). The harness channel and the operator keep their access, because the
// stages read them.
//
// Only rows of type `note` are filtered. The operator (the CLI) is not gated: it is the window onto every row. A worker or the
// orchestrator is. memory.get and memory.retrieve by explicit id are NOT filtered by the two-clock clauses (they return the row with its status), but a lifecycle namespace answers not found there too.
//
// How it is evaluated. A row of the store is large (it carries its vector), and run_id and body sit after the vector, so a
// per-row predicate costs a scan of the namespace (about 30 ms at 10,000 rows, three times in one search). The hidden notes are a
// small minority, so the gate finds THEM instead, by index, for the rows being read only (the namespaces, an id list or a scope
// column of the call, so the list is bounded by what is read): refuted notes by status, notes of an OPEN run (not the caller's)
// whose task is not done and whose writer has not handed the lease back, by run id, superseded notes, and one scan of the
// namespace for the body clauses (a promoted note, a pending state). The result is a list of hidden ids that a statement excludes
// with one json_each parameter. bodyLive is the same body test in JS.

const { err } = require('./errors.cjs');

const LIFECYCLE_NS = ['archive/', 'held/', 'pending/', 'proposal/', 'draft/', 'nomination/'];
const SCOPE_COLS = ['namespace', 'task_id', 'worker_id', 'run_id'];

const gated = (caller) => !!caller && (caller.role === 'worker' || caller.role === 'orchestrator');

const OPEN_RUNS = 'SELECT r.id FROM run r WHERE r.ended_at IS NULL AND r.seq = (SELECT MAX(seq) FROM run WHERE id = r.id)';

// Refuses (E_ROLE, nothing read) a gated caller on the tool channel naming a lifecycle namespace. A caller with channel 'harness' and
// the operator are not refused.
function checkNamespaces(caller, namespaces) {
  if (!gated(caller) || caller.channel === 'harness') return;
  for (const ns of namespaces) {
    if (LIFECYCLE_NS.some((p) => String(ns).startsWith(p))) {
      throw err('E_ROLE', `a ${caller.role} may not read ${ns}: the lifecycle namespaces (${LIFECYCLE_NS.join(', ')}) are read by the harness and the operator only`, { namespace: ns, role: caller.role });
    }
  }
}

// Whether `ns` is a lifecycle namespace the caller may not read (a gated tool-channel caller); a read by explicit id uses it to answer "not found".
function inLifecycle(caller, ns) {
  return gated(caller) && caller.channel !== 'harness' && LIFECYCLE_NS.some((p) => String(ns).startsWith(p));
}

// SQL that leaves out the lifecycle namespaces for a gated tool-channel caller (a read that names no namespace, as a timeline by task
// or run does); null when the caller may read them.
function lifecycleSql(caller, alias = 'e') {
  if (!gated(caller) || caller.channel === 'harness') return null;
  return LIFECYCLE_NS.map((p) => `substr(${alias}.namespace, 1, ${p.length}) <> '${p}'`).join(' AND ');
}

// The body clauses in SQL: not promoted, not state pending. A body that is not valid JSON passes (as bodyLive does).
function bodySql(alias = 'e') {
  const e = `${alias}.`;
  return `(${e}type <> 'note' OR ${e}body IS NULL OR (instr(${e}body, 'promoted_to') = 0 AND instr(${e}body, 'pending') = 0) OR CASE WHEN json_valid(${e}body) THEN (json_extract(${e}body, '$.promoted_to') IS NULL AND COALESCE(json_extract(${e}body, '$.state'), 'live') <> 'pending') ELSE 1 END)`;
}

// The body clauses in JS: a row ({ type, body } with the body as JSON text), a parsed body or the body's JSON text that is not a
// promoted note and not state pending. A body that is not valid JSON passes.
function bodyLive(x) {
  let b = x;
  if (x && typeof x === 'object' && 'type' in x && 'body' in x) { if (x.type !== 'note') return true; b = x.body; }
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { return true; } }
  if (!b || typeof b !== 'object') return true;
  return b.promoted_to == null && b.state !== 'pending';
}

// The ids of the notes the gate hides from `caller` among the rows being read: refuted, not yet ended (another run's, still open),
// superseded unless `includeSuperseded`, and (with `body`) promoted or state pending. The rows being read: `namespaces`, `ids`
// (a single-row check) and `scope` ({ col, val }); with none of them, the whole store.
function hiddenIds(E, caller, { includeSuperseded = false, body = false, ids = null, namespaces = null, scope = null } = {}) {
  if (!gated(caller)) return [];
  const db = E.store.db;
  // The cheap queries below are driven by the status, run and supersedes indexes. The namespace test on them is written +e.namespace so
  // the planner keeps that index (with a plain test it walks the namespace and reads every large row: 60 ms at 10,000 rows, not 0.1).
  const lim = [], lp = [];
  if (ids) { lim.push('e.id IN (SELECT value FROM json_each(?))'); lp.push(JSON.stringify(ids)); }
  if (namespaces) { lim.push('+e.namespace IN (SELECT value FROM json_each(?))'); lp.push(JSON.stringify(namespaces)); }
  if (scope) {
    if (!SCOPE_COLS.includes(scope.col)) throw new Error(`scope.col must be one of ${SCOPE_COLS.join(', ')}`);
    lim.push(`e.${scope.col} = ?`); lp.push(scope.val);
  }
  const R = lim.length ? ` AND ${lim.join(' AND ')}` : '';
  const Rbody = R.replace('+e.namespace', 'e.namespace'); // the body scan walks the namespace on purpose
  const out = new Set();
  for (const r of db.prepare(`SELECT e.id FROM memory_entries e WHERE e.type = 'note' AND e.status = 'refuted'${R}`).all(...lp)) out.add(r.id);
  const own = caller.run_id == null ? '' : caller.run_id;
  for (const r of db.prepare(`SELECT e.id FROM memory_entries e WHERE e.type = 'note' AND e.run_id IN (${OPEN_RUNS}) AND e.run_id <> ?${R}
      AND NOT EXISTS (SELECT 1 FROM task t WHERE t.id = e.task_id AND t.state = 'done' AND t.seq = (SELECT MAX(seq) FROM task WHERE id = t.id))
      AND NOT EXISTS (SELECT 1 FROM lease l WHERE l.task_id = e.task_id AND l.holder = e.worker_id AND l.released_at IS NOT NULL AND l.written_by = l.holder
        AND l.id = (SELECT l2.id FROM lease l2 WHERE l2.task_id = e.task_id AND l2.holder = e.worker_id AND l2.granted_at <= e.created_at ORDER BY l2.granted_at DESC, l2.seq DESC LIMIT 1))`).all(own, ...lp)) out.add(r.id);
  if (!includeSuperseded) {
    for (const r of db.prepare(`SELECT e.id FROM memory_entries e WHERE e.type = 'note' AND EXISTS (SELECT 1 FROM memory_entries s WHERE s.supersedes = e.id AND +s.namespace = e.namespace)${R}`).all(...lp)) out.add(r.id);
  }
  if (body) {
    for (const r of db.prepare(`SELECT e.id FROM memory_entries e WHERE e.type = 'note'${Rbody} AND NOT ${bodySql('e')}`).all(...lp)) out.add(r.id);
  }
  return [...out];
}

// { where, params } over the alias (default e), or null when the caller is not gated. The where excludes the hidden notes (see
// hiddenIds for the options); the body clauses are included only when asked (body: true).
function sql(E, caller, { alias = 'e', ...opts } = {}) {
  if (!gated(caller)) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('alias must be a plain SQL identifier');
  return { where: `(${alias}.type <> 'note' OR ${alias}.id NOT IN (SELECT value FROM json_each(?)))`, params: [JSON.stringify(hiddenIds(E, caller, opts))] };
}

// The gate joined to an existing filter ({ where, params }, where may be empty), body clauses included.
function and(filter, E, caller, opts) {
  const g = sql(E, caller, { body: true, ...opts });
  if (!g) return filter;
  return { where: [filter.where, g.where].filter(Boolean).join(' AND '), params: [...filter.params, ...g.params] };
}

// Whether the gate lets `caller` see row `id` (a row that is not a note, or a caller that is not gated, is visible).
function visible(E, caller, id, opts) {
  if (!gated(caller)) return true;
  return hiddenIds(E, caller, { ...opts, ids: [id], body: true }).length === 0;
}

module.exports = { checkNamespaces, inLifecycle, lifecycleSql, LIFECYCLE_NS, hiddenIds, sql, and, bodySql, bodyLive, visible, gated };
