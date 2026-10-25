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
const { err } = require('./errors.cjs');
const { DEFAULT_LEASE_TTL_MS } = require('./schema.cjs');

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

// ADR 0026 amendment 2 (proposed): the worker's adapter can outlive the process it serves by a few hundred ms (ADR 0029), so a
// hand-back sent just before the death can reach the core after the dead row released its lease. It is accepted, as a normal
// release would be, when the caller is that holder, the released lease is still the task's current lease (nothing granted since)
// and the task is still the `open` the death left it. The lease row is not written again; the receipt says the death released it.
function isLateHandback(caller, l, task) {
  return caller.role === 'worker' && l.released_at != null && l.released_reason === HOLDER_DEAD && l.holder_role === 'worker'
    && l.holder === caller.worker_id && !!task && task.state === 'open';
}

const lateReceipt = (l) => ({ lease_released_by: HOLDER_DEAD, note: `lease ${l.id} was already released when its holder ${l.holder} died; this hand-back was accepted and the task is released` });

// A release that names a lease its holder's death released, on a task leased to someone else since: refused, naming both.
function refuseSupersededDeath(store, leaseId) {
  const own = leaseId ? rows.current(store, 'lease', leaseId) : null;
  if (!own || own.released_reason !== HOLDER_DEAD) return;
  const cur = rows.currentLeaseForTask(store, own.task_id);
  if (!cur || cur.id === own.id) return;
  throw err('E_LEASE_EXPIRED', `lease ${own.id} on task ${own.task_id} was released when its holder ${own.holder} died (holder_dead), and the task has since been leased to ${cur.holder_role} ${cur.holder} (lease ${cur.id}); this hand-back was not written`,
    { lease_id: own.id, task_id: own.task_id, released_reason: HOLDER_DEAD, superseded_by: cur.id, current_holder: cur.holder, current_holder_role: cur.holder_role });
}

// ADR 0026 amendment 2 (proposed): task.ensureHold for a worker relaunched (restart, resume, a Codex turn) after its death released
// its lease on `task`. null when this worker's last lease on the task was not released by its death (the ordinary rules apply).
// If that lease is still the task's current lease and the task is still `open`, nobody has been given the work since: the lease is
// granted back under its own id (the relaunched worker still holds that id, as ensureHold's rehome keeps it) and the task is
// `assigned` again. Otherwise the worker holds no lease, and the answer says why; nothing is written, so one task's lease is never
// held by two live workers. `ownerOf(task)` is resolveOwner for the caller's run (it refuses an overlap as task.assign would).
function reclaimForRestart(E, caller, task, workerId, ownerOf) {
  const mine = rows.parseRow('lease', E.store.p("SELECT * FROM lease WHERE task_id = ? AND holder = ? AND holder_role = 'worker' ORDER BY seq DESC LIMIT 1").get(task.id, workerId));
  if (!mine || mine.released_reason !== HOLDER_DEAD) return null;
  const cur = rows.currentLeaseForTask(E.store, task.id);
  if (!cur || cur.id !== mine.id || task.state !== 'open') {
    const by = cur && cur.id !== mine.id && !cur.released_at ? `${cur.holder_role} ${cur.holder}` : null;
    return { held: false, reason: 'lease_lost', lease_id: mine.id, task_state: task.state, current_holder: by };
  }
  const ownerRun = ownerOf(task);
  const t = Date.now(), by = E.writtenBy(caller), ttl = Number(mine.ttl_ms) > 0 ? Number(mine.ttl_ms) : DEFAULT_LEASE_TTL_MS;
  const lease = rows.append(E.store, 'lease', { ...mine, run_id: ownerRun, released_at: null, released_reason: null, expires_at: t + ttl, ttl_ms: ttl }, by, t);
  const row = rows.append(E.store, 'task', { ...task, run_id: ownerRun, state: 'assigned' }, by, t);
  return { run_id: ownerRun, held: true, reason: 'regranted', regranted: true, lease_id: lease.id, new_lease: lease, task: row };
}

module.exports = { releaseForDeadHolder, appendDead, isLateHandback, lateReceipt, refuseSupersededDeath, reclaimForRestart, HOLDER_DEAD };
