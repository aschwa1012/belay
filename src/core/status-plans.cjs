'use strict';
// status-plans.cjs — the per-task plans `status.get` shows back to the user (ADR 0071 decision 5). One indexed read of the run's current task
// rows that carry a policy; a run with none adds no key, so a run without a plan reads as it did. Capped, with the count of what was left out.

const rows = require('./rows.cjs');
const PP = require('./policy-plan.cjs');

const MAX_PLANS = 30;

// { plans: [{ task_id, policy_rev, plan }], plans_more? } or {} when no task of the run has a plan.
function plansOf(E, runId) {
  if (!runId) return {};
  let list;
  try {
    list = E.store.p(`SELECT t.id, t.policy, t.policy_rev FROM task t JOIN (SELECT id, MAX(seq) AS m FROM task WHERE run_id = ? GROUP BY id) x ON t.seq = x.m
                      WHERE t.policy IS NOT NULL ORDER BY t.seq`).all(runId);
  } catch { return {}; } // a store from before the column
  if (!list.length) return {};
  const plans = list.slice(0, MAX_PLANS).map((r) => ({ task_id: r.id, policy_rev: r.policy_rev, plan: PP.tag(rows.parseRow('task', { policy: r.policy }).policy) }));
  return { plans, ...(list.length > MAX_PLANS ? { plans_more: list.length - MAX_PLANS } : {}) };
}

const lines = (receipt) => (receipt.plans || []).map((p) => `plan ${p.task_id}: ${p.plan || '(empty)'} (rev ${p.policy_rev})`)
  .concat(receipt.plans_more ? [`plan: ${receipt.plans_more} more task${receipt.plans_more === 1 ? '' : 's'} with a plan`] : []);

module.exports = { plansOf, lines, MAX_PLANS };
