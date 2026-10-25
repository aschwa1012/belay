'use strict';
// task-holds.cjs — which tasks hold their files (ADR 0046 decisions 1 and 4). Derived on every read, never written
// (invariants 4 and 6): a task holds its `files_owned` while it is open, assigned or released, owns a path, and its run
// is live. A run is live by the rule `run.list` uses: no `ended_at`, and an `adapter_pid` that answers a pid check.
// A task whose run has no row (a driver or a test that never attached) is live, and a reused pid makes a dead run look
// live: both fail towards refusing, never towards freeing.

const rows = require('./rows.cjs');
const { pidAlive } = require('./lock.cjs');
const { normalise } = require('./evaluate.cjs');
const { samePath } = require('./git.cjs');

function overlaps(a, b) {
  const x = normalise(a), y = normalise(b);
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
}

// A per-call memo of each run's liveness, so one scan makes one pid check per distinct run.
function runLiveness(store) {
  const memo = new Map();
  return (runId) => {
    if (memo.has(runId)) return memo.get(runId);
    const run = rows.current(store, 'run', runId);
    let v;
    if (!run) v = { live: true, reason: 'run_live' };
    else if (run.ended_at != null) v = { live: false, reason: 'run_ended' };
    else if (!pidAlive(run.adapter_pid)) v = { live: false, reason: 'run_dead' };
    else v = { live: true, reason: 'run_live' };
    memo.set(runId, v);
    return v;
  };
}

// { holds, reason }: the reason names what established the answer, as the other derived rungs do.
function holdOf(task, liveness) {
  if (task.state === 'done' || task.state === 'cancelled') return { holds: false, reason: task.state }; // cancelled: ADR 0058
  if (!Array.isArray(task.files_owned) || !task.files_owned.length) return { holds: false, reason: 'no_files' };
  const r = liveness(task.run_id);
  return { holds: r.live, reason: r.reason };
}

// The store sequence of the row that made a run live in its present life: the first row after its last ended row, or
// its first row, or the row whose attach revived a lapsed adapter (a `revived_epoch` that differs from the row before it:
// the previous adapter was dead with no run.end, audit D36). Rows are ordered by `seq` across the whole table, so this
// orders two runs' revivals without a clock. null for a run with no row. A later attach of a life that never lapsed (the
// orchestrator adapter's) writes no `revived_epoch` and so does not move it.
function liveSince(store, runId) {
  const hist = rows.history(store, 'run', runId);
  if (!hist.length) return null;
  let since = hist[0].seq;
  for (let i = 0; i + 1 < hist.length; i++) {
    const cur = hist[i], next = hist[i + 1];
    if (cur.ended_at != null) since = next.seq;
    else if (next.revived_epoch != null && next.revived_epoch !== cur.revived_epoch) since = next.seq;
  }
  return since;
}

// ADR 0059 decision 1: where a task writes. `own` is the path of its belay worktree (recorded, not removed) when the worker
// working it works there; `loc` is the path known to be written in (that worker's worktree, else the recorded one) or null.
// `worker` is the worker taking the task (null for none); left undefined, it is the holder of the task's unreleased lease.
function treeOf(store, task, worker) {
  const wt = task.worktree && task.worktree.path && !task.worktree.removed_at ? task.worktree.path : null;
  let w = worker;
  if (w === undefined) {
    const l = rows.currentLeaseForTask(store, task.id);
    w = l && !l.released_at && l.holder_role === 'worker' ? rows.current(store, 'worker', l.holder) : null;
  }
  const cwd = w && typeof w.worktree === 'string' && w.worktree ? w.worktree : null;
  return { own: wt && (!cwd || samePath(cwd, wt)) ? wt : null, loc: cwd || wt };
}
const SHARED = Object.freeze({ own: null, loc: null });

