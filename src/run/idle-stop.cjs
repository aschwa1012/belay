'use strict';
// idle-stop.cjs — ADR 0058 decision 8, the run lever `stop_idle_on_done` (off by default). With it on, a worker whose task
// reached `done` is stopped gracefully once it is idle: its last turn has ended, no new turn has started, and it holds no
// other unreleased lease. A worker the orchestrator has given more work is never stopped. The stop is the run manager's own
// `stop`, so it is the same graceful stop, by exact pid, as worker_stop, and its receipt is returned to the caller.

// `manager` is the run manager; `ctx.stopIdleOnDone` the lever. `taskRow` is the row that just became done.
// The decision, made before the stop and again at the moment of the stop, inside its operation slot (manager.stop's `guard`): a message or an
// assignment that landed while the leases were read, or a restart that began meanwhile, is seen here and the stop is skipped.
async function idleReason(ctx, w, workerId, launches) {
  if (!w.turnEnded || w.settled || w.stopRequested || w.parkRequested) return 'the worker is not idle';
  if (w.launches !== launches) return 'the worker was relaunched';
  let tasks;
  try { tasks = ((await ctx.core.task.list({ states: ['assigned'] })) || {}).tasks || []; } catch (e) { return `its leases could not be read: ${e && e.message}`; }
  const other = tasks.find((t) => t.lease && t.lease.holder === workerId && t.lease.holder_role === 'worker' && !t.lease.expired);
  if (other) return `it holds the lease on task ${other.id}`;
  if (!w.turnEnded || w.settled || w.stopRequested || w.parkRequested) return 'the worker is not idle';
  return w.launches !== launches ? 'the worker was relaunched' : null;
}

async function stopIfIdleDone(manager, ctx, taskRow) {
  if (!ctx.stopIdleOnDone || !taskRow || taskRow.state !== 'done') return null;
  const workerId = taskRow.handoff && taskRow.handoff.by;
  const w = workerId && typeof manager._worker === 'function' ? manager._worker(workerId) : null;
  if (!w) return null;
  await w.queue; // the turn's own row first; a message sent meanwhile starts a turn and is seen below
  if (!w.turnEnded || w.settled || w.stopRequested || w.parkRequested) return { worker_id: workerId, stopped: false, reason: 'the worker is not idle' };
  const launches = w.launches;
  const early = await idleReason(ctx, w, workerId, launches); // a look outside the slot: most refusals end here and never hold a message off
  if (early) return { worker_id: workerId, stopped: false, reason: early };
  let skipped = null;
  try {
    const guard = async () => { skipped = await idleReason(ctx, w, workerId, launches); return skipped; };
    const receipt = await manager.stop({ worker_id: workerId, mode: 'graceful', guard });
    if (skipped) return { worker_id: workerId, stopped: false, reason: skipped };
    return { worker_id: workerId, stopped: true, by: 'stop_idle_on_done', receipt };
  } catch (e) {
    return { worker_id: workerId, stopped: false, reason: `the stop failed: ${e && e.message}`, error: (e && e.code) || 'E_INTERNAL' };
  }
}

module.exports = { stopIfIdleDone };
