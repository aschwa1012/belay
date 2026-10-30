'use strict';
// run-checks.cjs — the run-end receipt and `belay receipts` name each task's check commands and any change made to them during the
// run, and the commands each integrate call ran as its own `checks` (ADR 0069). Facts read from the task and integration rows;
// nothing here gates or judges. cmd-run.cjs keeps its edit to a call and a spread.

const CH = require('../core/check-history.cjs');

// -> the commands each integrate call of the run ran as its own `checks`: [{ integration_id, into_branch, commands: [line] }], one
// per call that ran any, argv only (the recorded cwd is where belay ran it). A call that ran none is left out.
function integrateChecksOf(integrations, runId) {
  const out = [];
  for (const r of Array.isArray(integrations) ? integrations : []) {
    if (!r || r.run_id !== runId || !Array.isArray(r.checks)) continue;
    const own = r.checks.filter((c) => c && c.source === 'integrate' && Array.isArray(c.argv));
    if (own.length) out.push({ integration_id: r.id, into_branch: r.into_branch, commands: own.map((c) => CH.lines({ commands: [{ argv: c.argv }] })[0]) });
  }
  return out;
}

// -> { task_checks: [{ task_id, checks, changes }], integrate_checks } for the run: every task once, in the order the store lists
// them, and each integrate call that ran checks of its own; null when the rows cannot be read. A fix task is shown against the task
// it repairs.
async function collect({ core, runId, startedAt = null }) {
  try {
    const { tasks } = await core.task.list({});
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const { integrations } = await core.integration.list({ run_id: runId });
    return {
      task_checks: tasks.filter((t) => t.run_id === runId).map((t) => CH.forReceipt(t, startedAt, t.repairs ? byId.get(t.repairs) : null)),
      integrate_checks: integrateChecksOf(integrations, runId),
    };
  } catch { return null; } // the receipt still stands without it
}

// A task id and an argument are the orchestrator's text: a control character becomes a space, so none starts a line of its own.
const CONTROL = new RegExp(`[${[[0, 31], [127, 159], [8232, 8233]].map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`, 'g'); // C0, DEL, C1, the line and paragraph separators
const clean = (s) => String(s).replace(CONTROL, ' ');

// One line for an integrate call: "integrate <id> into <branch> ran its own checks: <command>; <command>".
const integrateLine = (i) => clean(`integrate ${i.integration_id} into ${i.into_branch} ran its own checks: ${i.commands.join('; ')}`);

// The text receipt's lines: one per task (its checks once and each change to them), then one per integrate call that ran checks.
const lines = (receipt) => [
  ...(Array.isArray(receipt.task_checks) ? receipt.task_checks.map((h) => clean(CH.line(h))) : []),
  ...(Array.isArray(receipt.integrate_checks) ? receipt.integrate_checks.map(integrateLine) : []),
];

module.exports = { collect, lines, integrateChecksOf, integrateLine, clean };