// Two tasks write in one tree when neither has its own (the shared tree, or a place not yet known), or when their known
// locations are one path (a worker sent into another task's worktree).
function sameTree(a, b) {
  if (!a.own && !b.own) return true;
  return !!(a.loc && b.loc && samePath(a.loc, b.loc));
}

// The holding tasks (other than `exceptId`) that overlap `files`, with the paths that clash, first match per task, each with
// `same_tree` (ADR 0059): only an overlap in the same tree as `mine` (the asking task's treeOf; default the shared tree) gates.
// `asker` ({ run_id }) is the run of the task being assigned: a holding task of another run that came back to life after
// the asker's run did yields to it (ADR 0046 decision 1: the run that is live now keeps the paths), so it is skipped.
function scanOverlaps(store, files, exceptId, asker, mine = SHARED) {
  const liveness = runLiveness(store);
  // The yield is the live run's privilege: the asker's run must itself be live now, or it holds nothing to keep.
  const askerSince = asker && liveness(asker.run_id).live ? liveSince(store, asker.run_id) : null;
  const sinceMemo = new Map();
  const yields = (runId) => {
    if (askerSince == null || runId === asker.run_id) return false;
    if (!sinceMemo.has(runId)) sinceMemo.set(runId, liveSince(store, runId));
    const theirs = sinceMemo.get(runId);
    return theirs != null && theirs > askerSince;
  };
  const out = [];
  for (const other of rows.currentAll(store, 'task')) {
    if (other.id === exceptId || !holdOf(other, liveness).holds || yields(other.run_id)) continue;
    const clash = [];
    for (const mine of files) for (const theirs of other.files_owned) if (overlaps(mine, theirs)) clash.push(mine);
    if (!clash.length) continue;
    const theirs = treeOf(store, other);
    out.push({ task: other, files: [...new Set(clash)], same_tree: sameTree(mine, theirs), worktree: theirs.own });
  }
  return out;
}

const findClashes = (...a) => scanOverlaps(...a).filter((c) => c.same_tree);

// The overlaps ADR 0059 decision 2 let through, in the shape create and assign report them.
const acrossTrees = (scan) => scan.filter((c) => !c.same_tree).map((c) => ({ task_id: c.task.id, run_id: c.task.run_id, files: c.files, worktree: c.worktree }));

// ADR 0046 decision 1, resume: the tasks of `runId` that hold again once it is live, and the other live run's task each
// one now overlaps. Read after the run's row is appended, so the run counts as live.
function resumeOverlaps(store, runId) {
  const liveness = runLiveness(store);
  const out = [];
  for (const t of rows.currentAll(store, 'task')) {
    if (t.run_id !== runId || !holdOf(t, liveness).holds) continue;
    for (const c of findClashes(store, t.files_owned, t.id, undefined, treeOf(store, t))) out.push({ task_id: t.id, other_task_id: c.task.id, files: c.files });
  }
  return out;
}

// ADR 0046 decision 1, activation: a task that is about to be worked must hold its files for a live run, or the work is
// unprotected (a later create could take the same paths). Returns the run id that will own the work: the task's own run
// when it owns no files (nothing is held); else `candidateRunId`, the run of the worker that is taking the work, when it
// names a run. That run must be live, and the task moves to it unless it is already its own: a hold lasts as long as the
// run doing the work, not the run that wrote the task. With no run named (the operator's check) the task's own run stands
// when it is live. null when no live run can own it: the caller refuses.
function activationRun(store, task, candidateRunId) {
  if (!Array.isArray(task.files_owned) || !task.files_owned.length) return task.run_id;
  const liveness = runLiveness(store);
  if (typeof candidateRunId === 'string' && candidateRunId && candidateRunId !== 'cli') return liveness(candidateRunId).live ? candidateRunId : null;
  return liveness(task.run_id).live ? task.run_id : null;
}

module.exports = { activationRun, resumeOverlaps, overlaps, runLiveness, holdOf, findClashes, scanOverlaps, acrossTrees, treeOf };
