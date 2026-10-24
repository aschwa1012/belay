'use strict';
// methods-task-hold.cjs — which run owns a task's files when the task is about to be worked (ADR 0046 decision 1).
// `resolveOwner` is the one rule every activation shares: task.assign (the orchestrator's, the operator's), and
// `task.ensureHold`, which a run manager calls before it relaunches a worker that may be adopted from another run.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const holds = require('./task-holds.cjs');

function filesOverlap({ task, files }) {
  return err('E_FILES_OVERLAP', `task ${task.id} is not done and already owns ${files.join(', ')}`, { other_task_id: task.id, other_run_id: task.run_id, files });
}

function runNotLive(task, worker) {
  return err('E_RUN_NOT_LIVE', `task ${task.id} owns files and its run ${task.run_id} is not live, and ${worker ? `worker ${worker.id}'s run ${worker.run_id} is not a live run that could hold them` : 'no live run was named to hold them'}; assigning it would leave its files unprotected, so close it and create the work again in a live run`,
    { task_id: task.id, run_id: task.run_id, worker_run_id: worker ? worker.run_id : null });
}

// The run id that will own `task`'s files once it is worked by a worker of `candidateRunId`, or a thrown refusal.
// A task that owns no files keeps its run. Otherwise the receiving run owns the work (so the hold lasts exactly as long
// as the run doing it), and a task moved to a run other than its own is a new claim on its paths: every holding task
// that overlaps refuses it, with no priority for a run that was live longer. The incumbent's priority (a later revival
// yields) applies only to a task that stays in its own run, which held those paths before the competing run revived.
function resolveOwner(store, task, candidateRunId, worker) {
  if (!Array.isArray(task.files_owned) || !task.files_owned.length) return task.run_id;
  const ownerRun = holds.activationRun(store, task, candidateRunId);
  const moves = ownerRun != null && ownerRun !== task.run_id;
  const asker = moves ? null : { run_id: ownerRun == null ? task.run_id : ownerRun };
  const [first] = holds.findClashes(store, task.files_owned, task.id, asker);
  if (first) throw filesOverlap(first);
  if (ownerRun == null) throw runNotLive(task, worker);
  return ownerRun;
}

// A worker the manager is about to launch again (a restart, a resume, a Codex turn) works the task it holds the lease on.
// If that task's files are not held for the manager's live run, make them so (the task and its lease move to that run),
// or refuse before any process starts. Writes nothing when the task already holds under the caller's run.
async function ensureHold(E, caller, args) {
  if (!args.task_id || !args.worker_id) throw err('E_ARGS', 'task.ensureHold needs a task_id and a worker_id');
  const out = E.store.tx(() => {
    const task = rows.current(E.store, 'task', args.task_id);
    if (!task) throw err('E_NOT_FOUND', `no task row exists for ${args.task_id}`, { task_id: args.task_id });
    const base = { task_id: task.id, run_id: task.run_id, rehomed: false };
    if (task.state === 'done') return { ...base, held: false, reason: 'done' };
    if (!Array.isArray(task.files_owned) || !task.files_owned.length) return { ...base, held: false, reason: 'no_files' };
    const lease = rows.currentLeaseForTask(E.store, task.id);
    if (!lease || lease.released_at || lease.holder !== args.worker_id) return { ...base, held: false, reason: 'not_leased_to_worker' };
    const ownerRun = resolveOwner(E.store, task, caller.run_id, rows.current(E.store, 'worker', args.worker_id));
    if (ownerRun === task.run_id && lease.run_id === ownerRun) return { ...base, held: true, reason: 'run_live' };
    const t = Date.now(), by = E.writtenBy(caller);
    // The lease is restated under its own id with the new run, as a renewal restates it: the worker relaunched with --resume
    // still holds that id, and a new one would make its own lease_release or lease_renew a superseded lease (audit 0.3.1 P1).
    const newLease = rows.append(E.store, 'lease', { ...lease, run_id: ownerRun }, by, t);
    const row = rows.append(E.store, 'task', { ...task, run_id: ownerRun }, by, t);
    return { ...base, run_id: ownerRun, from_run_id: task.run_id, held: true, reason: 'rehomed', rehomed: true, task: row, new_lease: newLease };
  });
  if (out.rehomed) E.noteWrite();
  return out;
}

// ADR 0058 decision 2: a review task (acceptance.verdict) is never assigned to a worker that held a lease on the work it
// reviews (its depends_on and repairs). The verdict check refuses such a verdict at evaluate anyway (verdict.cjs); refusing
// at assign saves the reviewer's whole turn. A worker id that is reused within a run is the same worker here, as there.
function assertNotOwnReview(store, task, workerId) {
  if (!workerId || !task.acceptance || task.acceptance.verdict !== true) return;
  const under = [...(Array.isArray(task.depends_on) ? task.depends_on : []), ...(task.repairs ? [task.repairs] : [])];
  const own = require('./verdict.cjs').heldLeaseOn(store, workerId, under);
  if (own) {
    throw err('E_SELF_REVIEW', `task ${task.id} is a review of ${own.task_id}, and worker ${workerId} held lease ${own.id} on it; a worker cannot judge its own work, so give the review to a different worker`,
      { task_id: task.id, worker_id: workerId, reviewed_task_id: own.task_id, lease_id: own.id });
  }
}

module.exports = { filesOverlap, runNotLive, resolveOwner, ensureHold, assertNotOwnReview };
