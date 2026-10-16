'use strict';
// restart-budget.cjs — ADR 0048. The time budget of one MCP `worker_restart`, which must answer inside MCP_TOOL_TIMEOUT.
// `within(promise)` resolves to EARLY at the budget (the promise carries on); `left()` is what remains of it.

const EARLY = Symbol('early');

function createBudget(budgetMs, now = Date.now) {
  const t0 = now();
  const budgeted = Number.isFinite(budgetMs);
  const left = () => budgetMs - (now() - t0);
  const within = (promise) => {
    if (!budgeted) return promise;
    let timer = null;
    const cut = new Promise((res) => { timer = setTimeout(() => res(EARLY), Math.max(1, left())); });
    return Promise.race([promise, cut]).finally(() => clearTimeout(timer));
  };
  return { budgeted, left, within, elapsed: () => now() - t0 };
}

module.exports = { EARLY, createBudget };
