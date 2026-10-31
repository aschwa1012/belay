'use strict';
// policy-revisions.cjs -- a read for the policy exception wakes (ADR 0073): the versions of the run's tasks with the plan revision each carried. Task
// rows are append-only and each version carries its `policy_rev`, so "the plan the exception's fact happened under", "the newest plan" and "which fix
// was made last" are all in the store, and the run's wake watcher, the policy executor and a restarted process read the same answer (no memory kept).
//   policy.revisions { run_id? = caller's, task_ids? (up to 500), limit? = 5000, max 20000 }
//     -> { revisions: [{ id, seq, written_at, policy_rev, evaluated_at }], truncated }, in seq order.
// With `task_ids`: every version of exactly those tasks of the run (a version with no plan has a null policy_rev). Without: every version that has a
// plan. `evaluated_at` is the version's results.evaluated_at (null when it has none). `truncated: true` means the limit cut the answer off; the
// caller treats an incomplete history as no answer, never as "no amend".

const { err } = require('./errors.cjs');

const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 20000;
const MAX_IDS = 500;

async function revisions(E, caller, args) {
  const a = args || {};
  for (const k of Object.keys(a)) if (!['run_id', 'task_ids', 'limit', 'caller'].includes(k)) throw err('E_ARGS', `policy.revisions: ${k} is not an argument`, { field: k });
  if (a.run_id !== undefined && (typeof a.run_id !== 'string' || !a.run_id)) throw err('E_ARGS', 'policy.revisions run_id must be a non-empty string', { field: 'run_id' });
  if (a.limit !== undefined && (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > MAX_LIMIT)) throw err('E_ARGS', `policy.revisions limit must be 1 to ${MAX_LIMIT}`, { field: 'limit' });
  if (a.task_ids !== undefined && (!Array.isArray(a.task_ids) || a.task_ids.length > MAX_IDS || a.task_ids.some((t) => typeof t !== 'string' || !t))) throw err('E_ARGS', `policy.revisions task_ids must be up to ${MAX_IDS} task ids`, { field: 'task_ids' });
  const run_id = a.run_id || caller.run_id;
  const limit = a.limit || DEFAULT_LIMIT;
  const ids = a.task_ids;
  if (ids && !ids.length) return { revisions: [], truncated: false };
  let list = [];
  try {
    const own = 'id IN (SELECT DISTINCT id FROM task WHERE run_id = ?)';
    const where = ids ? `id IN (${ids.map(() => '?').join(',')}) AND ${own}` : `policy_rev IS NOT NULL AND ${own}`;
    list = E.store.p(`SELECT id, seq, written_at, policy_rev, CASE WHEN json_valid(results) THEN json_extract(results, '$.evaluated_at') END AS evaluated_at FROM task WHERE ${where} ORDER BY seq LIMIT ?`)
      .all(...(ids || []), run_id, limit + 1);
  } catch (e) { if (!/no such (table|column)/i.test(e.message)) throw e; }
  const truncated = list.length > limit;
  return {
    revisions: list.slice(0, limit).map((r) => ({ id: r.id, seq: Number(r.seq), written_at: Number(r.written_at), policy_rev: r.policy_rev == null ? null : Number(r.policy_rev), evaluated_at: r.evaluated_at == null ? null : Number(r.evaluated_at) })),
    truncated,
  };
}

module.exports = { revisions };
