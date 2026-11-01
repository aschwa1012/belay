'use strict';
// methods-task-new.cjs — the checks and the one append of task.create (api.md §3) for one task. It is synchronous, so a single
// create is one turn of the owner's event loop; the batch with trees (methods-task-batch.cjs) runs it once per item inside one
// transaction. It calls no git.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const holds = require('./task-holds.cjs');
const { filesOverlap, treeHint } = require('./methods-task-hold.cjs');

// `runTop` is the run's repository, read by the caller when tree_of is given. `own.worktree` is a tree the caller made or inherited.
function one(E, caller, args, own, runTop) {
  const AM = require('./methods-task-amend.cjs');
  if (args.follows_up !== undefined) throw err('E_ARGS', 'task.follows_up is written only by fix_from_review with follow_up: true; a caller cannot set it', { field: 'follows_up' }); // ADR 0064 decision 1
  if (typeof args.spec !== 'string' || !args.spec.trim()) throw err('E_ARGS', 'task.create needs a spec describing the work');
  const filesOwned = args.files_owned == null ? null : args.files_owned;
  if (filesOwned != null && (!Array.isArray(filesOwned) || filesOwned.some(p => typeof p !== 'string'))) {
    throw err('E_ARGS', 'task.files_owned must be an array of worktree-relative path strings');
  }
  const acceptance = args.acceptance == null ? null : args.acceptance;
  AM.checkAcceptance(acceptance);
  const dependsOn = args.depends_on == null ? null : args.depends_on;
  if (dependsOn != null && (!Array.isArray(dependsOn) || dependsOn.some(d => typeof d !== 'string' || !d))) {
    throw err('E_ARGS', 'task.depends_on must be an array of task ids this task cannot be assigned before');
  }
  if (args.repairs != null && (typeof args.repairs !== 'string' || !args.repairs)) {
    throw err('E_ARGS', 'task.repairs must be the id of the work task this fix task repairs');
  }
  const repairs = args.repairs == null ? null : args.repairs;
  const id = args.id || rows.newId();
  if (rows.current(E.store, 'task', id)) throw err('E_ARGS', `a task with id ${id} already exists in this store; choose another id, leave id out for a generated one, or pass amend: true to revise its acceptance`, { task_id: id });
  if (args.tree_of != null && own.worktree) throw err('E_ARGS', 'task.create tree_of: this task already inherits a tree');
  const tree = args.tree_of != null ? AM.treeOf(E, args.tree_of, runTop, caller) : own.worktree;

  const deps = dependsOn ? [...new Set(dependsOn)] : null;
  if (deps) {
    for (const dep of deps) {
      if (!rows.current(E.store, 'task', dep)) {
        throw err('E_NOT_FOUND', `task ${id} would depend on ${dep}, which has no row in this store, so nothing could ever mark it done`, { task_id: id, missing_dependency: dep });
      }
    }
    const cycle = require('./methods-task.cjs').findCycle(E.store, id, deps);
    if (cycle) {
      throw err('E_DEPENDENCY_CYCLE', `these dependencies form a cycle, ${cycle.join(' -> ')}, and every task in it would refuse assignment for ever`, { task_id: id, cycle });
    }
  }

  // ADR 0031 amendment 3: a fix task names its work; core refuses one only past the user's fix_hard_cap (none by default), and past max_fix_rounds the row carries a fix_notice.
  let fixNotice = null;
  if (repairs) {
    if (!rows.current(E.store, 'task', repairs)) {
      throw err('E_NOT_FOUND', `task ${id} would repair ${repairs}, which has no row in this store`, { task_id: id, missing_repairs: repairs });
    }
    const run = rows.current(E.store, 'run', caller.run_id);
    const hard = run && run.fix_hard_cap != null ? Number(run.fix_hard_cap) : null;
    const cap = run && run.max_fix_rounds != null ? Number(run.max_fix_rounds) : null;
    // A chain of fixes counts its rounds on the work it began from (as the derived review reads them), whichever fix a new one names.
    const all = rows.currentAll(E.store, 'task'), byTask = new Map(all.map(o => [o.id, o]));
    const rootOf = (t) => { for (let n = 0; t.repairs && byTask.has(t.repairs) && n < 100; n++) t = byTask.get(t.repairs); return t.id; };
    const root = rootOf(byTask.get(repairs));
    const used = all.filter(o => o.repairs && !(o.follows_up && o.follows_up.root) && rootOf(o) === root && o.run_id === caller.run_id).length;
    if (hard != null && used >= hard) {
      throw err('E_FIX_ROUNDS', `task ${root} already has ${used} fix task${used === 1 ? '' : 's'} and this run's fix_hard_cap is ${hard}${run.fix_hard_cap_source ? ` (${run.fix_hard_cap_source})` : ''}; no further fix task can be created for it in this run, and nothing was written`, { task_id: id, repairs, root, fix_rounds_used: used, fix_hard_cap: hard, fix_hard_cap_source: run.fix_hard_cap_source || null });
    }
    if (cap != null && used >= cap) fixNotice = `task ${root} now has ${used + 1} fix task${used === 0 ? '' : 's'} in this run, past max_fix_rounds ${cap}`;
  }

  if (own.follows_up) require('./methods-follow-up.cjs').checkCap(E, caller, id, own.follows_up); // ADR 0064 decision 5: its own cap, never a fix round

  let overlaps = [];
  if (filesOwned && filesOwned.length) {
    // ADR 0046 decision 1: only a task that holds its files (its run is live) can refuse this one. ADR 0059 decision 4: a new
    // task has no tree yet, so it is judged as shared, and only a holder in the shared tree refuses it; one in its own
    // worktree is reported in `overlaps`.
    const scan = holds.scanOverlaps(E.store, filesOwned, null, undefined, tree ? holds.treeOf(E.store, { worktree: tree }, null) : undefined); // an inherited tree is its own
    const first = scan.find((c) => c.same_tree);
    if (first) throw filesOverlap(first, treeHint(E.store, null));
    overlaps = holds.acrossTrees(scan);
  }

  const t = Date.now();
  const budget = require('./run-budget.cjs').taskLimit(E, caller, args); // dollar limit, checked before the append; null when none (the run process is told after the write: run-budget noteRows)
  const row = rows.append(E.store, 'task', {
    id, run_id: caller.run_id, spec: args.spec, acceptance, files_owned: filesOwned, state: 'open', ...(budget ? { budget_usd: budget } : {}),
    results: null, depends_on: deps, repairs, ...(tree ? { worktree: tree } : {}), ...(own.answers ? { answers: own.answers } : {}), ...(own.follows_up ? { follows_up: own.follows_up } : {}), ...(args.base != null ? { base: require('./methods-worktree.cjs').baseArg(args.base) } : {}),
  }, E.writtenBy(caller), t);
  E.noteWrite();
  return overlaps.length || fixNotice ? { ...row, ...(overlaps.length ? { overlaps } : {}), ...(fixNotice ? { fix_notice: fixNotice } : {}) } : row;
}

module.exports = { one };
