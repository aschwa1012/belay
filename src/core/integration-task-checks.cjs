'use strict';
// integration-task-checks.cjs — an integration's answer names, for each task it merged or carried, the checks the task was judged
// by and any change to them during the run (ADR 0069). Derived when the row is read, from the task rows; nothing is stored.

const rows = require('./rows.cjs');
const CH = require('./check-history.cjs');

// -> the row with `task_checks: [line]` added when it merged or carried a task; the row as it was otherwise.
function withTaskChecks(E, row) {
  if (!row || !Array.isArray(row.merged) || !row.merged.length) return row;
  const run = row.run_id ? rows.current(E.store, 'run', row.run_id) : null;
  const since = run && run.started_at != null ? Number(run.started_at) : null;
  const seen = new Set(), out = [];
  for (const m of row.merged) {
    if (!m || typeof m.task_id !== 'string' || seen.has(m.task_id)) continue;
    seen.add(m.task_id);
    const t = rows.current(E.store, 'task', m.task_id);
    if (t) out.push(CH.line(CH.historyOf(t, t.repairs ? rows.current(E.store, 'task', t.repairs) : null), since));
  }
  return out.length ? { ...row, task_checks: out } : row;
}

module.exports = { withTaskChecks };
