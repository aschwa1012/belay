'use strict';
// task-holds.cjs — which tasks hold their files (ADR 0046 decisions 1 and 4). Derived on every read, never written
// (invariants 4 and 6): a task holds its `files_owned` while it is open, assigned or released, owns a path, and its run
// is live. A run is live by the rule `run.list` uses: no `ended_at`, and an `adapter_pid` that answers a pid check.
// A task whose run has no row (a driver or a test that never attached) is live, and a reused pid makes a dead run look
// live: both fail towards refusing, never towards freeing.

const rows = require('./rows.cjs');
const { pidAlive } = require('./lock.cjs');
const { normalise } = require('./evaluate.cjs');

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
    if (!run) v = { live: true, reason: 'live' };
    else if (run.ended_at != null) v = { live: false, reason: 'run_ended' };
    else if (!pidAlive(run.adapter_pid)) v = { live: false, reason: 'run_dead' };
    else v = { live: true, reason: 'live' };
    memo.set(runId, v);
    return v;
  };
}

// { holds, reason }: the reason names what established the answer, as the other derived rungs do.
function holdOf(task, liveness) {
  if (task.state === 'done') return { holds: false, reason: 'done' };
  if (!Array.isArray(task.files_owned) || !task.files_owned.length) return { holds: false, reason: 'no_files' };
  const r = liveness(task.run_id);
  return { holds: r.live, reason: r.reason };
}

// The holding tasks (other than `exceptId`) that overlap `files`, with the paths that clash, first match per task.
function findClashes(store, files, exceptId) {
  const liveness = runLiveness(store);
  const out = [];
  for (const other of rows.currentAll(store, 'task')) {
    if (other.id === exceptId || !holdOf(other, liveness).holds) continue;
    const clash = [];
    for (const mine of files) for (const theirs of other.files_owned) if (overlaps(mine, theirs)) clash.push(mine);
    if (clash.length) out.push({ task: other, files: [...new Set(clash)] });
  }
  return out;
}

// ADR 0046 decision 1, resume: the tasks of `runId` that hold again once it is live, and the other live run's task each
// one now overlaps. Read after the run's row is appended, so the run counts as live.
function resumeOverlaps(store, runId) {
  const liveness = runLiveness(store);
  const out = [];
  for (const t of rows.currentAll(store, 'task')) {
    if (t.run_id !== runId || !holdOf(t, liveness).holds) continue;
    for (const c of findClashes(store, t.files_owned, t.id)) out.push({ task_id: t.id, other_task_id: c.task.id, files: c.files });
  }
  return out;
}

module.exports = { resumeOverlaps, overlaps, runLiveness, holdOf, findClashes };
