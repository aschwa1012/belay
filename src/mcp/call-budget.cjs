'use strict';
// call-budget.cjs — a tool call that can run longer than the client's tool timeout (MCP_TOOL_TIMEOUT) answers early.
// `integrate` and `task_evaluate` re-run acceptance commands inside the owner and may also queue behind
// max_parallel_evaluations; past the client's limit the client gives up while the owner carries on, and the orchestrator
// is left not knowing. The work is not cancelled: the call answers `still_running`, the result is in the store, and the run
// process wakes the orchestrator with it (call-wake.cjs). The adapter tells it two things, as run-ledger events written by
// the hooks below: that the call went past its budget (`call_detached`), and how it ended (`call_ended`).

const MARGIN_MS = 10000; // the same margin worker_wait keeps under the client's limit (ADR 0029 decision 5)
const DETACHED_WRITE_MS = 2000; // how long the receipt waits for the call_detached ledger write before it stops promising a wake
const LONG_TOOLS = new Set(['integrate', 'task_evaluate']);

function clientLimitMs(env = process.env) {
  const raw = String(env.MCP_TOOL_TIMEOUT || '').trim();
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : 0;
}

const budgetFor = (name, env = process.env) => {
  const lim = clientLimitMs(env);
  return LONG_TOOLS.has(name) && lim > 0 ? Math.max(1000, lim - MARGIN_MS) : null;
};

// The task ids a long call names: what the wake and the poll are about.
const taskIdsOf = (name, args) => {
  const a = args || {};
  if (name === 'integrate') return Array.isArray(a.task_ids) ? a.task_ids.filter((x) => typeof x === 'string') : [];
  return typeof a.task_id === 'string' && a.task_id ? [a.task_id] : [];
};

// `wake` is whether the `call_detached` ledger write landed: only then is a wake promised (invariant 5: no success without effect).
function receipt(name, args, ms, startedAt = Date.now() - ms, wake = true) {
  const ids = taskIdsOf(name, args);
  const poll = `task_list { task_ids: ${JSON.stringify(ids)} }`;
  const carries = name === 'integrate' ? 'which tasks, passed or failed, the failing checks and the conflict if any' : 'passed or failed and the failing checks';
  const where = name === 'integrate' ? ' (each task\'s integration)' : ' (its results, with at and evaluated_at)';
  const lead = `${name} is still running after ${Math.round(ms / 1000)} s, inside the owner; it is not cancelled and writes its result when it ends.`;
  const tail = `Do not call ${name} again while it runs. If it was queued behind max_parallel_evaluations and is refused, nothing is written and a task that had earlier results keeps them`;
  if (!wake) return { state: 'still_running', tool: name, waited_ms: ms, started_at: startedAt, wake: false, note: `${lead} No wake will follow: the run could not record this call. Poll ${poll}${where} until it shows the result. ${tail}` };
  return {
    state: 'still_running', tool: name, waited_ms: ms, started_at: startedAt,
    note: `${lead} A wake will carry the result when it lands: ${carries}. To look sooner, call ${poll}${where}. ${tail.replace('is refused, nothing is written and', 'is refused, nothing is written: the wake says so, and')}`,
  };
}

// -> the call's result, or the receipt when the budget passes first (the call carries on; a later failure is dropped here
// because its record is the store's). `hooks.detached({ tool, args, started_at })` runs once the budget has passed and is awaited
// for at most `hooks.detachedWriteMs` (DETACHED_WRITE_MS) before the receipt answers: a receipt that promises a wake is sent only
// after that write landed, else it says no wake will follow. `hooks.ended({ tool, args, started_at, row, error })` runs when the
// carried-on call settles, after a detached write that landed; it is not awaited by the answer and a failure of it is dropped.
function withinBudget(name, args, promise, env = process.env, hooks = null) {
  const ms = budgetFor(name, env);
  if (ms == null) return promise;
  const startedAt = Date.now();
  let timer;
  const cut = new Promise((res) => {
    timer = setTimeout(() => {
      if (!hooks) { res(receipt(name, args, ms, startedAt)); return; }
      const info = { tool: name, args, started_at: startedAt };
      const first = Promise.resolve().then(() => hooks.detached && hooks.detached(info)).then(() => true, () => false);
      let gate;
      const stalled = new Promise((r) => { gate = setTimeout(() => r(false), hooks.detachedWriteMs || DETACHED_WRITE_MS); });
      Promise.race([first, stalled]).then((landed) => { clearTimeout(gate); res(receipt(name, args, ms, startedAt, landed)); });
      promise.then((row) => first.then((ok) => ok && hooks.ended && hooks.ended({ ...info, row })), (error) => first.then((ok) => ok && hooks.ended && hooks.ended({ ...info, error })))
        .catch(() => {});
    }, ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, cut]).finally(() => clearTimeout(timer));
}

module.exports = { withinBudget, budgetFor, clientLimitMs, receipt, taskIdsOf, MARGIN_MS, DETACHED_WRITE_MS };
