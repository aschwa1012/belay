'use strict';
// lease-holder-dead.cjs — ADR 0026 amendment 1 (proposed): a worker whose death belay has established gives up its leases at once,
// instead of holding its task until the lease runs out. Called inside the transaction that writes the worker's first `dead` row:
// worker.write (the adapter's exit handler, a pid check), run.attach (a dead pid under a new epoch) and run.end (the run's close).
// A park (`paused`), a stop (`stopped`) and a restart's own held death (worker.write `keep_leases`) never reach here.
//
// Each current, unreleased worker lease the dead worker holds (expired or not) gets a released row with `released_reason`
// `holder_dead`; its task, if `assigned`, goes back to `open`, so task.assign can give it to another worker at once. A task's
// files stay held by the task (ADR 0046 decision 1: an open task holds them too), never by the dead worker, so the next worker
// takes the task with its paths. Returns `[{ lease_id, task_id }]`, empty when the worker held nothing.

const rows = require('./rows.cjs');

const HOLDER_DEAD = 'holder_dead';

function releaseForDeadHolder(store, workerId, by, t) {
  const taskIds = store.p("SELECT DISTINCT task_id FROM lease WHERE holder = ? AND holder_role = 'worker'").all(workerId).map((r) => r.task_id);
  const released = [];
  for (const taskId of taskIds) {
    const l = rows.currentLeaseForTask(store, taskId);
    if (!l || l.released_at != null || l.holder !== workerId || l.holder_role !== 'worker') continue;
    rows.append(store, 'lease', { ...l, released_at: t, released_reason: HOLDER_DEAD }, by, t);
    const task = rows.current(store, 'task', taskId);
    if (task && task.state === 'assigned') rows.append(store, 'task', { ...task, state: 'open' }, by, t);
    released.push({ lease_id: l.id, task_id: taskId });
  }
  return released;
}

// A worker's first dead row and the release of every lease it held, in one transaction: the row names what its death released
// (`leases_released`, null when nothing), so the death wake can say so. `E` is the engine. Returns { row, released }.
function appendDead(E, values, by, t) {
  return E.store.tx(() => {
    const released = releaseForDeadHolder(E.store, values.id, by, t);
    const row = rows.append(E.store, 'worker', { ...values, leases_released: released.length ? released : null }, by, t);
    return { row, released };
  });
}

module.exports = { releaseForDeadHolder, appendDead, HOLDER_DEAD };
