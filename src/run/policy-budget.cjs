'use strict';
// policy-budget.cjs — the budget rule for a policy step (ADR 0075 decision 1): a step that would spawn a worker or send a task to one is
// not taken while the spend the guard compares is at or above the soft threshold of the run's or the task's limit. The refusal is an
// exception the executor finishes the claim with, and policy-wakes.cjs derives it as E9. Nothing is paused or written here: the pause is the
// run's own budget guard (budget-guard.cjs), and this file only reads what that guard published on the run row's budget record.
//   - No limit anywhere (the default) means no guard: the run row is read, nothing else is. A step is never refused for a budget nobody set.
//   - Spend is reported (the usage ledger, plus the headless orchestrator's reported cost the record carries) and, when the run's record
//     says it counts the turns in flight (budget_counts_in_flight), the published in-flight estimate. Each part stays named in the refusal.
//   - `spendForGuard` is the one function that decides what the guard counts. ADR 0075 Q1 (the live estimate's scope) is open: a ruling
//     changes this function and nothing else.

const { SOFT_THRESHOLD } = require('../core/run-budget.cjs');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const usd = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
const recordOf = (run) => { let b = run && run.budget; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } } return b && typeof b === 'object' ? b : {}; };

// -> null when the run has no limit that applies, else { scope, task_id?, limit, soft, reported, in_flight, spent, over }.
// `readers.spend(taskId|null)` -> { usd } (the ledger's sum for the run, or for the task); only called when a limit applies.
async function spendForGuard(run, readers, taskId = null) {
  if (!run) return null;
  const rec = recordOf(run);
  const soft = num(rec.soft_threshold) > 0 ? num(rec.soft_threshold) : SOFT_THRESHOLD;
  const taskLimit = taskId && rec.tasks && num(rec.tasks[taskId]) > 0 ? num(rec.tasks[taskId]) : null;
  const overrides = rec.overrides || {};
  const out = [];
  if (num(run.budget_usd) > 0 && !overrides.run) {
    const reported = num((await readers.spend(null)).usd) + (rec.orchestrator && rec.orchestrator.counted === true ? num(rec.orchestrator.usd) : 0);
    const inFlight = rec.counts_in_flight === true ? num(rec.orchestrator && rec.orchestrator.in_flight_usd) + num(rec.in_flight_workers && rec.in_flight_workers.usd) : 0;
    const spent = reported + inFlight;
    out.push({ scope: 'run', limit: run.budget_usd, soft, reported, in_flight: inFlight, spent, over: spent >= soft * run.budget_usd });
  }
  if (taskLimit != null && !(Array.isArray(overrides.tasks) && overrides.tasks.includes(taskId))) {
    const reported = num((await readers.spend(taskId)).usd);
    out.push({ scope: 'task', task_id: taskId, limit: taskLimit, soft, reported, in_flight: 0, spent: reported, over: reported >= soft * taskLimit });
  }
  return out.find((f) => f.over) || out[0] || null;
}

// -> the refusal text for a step that sends work to a worker, or null. `E_BUDGET:` is what policy-wakes.cjs reads as E9.
async function refusal(run, readers, taskId = null) {
  const f = await spendForGuard(run, readers, taskId);
  if (!f || !f.over) return null;
  const where = f.scope === 'task' ? `task ${f.task_id}` : 'run';
  return `E_BUDGET: the ${where} budget is at its soft threshold (${usd(f.reported)} reported${f.in_flight > 0 ? ` + ${usd(f.in_flight)} in flight (estimate)` : ''} of ${usd(f.limit)}, threshold ${Math.round(f.soft * 100)}%); belay does not send a worker work past it. Raise the budget or act yourself`;
}

module.exports = { spendForGuard, refusal };
