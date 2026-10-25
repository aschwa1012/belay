'use strict';
// methods-task-amend.cjs — two ways task.create meets work that drifted off the straight path (ADR 0061): `amend: true` revises a
// task's acceptance (and spec) as a new row of the same task, and `tree_of` gives a new task another task's recorded tree, the
// way a conflict fix is worked where the conflict is. The acceptance shape both paths share is checked here too.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');

// task.acceptance as task.create admits it; throws E_ARGS, nothing written.
function checkAcceptance(acceptance) {
  if (acceptance != null && (typeof acceptance !== 'object' || Array.isArray(acceptance))) {
    throw err('E_ARGS', 'task.acceptance must be an object with optional commands and files_within_owned');
  }
  const handoffShape = acceptance ? require('./handoff-check.cjs').shapeError(acceptance.handoff) : null; // ADR 0058 decision 6
  if (handoffShape) throw err('E_ARGS', handoffShape);
  const retries = require('./evaluate.cjs').retriesError(acceptance); if (retries) throw err('E_ARGS', retries); // ADR 0060 decision 2
  if (acceptance && acceptance.verdict !== undefined && acceptance.verdict !== true) {
    throw err('E_ARGS', 'task.acceptance.verdict must be true or absent: a review task is judged from a worker\'s handed-back verdict');
  }
}

// ADR 0061 section 1: an amend revises what decides the task is done, nothing else. Its files, dependencies, repairs, base and
// tree stay as created, so a field beside these is refused rather than ignored.
const AMEND_FIELDS = new Set(['id', 'amend', 'spec', 'acceptance', 'view']);

// task.create { id, amend: true, acceptance, spec? } -> the task row as amended. The old acceptance (and spec, when it changes)
// is kept in `amended: [{ at, by, acceptance, spec? }]`, and the last results stay, marked `stale`, so no check run under the
// old acceptance reads as current. Refused on done (final), on cancelled, while a lease is unreleased (the holder works to the
// acceptance it was given) and while an evaluation of the task runs (it reads the acceptance it started with).
async function amend(E, caller, args) {
  if (args.amend !== true) throw err('E_ARGS', 'task.create amend must be true or absent');
  if (typeof args.id !== 'string' || !args.id) throw err('E_ARGS', 'task.create amend needs the id of the task whose acceptance it revises');
  const extra = Object.keys(args).filter((k) => args[k] !== undefined && !AMEND_FIELDS.has(k));
  if (extra.length) throw err('E_ARGS', `task.create amend revises acceptance and spec only; ${extra.join(', ')} cannot change on an existing task`, { task_id: args.id, fields: extra });
  if (args.acceptance == null) throw err('E_ARGS', 'task.create amend needs the acceptance that replaces the task\'s own', { task_id: args.id });
  checkAcceptance(args.acceptance);
  if (args.spec !== undefined && (typeof args.spec !== 'string' || !args.spec.trim())) throw err('E_ARGS', 'task.create amend: spec, when given, must describe the work');
  const out = E.store.tx(() => {
    const task = rows.current(E.store, 'task', args.id);
    if (!task) throw err('E_NOT_FOUND', `no task row exists for ${args.id}, so there is nothing to amend; leave amend out to create it`, { task_id: args.id });
    if (task.state === 'done') throw err('E_TASK_DONE', `task ${task.id} is done, and done is final; its acceptance cannot change under it. Create a new task to redo the work`, { task_id: task.id, state: 'done' });
    if (task.state === 'cancelled') throw err('E_ARGS', `task ${task.id} was cancelled, which is final; create a new task to do the work`, { task_id: task.id, state: 'cancelled' });
    const l = rows.currentLeaseForTask(E.store, task.id);
    if (l && l.released_at == null) {
      throw err('E_PRECONDITION', `task ${task.id} is held by ${l.holder_role} ${l.holder} on lease ${l.id}, who works to the acceptance it was given; amend it once the lease is released`, { task_id: task.id, lease_id: l.id, holder: l.holder, holder_role: l.holder_role });
    }
    const running = require('./evaluate-cancel.cjs').runningFor(task.id);
    if (running) {
      throw err('E_BUSY', `task ${task.id} is being evaluated against its current acceptance; amend it once that result has landed`, { op: 'evaluate', task_id: task.id, running });
    }
    const t = Date.now(), by = E.writtenBy(caller);
    const spec = args.spec !== undefined && args.spec !== task.spec ? args.spec : null;
    const was = { at: t, by, acceptance: task.acceptance, ...(spec ? { spec: task.spec } : {}) };
    const amended = [...(Array.isArray(task.amended) ? task.amended : []), was];
    const results = task.results && typeof task.results === 'object' ? { ...task.results, stale: 'acceptance amended' } : task.results;
    return rows.append(E.store, 'task', { ...task, acceptance: args.acceptance, ...(spec ? { spec } : {}), amended, results }, by, t);
  });
  E.noteWrite();
  return out;
}

// ADR 0061 section 2: `tree_of` names a task whose recorded tree the new task is worked in, exactly as task.fixFromReview gives
// a fix the judged task's tree. A removed tree is not given. A conflict fix made this way does not use `repairs`, so it spends no
// fix round; its own `base` (task.create base) is the base its evaluations default to.
// `runTop` is the run's repository (runRepo): a tree in another repository is the operator's to name (task.worktreeCreate's repoOf).
function treeOf(E, id, runTop) {
  if (typeof id !== 'string' || !id) throw err('E_ARGS', 'task.create tree_of must be the id of a task whose worktree the new task is worked in');
  const src = rows.current(E.store, 'task', id);
  if (!src) throw err('E_NOT_FOUND', `task.create tree_of names ${id}, which has no row in this store`, { tree_of: id });
  const rec = require('./methods-worktree.cjs').inheritable(src);
  if (!rec) throw err('E_PRECONDITION', `task ${id} has no worktree${src.worktree && src.worktree.removed_at ? ' (it was removed)' : ''}, so there is no tree to work the new task in`, { tree_of: id });
  if (!require('./git.cjs').samePath(rec.repo, runTop)) {
    throw err('E_ROLE', `task.create tree_of: task ${id}'s worktree is in ${rec.repo}, not this run's repository (${runTop}); another repository is the operator's to name`, { tree_of: id, repo: rec.repo, run_repo: runTop });
  }
  return { ...rec, inherited_from: rec.inherited_from || src.id };
}

// The run's repository for a tree_of check, read before task.create reads anything else (it runs git).
const runRepo = (E, caller) => require('./methods-worktree.cjs').repoOf(E, caller, undefined, 'task.create tree_of');

module.exports = { amend, treeOf, runRepo, checkAcceptance };
