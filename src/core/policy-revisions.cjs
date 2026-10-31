'use strict';
// policy-revisions.cjs -- a read for the policy exception wakes (ADR 0073): the plan revision each version of the run's tasks carried. Task rows are
// append-only and each version carries its `policy_rev`, so "the revision the exception's fact happened under" and "the newest revision" are both
// in the store, and the run's wake watcher, the policy executor and a restarted process all read the same answer (no state kept in memory).
//   policy.revisions { run_id? = caller's, limit? = 5000, max 20000 } -> { revisions: [{ id, seq, written_at, policy_rev }] } in seq order,
//   for every version of every task of the run that has a plan (a version with a null policy_rev is a task with no plan at that version and is left out).

const { err } = require('./errors.cjs');

const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 20000;

async function revisions(E, caller, args) {
  const a = args || {};
  for (const k of Object.keys(a)) if (!['run_id', 'limit', 'caller'].includes(k)) throw err('E_ARGS', `policy.revisions: ${k} is not an argument`, { field: k });
  if (a.run_id !== undefined && (typeof a.run_id !== 'string' || !a.run_id)) throw err('E_ARGS', 'policy.revisions run_id must be a non-empty string', { field: 'run_id' });
  if (a.limit !== undefined && (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > MAX_LIMIT)) throw err('E_ARGS', `policy.revisions limit must be 1 to ${MAX_LIMIT}`, { field: 'limit' });
  const run_id = a.run_id || caller.run_id;
  let list = [];
  try {
    list = E.store.p('SELECT id, seq, written_at, policy_rev FROM task WHERE policy_rev IS NOT NULL AND id IN (SELECT DISTINCT id FROM task WHERE run_id = ?) ORDER BY seq LIMIT ?').all(run_id, a.limit || DEFAULT_LIMIT)
      .map((r) => ({ id: r.id, seq: Number(r.seq), written_at: Number(r.written_at), policy_rev: Number(r.policy_rev) }));
  } catch (e) { if (!/no such (table|column)/i.test(e.message)) throw e; }
  return { revisions: list };
}

module.exports = { revisions };
