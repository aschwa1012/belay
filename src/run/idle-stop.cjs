'use strict';
// idle-stop.cjs — ADR 0058 decision 8, the run lever `stop_idle_on_done` (off by default). With it on, a worker whose task
// reached `done` is stopped gracefully once it is idle: its last turn has ended, no new turn has started, and it holds no
// other unreleased lease. A worker the orchestrator has given more work is never stopped. The stop is the run manager's own
// `stop`, so it is the same graceful stop, by exact pid, as worker_stop, and its receipt is returned to the caller.

// `manager` is the run manager; `ctx.stopIdleOnDone` the lever. `taskRow` is the row that just became done.
async function stopIfIdleDone(manager, ctx, taskRow) {
  if (!ctx.stopIdleOnDone || !taskRow || taskRow.state !== 'done') return null;
  const workerId = taskRow.handoff && taskRow.handoff.by;
  const w = workerId && typeof manager._worker === 'function' ? manager._worker(workerId) : null;
  if (!w) return null;
  await w.queue; // the turn's own row first; a message sent meanwhile starts a turn and is seen below
  if (!w.turnEnded || w.settled || w.stopRequested || w.parkRequested) return { worker_id: workerId, stopped: false, reason: 'the worker is not idle' };
  let tasks = [];
  try { tasks = ((await ctx.core.task.list({ states: ['assigned'] })) || {}).tasks || []; } catch (e) { return { worker_id: workerId, stopped: false, reason: `its leases could not be read: ${e && e.message}` }; }
  const other = tasks.find((t) => t.lease && t.lease.holder === workerId && t.lease.holder_role === 'worker' && !t.lease.expired);
  if (other) return { worker_id: workerId, stopped: false, reason: `it holds the lease on task ${other.id}` };
  if (!w.turnEnded) return { worker_id: workerId, stopped: false, reason: 'the worker is not idle' };
  try {
    const receipt = await manager.stop({ worker_id: workerId, mode: 'graceful' });
    return { worker_id: workerId, stopped: true, by: 'stop_idle_on_done', receipt };
  } catch (e) {
    return { worker_id: workerId, stopped: false, reason: `the stop failed: ${e && e.message}`, error: (e && e.code) || 'E_INTERNAL' };
  }
}

module.exports = { stopIfIdleDone };
