'use strict';
// evaluate-cancel.cjs — ADR 0058: a release evaluation the run manager started can be cancelled by key. The acceptance commands run
// in the store owner, so the cancel is a call to the owner: it kills the command running now by its live child handle (exact
// identity, ADR 0039), skips the rest, and the evaluation then writes nothing. A key belongs to the harness: the MCP boundary refuses
// it from a model (tools.cjs HARNESS_ONLY). The run manager sends the cancel and never waits on it or on the evaluation.

const { err } = require('./errors.cjs');
const { createCancel } = require('./evaluate.cjs');
const rows = require('./rows.cjs');

// ADR 0058: one evaluation of a task at a time. A second task.evaluate for the same task, worktree and base while one runs joins it
// and answers its row (`joined_evaluation: true`), so the commands never run twice in one tree at once. If the running one was
// cancelled, the joiner runs its own. One for the same task with another worktree or base is refused E_BUSY naming the running one
// (try-2 gap 4: a manual evaluation with a base raced the release evaluation, and both ran the suite at once); its result comes
// as a wake and in task_list, and the call can be made again once it has landed. Keyed in this owner process, where every
// evaluation runs.
const RUNNING = new Map(); // task|worktree|base -> the row promise
const BY_TASK = new Map(); // task id -> { key, worktree, base, trigger } of the evaluation running for it
// ADR 0061 section 4 (b): the span of every evaluation this owner runs, kept while it runs and while an evaluation that began
// before it ended still runs, so each command check can name the evaluations that ran beside it (`concurrent`, a label only).
const SPANS = []; // { task_id, start, end }
function during(taskId, t0, t1) {
  const by = new Map();
  for (const s of SPANS) {
    const ms = s.task_id === taskId ? 0 : Math.min(t1, s.end == null ? t1 : s.end) - Math.max(t0, s.start);
    if (ms > 0) by.set(s.task_id, (by.get(s.task_id) || 0) + ms);
  }
  return [...by].map(([task_id, overlap_ms]) => ({ task_id, overlap_ms }));
}
function endSpan(span) {
  span.end = Date.now();
  const from = Math.min(...SPANS.filter((s) => s.end == null).map((s) => s.start)); // Infinity when none runs
  for (let i = SPANS.length - 1; i >= 0; i--) if (SPANS[i].end != null && SPANS[i].end < from) SPANS.splice(i, 1);
}
// The evaluation running for a task, as an E_BUSY names it; null when none runs (task.create amend refuses beside one).
const runningFor = (id) => { const r = BY_TASK.get(id); return r ? { trigger: r.trigger, worktree: r.worktree, base: r.base } : null; };
const norm = (p) => { const s = String(p).replace(/\\/g, '/').replace(/\/+$/, ''); return process.platform === 'win32' ? s.toLowerCase() : s; };
async function joinOrRun(E, args, run) {
  const task = args && args.task_id ? rows.current(E.store, 'task', args.task_id) : null;
  let key = null, at = null;
  try { at = task ? require('./methods-worktree.cjs').evaluateTarget(task, args) : null; if (at) key = `${task.id}|${norm(at.worktree)}|${at.base || ''}`; } catch { /* run() refuses it, naming why */ }
  if (!key) return run();
  const cur = RUNNING.get(key);
  const other = !cur && BY_TASK.get(task.id);
  if (other) {
    throw err('E_BUSY', `task ${task.id} is being evaluated already (${other.trigger === 'release' ? 'at release' : 'by another call'}, in ${other.worktree}${other.base ? `, base ${other.base}` : ''}); its result comes as a wake and in task_list. Evaluate again once it has landed`,
      { op: 'evaluate', task_id: task.id, running: { trigger: other.trigger || null, worktree: other.worktree, base: other.base || null } });
  }
  if (cur) {
    try { return { ...(await cur), joined_evaluation: true }; } catch (e) {
      if (!(e && e.detail && e.detail.cancelled)) throw e; // the joined run's own refusal is this call's too
      return joinOrRun(E, args, run); // look again: another joiner may already have started the re-run
    }
  }
  const span = { task_id: task.id, start: Date.now(), end: null };
  SPANS.push(span);
  const p = run();
  const mine = { key, worktree: norm(at.worktree), base: at.base || null, trigger: args.trigger || null };
  RUNNING.set(key, p);
  BY_TASK.set(task.id, mine);
  try { return await p; } finally {
    endSpan(span);
    if (RUNNING.get(key) === p) RUNNING.delete(key);
    if (BY_TASK.get(task.id) === mine) BY_TASK.delete(task.id);
  }
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

module.exports = { register, unregister, cancelled, evaluateCancel, joinOrRun, pruneEarly, runningFor, during, LIVE, EARLY, RUNNING, SPANS, EARLY_TTL_MS };
