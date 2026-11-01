'use strict';
// idle-stop.cjs — ADR 0058 decision 8, the run lever `stop_idle_on_done` (off by default). With it on, a worker whose task
// reached `done` is stopped gracefully once it is idle: its last turn has ended, no new turn has started, and it holds no
// other unreleased lease. A worker the orchestrator has given more work is never stopped. The stop is the run manager's own
// `stop`, so it is the same graceful stop, by exact pid, as worker_stop, and its receipt is returned to the caller.

const { fail } = require('./errors.cjs');

// `manager` is the run manager; `ctx.stopIdleOnDone` the lever. `taskRow` is the row that just became done.
// The decision, made before the stop and again at the moment of the stop, inside its operation slot (manager.stop's `guard`): a message or an
// assignment that landed while the leases were read, or a restart that began meanwhile, is seen here and the stop is skipped.
// task_assign does not enter the worker's operation slot, so it marks the record itself (`markAssign`, called by compose before the
// core commits the lease): `assigning` counts assigns in flight and `assignSeq` moves at the start and the end of each. The decision
// reads the seq before it reads the leases and refuses if an assign is in flight or began or ended since, so an assign that commits
// after the lease snapshot is always seen. With `commit` the decision's last check also sets `stopCommitted` in the same synchronous
// step, and from then on `markAssign` and a message refuse: the stop is going ahead and must not be given work.
function markAssign(w) {
  if (!w) return () => {};
  if (w.op && (w.op.name === 'stop' || (w.op.name === 'idle-stop' && w.stopCommitted))) {
    fail('E_BUSY', `worker ${w.id} is being stopped, so it takes no task; retry when it returns`, { worker_id: w.id, op: w.op.name });
  }
  w.assigning = (w.assigning || 0) + 1; w.assignSeq = (w.assignSeq || 0) + 1;
  let ended = false;
  return () => { if (ended) return; ended = true; w.assigning -= 1; w.assignSeq += 1; };
}
const notIdle = (w) => !w.turnEnded || w.settled || w.stopRequested || w.parkRequested || w.relaunching != null || (w.assigning || 0) > 0;
async function idleReason(ctx, w, workerId, launches, commit = false) {
  if (notIdle(w)) return 'the worker is not idle';
  if (w.launches !== launches) return 'the worker was relaunched';
  const seq = w.assignSeq || 0;
  let tasks;
  try { tasks = ((await ctx.core.task.list({ states: ['assigned'] })) || {}).tasks || []; } catch (e) { return `its leases could not be read: ${e && e.message}`; }
  const other = tasks.find((t) => t.lease && t.lease.holder === workerId && t.lease.holder_role === 'worker' && !t.lease.expired);
  if (other) return `it holds the lease on task ${other.id}`;
  if (notIdle(w) || (w.assignSeq || 0) !== seq) return 'the worker was given new work';
  if (w.launches !== launches) return 'the worker was relaunched';
  if (commit) w.stopCommitted = true;
  return null;
}

async function stopIfIdleDone(manager, ctx, taskRow) {
  if (!ctx.stopIdleOnDone || !taskRow || taskRow.state !== 'done') return null;
  const workerId = taskRow.handoff && taskRow.handoff.by;
  const w = workerId && typeof manager._worker === 'function' ? manager._worker(workerId) : null;
  if (!w) return null;
  await w.queue; // the turn's own row first; a message sent meanwhile starts a turn and is seen below
  if (notIdle(w)) return { worker_id: workerId, stopped: false, reason: 'the worker is not idle' };
  const launches = w.launches;
  const early = await idleReason(ctx, w, workerId, launches); // a look outside the slot: most refusals end here and never hold a message off
  if (early) return { worker_id: workerId, stopped: false, reason: early };
  let skipped = null;
  let ran = false;
  try {
    const guard = async () => { ran = true; skipped = await idleReason(ctx, w, workerId, launches, true); return skipped; };
    const receipt = await manager.stop({ worker_id: workerId, mode: 'graceful', guard });
    if (skipped || receipt == null) return { worker_id: workerId, stopped: false, reason: skipped || 'another idle stop decided' };
    return { worker_id: workerId, stopped: true, by: 'stop_idle_on_done', receipt };
  } catch (e) {
    return { worker_id: workerId, stopped: false, reason: `the stop failed: ${e && e.message}`, error: (e && e.code) || 'E_INTERNAL' };
  } finally {
    if (ran) w.stopCommitted = false; // only the decision that set it clears it
  }
}

module.exports = { stopIfIdleDone, markAssign };
