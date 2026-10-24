'use strict';
// evaluate-cancel.cjs — ADR 0058: a release evaluation the run manager started can be cancelled by key. The acceptance commands run
// in the store owner, so the cancel is a call to the owner: it kills the command running now by its live child handle (exact
// identity, ADR 0039), skips the rest, and the evaluation then writes nothing. A key belongs to the harness: the MCP boundary refuses
// it from a model (tools.cjs HARNESS_ONLY). The run manager sends the cancel and never waits on it or on the evaluation.

const { err } = require('./errors.cjs');
const { createCancel } = require('./evaluate.cjs');
const rows = require('./rows.cjs');

// ADR 0058: one evaluation of a task in one worktree at a time. A second task.evaluate for the same task, worktree and base while
// one runs joins it and answers its row (`joined_evaluation: true`), so the commands never run twice in one tree at once. If the
// running one was cancelled, the joiner runs its own. Keyed in this owner process, where every evaluation runs.
const RUNNING = new Map(); // task|worktree|base -> the row promise
const norm = (p) => { const s = String(p).replace(/\\/g, '/').replace(/\/+$/, ''); return process.platform === 'win32' ? s.toLowerCase() : s; };
async function joinOrRun(E, args, run) {
  const task = args && args.task_id ? rows.current(E.store, 'task', args.task_id) : null;
  let key = null;
  try { const at = task ? require('./methods-worktree.cjs').evaluateTarget(task, args) : null; if (at) key = `${task.id}|${norm(at.worktree)}|${at.base || ''}`; } catch { /* run() refuses it, naming why */ }
  if (!key) return run();
  const cur = RUNNING.get(key);
  if (cur) {
    try { return { ...(await cur), joined_evaluation: true }; } catch (e) {
      if (!(e && e.detail && e.detail.cancelled)) throw e; // the joined run's own refusal is this call's too
    }
  }
  const p = run();
  RUNNING.set(key, p);
  try { return await p; } finally { if (RUNNING.get(key) === p) RUNNING.delete(key); }
}

const LIVE = new Map(); // cancel_key -> the evaluation's cancel token, while its commands run
// A cancel that arrives before its evaluation registered (the two calls race) is remembered, so that evaluation starts cancelled.
const EARLY = new Map(); // cancel_key -> { by, at }; kept EARLY_TTL_MS, by then its evaluation has registered or never will
const EARLY_MAX = 1000;
const EARLY_TTL_MS = 600000;
function pruneEarly(now = Date.now()) { for (const [k, v] of EARLY) { if (now - v.at > EARLY_TTL_MS) EARLY.delete(k); else break; } }

function register(key) {
  if (typeof key !== 'string' || !key || key.length > 200) throw err('E_ARGS', 'task.evaluate cancel_key must be a non-empty string of at most 200 characters');
  const c = createCancel();
  pruneEarly();
  if (EARLY.has(key)) { c.cancelled = true; c.by = EARLY.get(key).by; EARLY.delete(key); return c; }
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
    pruneEarly();
    if (typeof args.cancel_key === 'string' && args.cancel_key) { EARLY.set(args.cancel_key, { by: typeof args.by === 'string' ? args.by : null, at: Date.now() }); if (EARLY.size > EARLY_MAX) EARLY.delete(EARLY.keys().next().value); }
    return { cancel_key: args.cancel_key || null, cancelled: false, killed: [], remembered: true };
  }
  LIVE.delete(args.cancel_key);
  const killed = await c.cancel(typeof args.by === 'string' ? args.by : null);
  return { cancel_key: args.cancel_key, cancelled: true, killed };
}

module.exports = { register, unregister, cancelled, evaluateCancel, joinOrRun, pruneEarly, LIVE, EARLY, RUNNING, EARLY_TTL_MS };
