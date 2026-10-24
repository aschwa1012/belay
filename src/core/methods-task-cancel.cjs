'use strict';
// methods-task-cancel.cjs — task.cancel (ADR 0058 decision 7): the orchestrator gives up on a task. Its current lease, if not
// released, is released in the same transaction, the task is written `cancelled`, and a cancelled task holds none of its
// files_owned (task-holds.cjs), so another task can take them. `cancelled` is final, like `done`: assign and evaluate refuse
// it, and a task that depends on it can never be assigned (only `done` opens the gate). Nothing is deleted; the evaluation
// evidence the task had stays in its results, beside the cancellation.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');

async function cancel(E, caller, args) {
  if (!args.task_id || typeof args.task_id !== 'string') throw err('E_ARGS', 'task.cancel needs a task_id');
  if (args.reason !== undefined && typeof args.reason !== 'string') throw err('E_ARGS', 'task.cancel reason must be a string');
  const out = E.store.tx(() => {
    const task = rows.current(E.store, 'task', args.task_id);
    if (!task) throw err('E_NOT_FOUND', `no task row exists for ${args.task_id}`, { task_id: args.task_id });
    if (task.state === 'done') throw err('E_TASK_DONE', `task ${task.id} is done, and done is final; there is nothing to cancel`, { task_id: task.id, state: 'done' });
    if (task.state === 'cancelled') throw err('E_ARGS', `task ${task.id} is already cancelled`, { task_id: task.id, state: 'cancelled' });
    const l = rows.currentLeaseForTask(E.store, task.id);
    const held = l && l.released_at == null ? l : null;
    if (held && held.holder_role === 'operator' && caller.role !== 'operator') {
      throw err('E_OPERATOR_HOLDS', `the operator holds lease ${held.id} on task ${task.id}, and take-control outranks the orchestrator`, { task_id: task.id, lease_id: held.id });
    }
    const t = Date.now(), by = E.writtenBy(caller);
    const released = held ? rows.append(E.store, 'lease', { ...held, released_at: t }, by, t) : null;
    const results = { ...(task.results || {}), cancelled: { at: t, by: caller.role, reason: args.reason || null, released_lease_id: held ? held.id : null } };
    const row = rows.append(E.store, 'task', { ...task, state: 'cancelled', results }, by, t);
    return { task: row, released_lease: released, files_released: Array.isArray(task.files_owned) ? task.files_owned : [] };
  });
  E.noteWrite();
  return out;
}

module.exports = { cancel };
