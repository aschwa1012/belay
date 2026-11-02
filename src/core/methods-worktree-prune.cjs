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
const G = require('./git.cjs');
const { NO_HOOKS } = require('./git-safe.cjs');

const PIN_PREFIX = 'refs/belay/kept/';

// Every pin (refs/belay/kept/*) in the repositories these tasks recorded, with the local branches that already reach its commit: a pin
// whose commit a branch keeps is redundant and droppable; one no branch reaches is the only keeper and is never dropped by belay.
async function pinsOf(tasks) {
  const repos = [...new Set(tasks.map((t) => t.worktree && t.worktree.repo).filter(Boolean))];
  const pins = [];
  for (const repo of repos) {
    const r = await G.run(repo, ['for-each-ref', '--format=%(refname) %(objectname)', PIN_PREFIX]);
    if (!r.ok) continue;
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      const [ref, sha] = line.split(' ');
      const b = await G.run(repo, ['for-each-ref', '--format=%(refname:short)', '--contains', sha, 'refs/heads/']);
      const branches = b.ok ? b.stdout.split('\n').filter(Boolean) : [];
      pins.push({ repo, ref, sha, kept_by_branches: branches, droppable: branches.length > 0 });
    }
  }
  return pins;
}

async function prune(E, caller, args) {
  if (args.run_id !== undefined && (typeof args.run_id !== 'string' || !args.run_id)) throw err('E_ARGS', 'task.worktreePrune: run_id must be a run id', { field: 'run_id' });
  if (args.yes !== undefined && typeof args.yes !== 'boolean') throw err('E_ARGS', 'task.worktreePrune: yes must be a boolean', { field: 'yes' });
  if (args.drop_pins !== undefined && typeof args.drop_pins !== 'boolean') throw err('E_ARGS', 'task.worktreePrune: drop_pins must be a boolean', { field: 'drop_pins' });
  const yes = args.yes === true;
  const t0 = Date.now();
  const allTasks = rows.currentAll(E.store, 'task');
  const ids = [...new Set(allTasks.filter((t) => W.active(t) && t.run_id && (args.run_id === undefined || t.run_id === args.run_id)).map((t) => t.run_id))];
  const lapsed = await L.lapsedRuns(E, ids);
  const out = { dry_run: !yes, runs: [], removed: [], would_remove: [], kept: [], failed: [], orphans: [], pins: [], pins_dropped: [], skipped: null, ms: 0 };
  if (args.run_id !== undefined && !rows.current(E.store, 'run', args.run_id)) out.runs.push({ run_id: args.run_id, lapsed: false, reason: 'no_run_row' });
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
  // The pins are listed after the removals, so this call's own are in the list. Dropping one is the operator's, with yes and drop_pins.
  out.pins = await pinsOf(allTasks.filter((t) => args.run_id === undefined || t.run_id === args.run_id));
  if (yes && args.drop_pins === true) {
    for (const p of out.pins.filter((x) => x.droppable)) {
      const d = await G.run(p.repo, ['-c', `core.hooksPath=${NO_HOOKS}`, 'update-ref', '-d', p.ref, p.sha]);
      if (d.ok) out.pins_dropped.push(p.ref); else out.failed.push({ run_id: null, task_ids: [], path: p.repo, branch: null, code: 'E_GIT', error: `${p.ref} could not be dropped: ${d.stderr.split('\n')[0]}` });
    }
    out.pins = out.pins.filter((p) => !out.pins_dropped.includes(p.ref));
  }
  out.ms = Date.now() - t0;
  return out;
}

module.exports = { prune };
