'use strict';
// methods-worktree-prune.cjs — task.worktreePrune (ADR 0065 amendment 3): the sweep's removal for runs that lapsed, so their task
// trees do not wait for a close that will not come. The operator's only, with no MCP tool. Without `yes` it is the preview: the
// sweep's dry run for each lapsed run, writing nothing. With `yes` it removes what the same conditions pass, through the sweep's
// own removal (the claim, the repository check, the pin of the head, the link walk), one tree at a time. A run that is not proven
// lapsed (its row is not ended and a process it recorded may still run) is kept whole. Nothing is killed, signalled or stopped.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const S = require('./methods-worktree-sweep.cjs');
const L = require('./run-lapsed.cjs');
const W = require('./methods-worktree.cjs');

async function prune(E, caller, args) {
  if (args.run_id !== undefined && (typeof args.run_id !== 'string' || !args.run_id)) throw err('E_ARGS', 'task.worktreePrune: run_id must be a run id', { field: 'run_id' });
  if (args.yes !== undefined && typeof args.yes !== 'boolean') throw err('E_ARGS', 'task.worktreePrune: yes must be a boolean', { field: 'yes' });
  const yes = args.yes === true;
  const t0 = Date.now();
  const allTasks = rows.currentAll(E.store, 'task');
  const ids = [...new Set(allTasks.filter((t) => W.active(t) && t.run_id && (args.run_id === undefined || t.run_id === args.run_id)).map((t) => t.run_id))];
  const lapsed = await L.lapsedRuns(E, ids);
  const out = { dry_run: !yes, runs: [], removed: [], would_remove: [], kept: [], failed: [], orphans: [], skipped: null, ms: 0 };
  for (const runId of ids) {
    const j = lapsed.get(runId);
    out.runs.push({ run_id: runId, lapsed: j.lapsed, reason: j.reason });
    const tag = (e) => ({ run_id: runId, ...e });
    if (!j.lapsed) {
      for (const g of S.treeGroups(allTasks, runId).values()) out.kept.push(tag({ task_ids: g.tasks.map((t) => t.id), path: g.rec.path, branch: g.rec.branch, reason: 'run_not_lapsed', detail: j.reason }));
      continue;
    }
    const left = S.SWEEP_BUDGET_MS - (Date.now() - t0);
    const r = await S.sweep(E, caller, { run_id: runId, dry_run: !yes, ...(yes ? { lapsed_seq: j.seq, budget_ms: Math.max(0, left) } : {}) });
    for (const k of ['removed', 'would_remove', 'kept', 'failed']) for (const e of r[k] || []) out[k].push(tag(e));
    for (const o of r.orphans || []) if (!out.orphans.some((x) => x.path === o.path)) out.orphans.push(o);
    if (r.skipped) out.skipped = r.skipped;
  }
  out.ms = Date.now() - t0;
  return out;
}

module.exports = { prune };
