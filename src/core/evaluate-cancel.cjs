'use strict';
// evaluate-cancel.cjs — ADR 0058: a release evaluation the run manager started can be cancelled by key. The acceptance commands run
// in the store owner, so the cancel is a call to the owner: it kills the command running now by its live child handle (exact
// identity, ADR 0039), skips the rest, and the evaluation then writes nothing. A key belongs to the harness: the MCP boundary refuses
// it from a model (tools.cjs HARNESS_ONLY). The run manager sends the cancel and never waits on it or on the evaluation.

const { err } = require('./errors.cjs');
const { createCancel } = require('./evaluate.cjs');

const LIVE = new Map(); // cancel_key -> the evaluation's cancel token, while its commands run
// A cancel that arrives before its evaluation registered (the two calls race) is remembered, so that evaluation starts cancelled.
const EARLY = new Map(); // cancel_key -> by
const EARLY_MAX = 1000;

function register(key) {
  if (typeof key !== 'string' || !key || key.length > 200) throw err('E_ARGS', 'task.evaluate cancel_key must be a non-empty string of at most 200 characters');
  const c = createCancel();
  if (EARLY.has(key)) { c.cancelled = true; c.by = EARLY.get(key); EARLY.delete(key); return c; }
  LIVE.set(key, c);
  return c;
}
const unregister = (key, c) => { if (LIVE.get(key) === c) LIVE.delete(key); };

// The refusal an evaluation that was cancelled ends with; nothing has been written.
const cancelled = (task, c) => err('E_BUSY', `the evaluation of task ${task.id} was cancelled (${c.by || 'by the run manager'}) before it wrote anything`, { task_id: task.id, op: 'evaluate', cancelled: true, by: c.by });

// task.evaluateCancel { cancel_key, by? } -> { cancel_key, cancelled, killed }. An unknown key (already finished) is cancelled: false.
async function evaluateCancel(E, caller, args) {
  const c = LIVE.get(args.cancel_key);
  if (!c) {
    if (typeof args.cancel_key === 'string' && args.cancel_key) { EARLY.set(args.cancel_key, typeof args.by === 'string' ? args.by : null); if (EARLY.size > EARLY_MAX) EARLY.delete(EARLY.keys().next().value); }
    return { cancel_key: args.cancel_key || null, cancelled: false, killed: [], remembered: true };
  }
  LIVE.delete(args.cancel_key);
  const killed = await c.cancel(typeof args.by === 'string' ? args.by : null);
  return { cancel_key: args.cancel_key, cancelled: true, killed };
}

module.exports = { register, unregister, cancelled, evaluateCancel, LIVE, EARLY };
