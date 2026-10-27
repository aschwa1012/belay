'use strict';
// handoff-check.cjs — the `handoff` acceptance check (ADR 0058 decision 6). A research or review task changes no file and runs
// no command, so before this it had no check that could ever pass. `acceptance: { handoff: { required: [names] } }` asks for a
// hand-back that carries each named field with a value: a non-empty string, a non-empty array, an object with a key, a number
// or a boolean. Mechanical only: it proves the fields are there, not that they are right. Reads the task's current lease, nothing else.

const rows = require('./rows.cjs');

const MAX_REQUIRED = 20;

// The create-time check of the acceptance block. Returns an error message, or null.
function shapeError(handoff) {
  if (handoff === undefined) return null;
  const req = handoff && typeof handoff === 'object' && !Array.isArray(handoff) ? handoff.required : undefined;
  if (!Array.isArray(req) || !req.length || req.length > MAX_REQUIRED || req.some((k) => typeof k !== 'string' || !k.trim())) {
    return `task.acceptance.handoff must be { required: [1 to ${MAX_REQUIRED} field names the hand-back's result must carry] }`;
  }
  return null;
}

const filled = (v) => (typeof v === 'string' ? v.trim().length > 0
  : Array.isArray(v) ? v.length > 0
    : v !== null && typeof v === 'object' ? Object.keys(v).length > 0
      : typeof v === 'number' ? Number.isFinite(v) : typeof v === 'boolean');

// `store` is read for the task's current lease: only the hand-back of that lease, once released, counts (as for a verdict).
function handoffCheck(store, task) {
  const started = Date.now();
  const required = task.acceptance.handoff.required;
  const h = task.handoff && typeof task.handoff === 'object' ? task.handoff : null;
  const r = h && h.result && typeof h.result === 'object' && !Array.isArray(h.result) ? h.result : null;
  const done = (executable, passed, detail) => ({ kind: 'handoff', executable, passed, ms: Date.now() - started, detail: { required, by: h ? h.by : null, lease_id: h ? h.lease_id : null, ...detail } });
  if (!r) return done(false, false, { reason: 'the task has no hand-back: no worker has released it with a result' });
  const lease = rows.currentLeaseForTask(store, task.id);
  if (!lease || lease.id !== h.lease_id || lease.released_at == null) return done(false, false, { reason: `the hand-back is from lease ${h.lease_id}, which is not the task's current released lease, so it is stale` });
  const missing = required.filter((k) => !filled(r[k]));
  return done(true, missing.length === 0, { missing });
}

module.exports = { handoffCheck, shapeError, MAX_REQUIRED };
