'use strict';
// memory-note-gate.cjs — the two-clock gate: which notes a caller may see in memory.index, memory.search and memory.list.
// One filter for all three, so a note is visible on one route exactly when it is visible on the others. A read module:
// every statement is a SELECT over the store's own rows (note row, task row, lease rows, run row) and no model is called.
//
// A note is visible to a caller when it is LIVE, and either the caller's own run wrote it or its writer has ENDED:
//   live        - the row is a note not refuted, not promoted (`promoted_to` set), not still `state: pending`, and (unless the
//                 caller asked for them) not superseded by another row. A held note (`body.held`) stays in project/<p> and stays
//                 visible; its warning line is the index's.
//   own run     - `run_id` equals the caller's: visible at once, before its task ends (live is still required).
//   ended       - for another run: the writer can no longer retract the note, which is any one of
//                   (1) the note's task is `done`,
//                   (2) the writer's lease on that task is released (hand-back), a failed acceptance included,
//                   (3) the note's run row is closed (`ended_at` set),
//                   (4) the note has no run, or its run has no row: nothing in the store says its writer is still working.
// The lifecycle namespaces (archive/, held/, pending/, proposal/, draft/, nomination/) are not read through the gate at all: a gated
// caller on the tool channel that NAMES one on memory.index, memory.search or memory.list is refused E_ROLE (checkNamespaces, called
// from checkReach in memory-reach.cjs). The harness channel and the operator keep their access, because the stages read them.
// `unverified` and `verified` are both visible; a pending or absent review hides nothing. "The scrubber passed it" is no clause.
//
// Only rows of type `note` are filtered. The operator (the CLI) is not gated: it is the window onto every row. A worker or the
// orchestrator is. memory.get and memory.retrieve by explicit id are NOT filtered (they return the row with its status).
//
// How it is evaluated. A row of the store is large (it carries its vector), and run_id and body sit after the vector, so a
// per-row predicate costs a scan of the namespace (about 30 ms at 10,000 rows, three times in one search). The hidden notes are a
// small minority, so the gate finds THEM instead, by index: refuted notes by status, and notes of an OPEN run (not the caller's)
// whose task is not done and whose writer has not released the lease, by run id. The result is a list of hidden ids that a
// statement excludes with one json_each parameter. The two clauses that read the body (a promoted note, a pending state) are a JS
// test, bodyLive, on the rows a route already fetched; the list route, which fetches no body, puts the same test in SQL (bodySql).

const { err } = require('./errors.cjs');

const LIFECYCLE_NS = ['archive/', 'held/', 'pending/', 'proposal/', 'draft/', 'nomination/'];

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

// The ids of the notes the gate hides from `caller`: refuted, not yet ended (another run's, still open), and superseded unless
// `includeSuperseded`. `ids`, when given, restricts the answer to those ids (a single-row check).
function hiddenIds(E, caller, { includeSuperseded = false, ids = null } = {}) {
  if (!gated(caller)) return [];
  const db = E.store.db;
  const only = ids ? ' AND e.id IN (SELECT value FROM json_each(?))' : '';
  const oparam = ids ? [JSON.stringify(ids)] : [];
  const out = new Set();
  for (const r of db.prepare(`SELECT e.id FROM memory_entries e WHERE e.type = 'note' AND e.status = 'refuted'${only}`).all(...oparam)) out.add(r.id);
  const own = caller.run_id == null ? '' : caller.run_id;
  for (const r of db.prepare(`SELECT e.id FROM memory_entries e WHERE e.type = 'note' AND e.run_id IN (${OPEN_RUNS}) AND e.run_id <> ?${only}
      AND NOT EXISTS (SELECT 1 FROM task t WHERE t.id = e.task_id AND t.state = 'done' AND t.seq = (SELECT MAX(seq) FROM task WHERE id = t.id))
      AND NOT EXISTS (SELECT 1 FROM lease l WHERE l.task_id = e.task_id AND l.holder = e.worker_id AND l.released_at IS NOT NULL)`).all(own, ...oparam)) out.add(r.id);
  if (!includeSuperseded) {
    for (const r of db.prepare(`SELECT e.id FROM memory_entries e WHERE e.type = 'note' AND EXISTS (SELECT 1 FROM memory_entries s WHERE s.supersedes = e.id AND +s.namespace = e.namespace)${only}`).all(...oparam)) out.add(r.id);
  }
  return [...out];
}

// { where, params } over the alias (default e), or null when the caller is not gated. The where excludes the hidden notes; it does
// not test the body (see bodyLive and bodySql).
function sql(E, caller, { alias = 'e', ...opts } = {}) {
  if (!gated(caller)) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('alias must be a plain SQL identifier');
  return { where: `(${alias}.type <> 'note' OR ${alias}.id NOT IN (SELECT value FROM json_each(?)))`, params: [JSON.stringify(hiddenIds(E, caller, opts))] };
}

// The body clauses in SQL, for a route that fetches no body: not promoted, not state pending.
function bodySql(alias = 'e') {
  const e = `${alias}.`;
  return `(${e}type <> 'note' OR ${e}body IS NULL OR (instr(${e}body, 'promoted_to') = 0 AND instr(${e}body, 'pending') = 0) OR (json_valid(${e}body) AND json_extract(${e}body, '$.promoted_to') IS NULL AND COALESCE(json_extract(${e}body, '$.state'), 'live') <> 'pending'))`;
}

// The body clauses in JS: a row ({ type, body } with the body as JSON text), a parsed body or the body's JSON text that is not a
// promoted note and not state pending.
function bodyLive(x) {
  let b = x;
  if (x && typeof x === 'object' && 'type' in x && 'body' in x) { if (x.type !== 'note') return true; b = x.body; }
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { return true; } }
  if (!b || typeof b !== 'object') return true;
  return b.promoted_to == null && b.state !== 'pending';
}

// The gate joined to an existing filter ({ where, params }, where may be empty). Used by memory.list, which fetches no body, so
// the body clauses join the same where.
function and(filter, E, caller, opts) {
  const g = sql(E, caller, opts);
  if (!g) return filter;
  return { where: [filter.where, g.where, bodySql(opts && opts.alias)].filter(Boolean).join(' AND '), params: [...filter.params, ...g.params] };
}

// Whether the gate lets `caller` see row `id` (a row that is not a note, or a caller that is not gated, is visible).
function visible(E, caller, id, opts) {
  if (!gated(caller)) return true;
  if (hiddenIds(E, caller, { ...opts, ids: [id] }).length) return false;
  const row = E.store.db.prepare('SELECT type, body FROM memory_entries WHERE id = ?').get(id);
  return !row || bodyLive(row);
}

module.exports = { checkNamespaces, LIFECYCLE_NS, hiddenIds, sql, and, bodySql, bodyLive, visible, gated };
