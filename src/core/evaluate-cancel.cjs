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
// Marks an evaluation as running from now; the returned function ends the span. An integration re-run takes one too (ADR 0061 section 4 (b)).
function beginSpan(taskId) {
  const span = { task_id: taskId, start: Date.now(), end: null };
  SPANS.push(span);
  return () => endSpan(span);
}
function endSpan(span) {
  span.end = Date.now();
  const from = Math.min(...SPANS.filter((s) => s.end == null).map((s) => s.start)); // Infinity when none runs
  for (let i = SPANS.length - 1; i >= 0; i--) if (SPANS[i].end != null && SPANS[i].end < from) SPANS.splice(i, 1);
}
// The evaluation running for a task, as an E_BUSY names it; null when none runs (task.create amend refuses beside one).
// A task whose evaluation waits for a slot, as { ahead } (the evaluations before it); null when it is not waiting (amend refuses beside one).
function queuedFor(id) {
  const i = GATE.waiting.findIndex((w) => w.task && w.task.id === id);
  return i < 0 ? null : { ahead: GATE.active + i };
}
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
    const queuedRelease = args.trigger !== 'release' && BY_TASK.get(task.id) && BY_TASK.get(task.id).trigger === 'release' ? queuedFor(task.id) : null;
    if (queuedRelease) { // a called evaluation never inherits a release evaluation's unbounded wait for a slot: its client gives up at 600 s with the outcome unknown
      const run0 = BY_TASK.get(task.id);
      throw err('E_BUSY', `the evaluation of task ${task.id} at release is queued for a slot (${queuedRelease.ahead} ahead; max_parallel_evaluations) and was not joined; it runs on its own and its result comes as a wake and in task_list, so nothing is run twice. Call task_evaluate again if it has not landed`,
        { op: 'evaluate', task_id: task.id, queued: true, ahead: queuedRelease.ahead, running: { trigger: 'release', worktree: run0.worktree, base: run0.base } });
    }
    try { return { ...(await cur), joined_evaluation: true }; } catch (e) {
      if (!(e && e.detail && e.detail.cancelled)) throw e; // the joined run's own refusal is this call's too
      return joinOrRun(E, args, run); // look again: another joiner may already have started the re-run
    }
  }
  const limit = limitFor(E, task.run_id);
  const p = (async () => {
    const slot = await acquire(limit, { cancelKey: args.cancel_key, task, unbounded: args.trigger === 'release' }); // queued evaluations are registered below, so a second call for the same task and tree joins this one
    const end = beginSpan(task.id);
    try { return await run(slot.queued); } finally { end(); slot.release(); }
  })();
  const mine = { key, worktree: norm(at.worktree), base: at.base || null, trigger: args.trigger || null };
  RUNNING.set(key, p);
  BY_TASK.set(task.id, mine);
  try { return await p; } finally {
    if (RUNNING.get(key) === p) RUNNING.delete(key);
    if (BY_TASK.get(task.id) === mine) BY_TASK.delete(task.id);
  }
}

// The run lever max_parallel_evaluations: at most N evaluations run at once in this owner, a task.evaluate (release-time or called) and an
// integration re-run alike; the others wait here in arrival order. Unset (null) gates nothing, which is the behaviour without the lever.
const GATE = { active: 0, waiting: [] }; // waiting: { limit, grant, reject, key, task, at, timer }
// How long a call may wait for a slot. The 540 s command budget (evaluate.cjs ACCEPTANCE_BUDGET_MS) is what is left after the wait, so wait plus run
// is inside 540 s and the client's 600 s wait (call-limits.cjs EVALUATE_TIMEOUT_MS) never ends first with the outcome unknown. 240 s leaves a
// queued evaluation at least 300 s to run; one that reaches it is refused E_BUSY { queued: true } with nothing run and nothing written. A
// release-time evaluation (trigger 'release', the run manager evaluating a hand-back) is not an orchestrator's call and has no one to call it
// again: it waits for its slot with no bound, runs with its whole budget after the wait, and records the wait as a fact (queued.waited_ms).
// Its client call carries its own long bound (call-limits.cjs RELEASE_EVALUATE_TIMEOUT_MS); a stop or run end takes it out of the queue
// through evaluateCancel.
const WAIT = { maxMs: 240000 };
const budgetAfter = (waitedMs, total, trigger = null) => trigger === 'release' ? total : Math.max(0, total - Math.max(0, Number(waitedMs) || 0));
function pump() {
  while (GATE.waiting.length && GATE.active < GATE.waiting[0].limit) { const w = GATE.waiting.shift(); GATE.active += 1; w.grant(); }
}
// -> Promise of { release(), queued: null | { ahead, waited_ms } }. `ahead` counts the evaluations running or queued when this one queued.
function acquire(limit, { cancelKey = null, task = null, op = 'evaluation', unbounded = false } = {}) {
  if (limit == null) return Promise.resolve({ release() {}, queued: null });
  let held = false;
  const slot = () => ({ release() { if (held) return; held = true; GATE.active -= 1; pump(); } });
  if (GATE.active < limit && !GATE.waiting.length) { GATE.active += 1; return Promise.resolve({ ...slot(), queued: null }); }
  const ahead = GATE.active + GATE.waiting.length;
  return new Promise((resolve, reject) => {
    const w = { limit, key: cancelKey, task, reject, at: Date.now(), grant: () => { clearTimeout(w.timer); resolve({ ...slot(), queued: { ahead, waited_ms: Date.now() - w.at } }); } };
    if (unbounded) { GATE.waiting.push(w); return; } // a release evaluation waits for its slot; the wait stays on record in queued
    w.timer = setTimeout(() => { // the bound: out of the queue, nothing run, nothing written
      const i = GATE.waiting.indexOf(w);
      if (i < 0) return;
      GATE.waiting.splice(i, 1);
      const waited_ms = Date.now() - w.at;
      reject(err('E_BUSY', `this ${op} waited ${Math.round(waited_ms / 1000)} s for a slot behind ${ahead} other evaluation${ahead === 1 ? '' : 's'} (the run allows only max_parallel_evaluations at once) and was not run; nothing was written. Call it again once the running evaluations have finished`,
        { op: 'evaluate', queued: true, ahead, waited_ms, ...(task ? { task_id: task.id } : {}) }));
    }, WAIT.maxMs);
    if (w.timer.unref) w.timer.unref();
    GATE.waiting.push(w);
  });
}
// The lever for a run: a positive integer, else null (unlimited).
function limitFor(E, runId) {
  const run = runId ? rows.current(E.store, 'run', runId) : null;
  const n = run ? Number(run.max_parallel_evaluations) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
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
  const qi = typeof args.cancel_key === 'string' && args.cancel_key ? GATE.waiting.findIndex((w) => w.key === args.cancel_key) : -1;
  if (qi >= 0) { // still waiting for a slot: it leaves the queue and its evaluation ends cancelled, having run nothing
    const [w] = GATE.waiting.splice(qi, 1);
    clearTimeout(w.timer);
    w.reject(cancelled(w.task, { by: typeof args.by === 'string' ? args.by : null }));
    return { cancel_key: args.cancel_key, cancelled: true, killed: [], queued: true };
  }
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

module.exports = { WAIT, budgetAfter, beginSpan, queuedFor, acquire, limitFor, GATE, register, unregister, cancelled, evaluateCancel, joinOrRun, pruneEarly, runningFor, during, LIVE, EARLY, RUNNING, SPANS, EARLY_TTL_MS };
