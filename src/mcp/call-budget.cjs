'use strict';
// call-budget.cjs — a tool call that can run longer than the client's tool timeout (MCP_TOOL_TIMEOUT) answers early.
// `integrate` and `task_evaluate` re-run acceptance commands inside the owner and may also queue behind
// max_parallel_evaluations; past the client's limit the client gives up while the owner carries on, and the orchestrator
// is left not knowing. The work is not cancelled: the call answers `still_running` and the result is in the store.

const MARGIN_MS = 10000; // the same margin worker_wait keeps under the client's limit (ADR 0029 decision 5)
const LONG_TOOLS = new Set(['integrate', 'task_evaluate']);

function clientLimitMs(env = process.env) {
  const raw = String(env.MCP_TOOL_TIMEOUT || '').trim();
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : 0;
}

const budgetFor = (name, env = process.env) => {
  const lim = clientLimitMs(env);
  return LONG_TOOLS.has(name) && lim > 0 ? Math.max(1000, lim - MARGIN_MS) : null;
};

function receipt(name, args, ms) {
  const where = name === 'integrate'
    ? 'read the result with task_list (each task\'s integration) or the integration rows'
    : `read the result with task_list { task_ids: [${JSON.stringify((args && args.task_id) || '')}] }`;
  return {
    state: 'still_running', tool: name, waited_ms: ms,
    note: `${name} is still running after ${Math.round(ms / 1000)} s, inside the owner; it is not cancelled and writes its result when it ends. ${where}. Do not call ${name} again while it runs. If it was queued behind max_parallel_evaluations and the queue's bound passes, it is refused with nothing written and the task shows no result`,
  };
}

// -> the call's result, or the receipt when the budget passes first (the call carries on; a later failure is dropped here
// because its record is the store's).
function withinBudget(name, args, promise, env = process.env) {
  const ms = budgetFor(name, env);
  if (ms == null) return promise;
  let timer;
  const cut = new Promise((res) => { timer = setTimeout(() => res(receipt(name, args, ms)), ms); });
  promise.catch(() => {});
  return Promise.race([promise, cut]).finally(() => clearTimeout(timer));
}

module.exports = { withinBudget, budgetFor, clientLimitMs, receipt, MARGIN_MS };
