'use strict';
// release-eval.cjs — ADR 0058 decision 5: a worker that released its task with a hand-back has the task evaluated by the run
// manager once its turn has ended and the turn's row is written, so the orchestrator need not remember to call task_evaluate.
// The evaluation is the core's task.evaluate in the worker's own worktree, marked `trigger: 'release'` in its results. It runs
// detached: it is never on the worker's queue, so no turn, row, message or lifecycle operation waits on its acceptance commands.
// A stop, pause, restart or resume (lifecycle.cjs runOp, and so the run's shutdown) cancels it first: the owner kills the command
// running by its live child handle and the evaluation writes nothing (core evaluate-cancel.cjs). Nothing waits on the cancel.
//
// `enrichWakes` is the wake side, facts only (task, state, which checks failed), never the worker's words (ADR 0015 section 2). A
// turn_end wake carries the result if it has landed; otherwise the task is watched and a later poll sends one `evaluated` wake.
// Every wake text is cut to WAKE_TEXT_MAX, the interactive mod's own text budget (src/mod/hooks/wake/core.mjs maxTextBytes: 226 B
// less the plugin name), so the mod never cuts it and the headless line stays inside the 400-byte hook budget (invariant 9).

const crypto = require('node:crypto');

const WAKE_TEXT_MAX = 221;
const PENDING_MAX_MS = 900000; // a watched evaluation that never lands (cancelled, or the owner gone) is forgotten after this

const failedKinds = (row) => ((row.results && row.results.checks) || []).filter((c) => !c.passed)
  .map((c) => (c.kind === 'command' ? `command ${Array.isArray(c.argv) ? c.argv.slice(0, 3).join(' ') : '?'}${c.exit_code != null ? ` exit ${c.exit_code}` : ''}` : c.kind));

function summaryOf(row) {
  const r = row.results || {};
  return { task_id: row.id, state: row.state, passed: !!r.passed, executable: !!r.executable, checks: ((r.checks) || []).length, failing: failedKinds(row) };
}

const unevaluated = (t, runId, workerId) => t.run_id === runId && t.state === 'released' && t.handoff && t.handoff.by === workerId
  && !(t.results && Number(t.results.evaluated_at) >= Number(t.handoff.at));

async function run(w, ctx, ev) {
  const core = ctx.core;
  let tasks;
  try { tasks = ((await core.task.list({ states: ['released'] })) || {}).tasks || []; } catch (e) {
    w.lastError = { where: 'release-eval.list', code: e && e.code, message: e && e.message };
    return null;
  }
  const mine = tasks.filter((t) => unevaluated(t, ctx.runId, w.id));
  ev.task_ids = mine.map((t) => t.id);
  if (!mine.length) return null;
  const out = [];
  for (const t of mine) {
    if (ev.cancelled) { out.push({ task_id: t.id, cancelled: true, by: ev.cancelled }); continue; }
    try {
      const row = await core.task.evaluate({ task_id: t.id, worktree: w.worktree, trigger: 'release', cancel_key: ev.key });
      out.push(summaryOf(row));
      // ADR 0058 decision 8: the stop waits for the worker's queue itself, and this is not on it.
      if (row.state === 'done' && ctx.stopIdleOnDone && ctx.manager && !ev.cancelled) { out[out.length - 1].stop_idle_on_done = true; w.idleStopping = ctx.manager.idleStop(row).then((r) => { if (r) w.idleStop = r; }, () => {}); }
    } catch (e) {
      out.push(e && e.detail && e.detail.cancelled ? { task_id: t.id, cancelled: true, by: e.detail.by || ev.cancelled }
        : { task_id: t.id, error: (e && e.code) || 'E_INTERNAL', message: String((e && e.message) || e).slice(0, 200) });
    }
  }
  return out;
}

// Called by onTurnEnd once the turn's row is written; not awaited. One evaluation per worker at a time, none while a lifecycle
// operation, a park or a stop holds the worker, and none after the run manager closed.
function startRelease(w, ctx) {
  const core = ctx.core;
  if (w.evaluation || w.op || w.parkRequested || w.stopRequested || (ctx.shutdownFlags && (ctx.shutdownFlags.closing || ctx.shutdownFlags.closed))) return null;
  if (!core || !core.task || typeof core.task.evaluate !== 'function' || typeof core.task.list !== 'function') return null;
  const ev = { key: `release:${w.id}:${crypto.randomUUID()}`, ctx, turn: w.turns, task_ids: null, cancelled: null, promise: null };
  w.evaluation = ev; w.lastEvaluation = ev;
  ev.promise = run(w, ctx, ev).then((out) => { if (out && !ev.cancelled) { w.turnEvaluated = out; w.turnEvaluatedTurn = ev.turn; } return out; }, (e) => {
    w.lastError = { where: 'release-eval', code: e && e.code, message: e && e.message };
    return null;
  }).finally(() => { if (w.evaluation === ev) w.evaluation = null; });
  return ev;
}

// Called first by every lifecycle operation (lifecycle.cjs runOp). Sends the cancel and returns at once; never waits.
function cancelEvaluation(w, by) {
  const ev = w.evaluation;
  if (!ev) return null;
  w.evaluation = null;
  ev.cancelled = by || 'a lifecycle operation';
  const t = ev.ctx.core && ev.ctx.core.task;
  if (t && typeof t.evaluateCancel === 'function') Promise.resolve().then(() => t.evaluateCancel({ cancel_key: ev.key, by: ev.cancelled })).catch(() => {});
  return { cancelled: ev.task_ids, by: ev.cancelled };
}

// worker_wait's view of the last turn: what its release evaluation found, or the tasks it is still evaluating.
function evalOf(w) {
  if (w.evaluation && w.evaluation.turn === w.turns) return { evaluating: w.evaluation.task_ids || [] };
  return w.turnEvaluated && w.turnEvaluatedTurn === w.turns ? { evaluated: w.turnEvaluated } : {};
}

const cut = (s, max) => {
  if (max <= 3) return '';
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  return `${Buffer.from(s, 'utf8').subarray(0, max - 3).toString('utf8').replace(/�$/, '')}...`;
};

// The evaluation clause, at most `room` bytes: " task T evaluated at release: passed, done." or "...: not done; failing: ...".
function clause(evs, room) {
  const parts = evs.map((e) => (e.error ? `task ${e.task_id} could not be evaluated at release (${e.error})`
    : `task ${e.task_id} evaluated at release: ${e.state === 'done' ? 'passed, done' : `not done; failing: ${e.failing.join(', ') || 'no executable check'}`}`));
  return cut(` ${parts.join('; ')}.`, room);
}

// The turn_end wake with its clause, the whole cut to WAKE_TEXT_MAX: the clause gives way, never the head or the pointer.
function turnEndText(head, tail, evs) {
  const room = WAKE_TEXT_MAX - Buffer.byteLength(head + tail, 'utf8');
  return `${head}${evs && evs.length ? clause(evs, room) : ''}${tail}`;
}

// For each turn_end wake: the release evaluations of that worker's tasks that have landed and were not reported, attached; those
// still running are watched. Watched tasks whose evaluation landed since become one `evaluated` wake each. `seen` is the caller's
// Map task_id -> evaluated_at, carried across polls (its `pending` holds the watched tasks). Tasks are read only when there is a
// turn_end or something watched.
async function enrichWakes(core, runId, events, seen) {
  const pending = seen.pending || (seen.pending = new Map());
  if (!events.some((e) => e.event === 'turn_end') && !pending.size) return events;
  let tasks;
  try { tasks = ((await core.task.list({})) || {}).tasks || []; } catch { return events; }
  const landed = (t) => t.results && t.results.trigger === 'release' && seen.get(t.id) !== t.results.evaluated_at && (!t.handoff || Number(t.results.evaluated_at) >= Number(t.handoff.at));
  for (const ev of events) {
    if (ev.event !== 'turn_end') continue;
    const evs = [];
    for (const t of tasks) {
      if (t.run_id !== runId || !t.handoff || t.handoff.by !== ev.worker_id) continue;
      if (landed(t)) { seen.set(t.id, t.results.evaluated_at); pending.delete(t.id); evs.push(summaryOf(t)); } else if (unevaluated(t, runId, ev.worker_id)) pending.set(t.id, { worker_id: ev.worker_id, since: Date.now() });
    }
    if (evs.length) ev.evaluated = evs;
  }
  const out = [...events];
  for (const [id, p] of [...pending]) {
    const t = tasks.find((x) => x.id === id);
    if (t && landed(t)) {
      seen.set(id, t.results.evaluated_at); pending.delete(id);
      const text = cut(`belay: worker ${p.worker_id}'s hand-back:${clause([summaryOf(t)], WAKE_TEXT_MAX)}`, WAKE_TEXT_MAX);
      out.push({ event: 'evaluated', worker_id: `eval:${id}`, turn: 0, seq: t.results.evaluated_at, task_id: id, text });
    } else if (!t || t.state !== 'released' || Date.now() - p.since > PENDING_MAX_MS) pending.delete(id);
  }
  return out;
}

module.exports = { startRelease, cancelEvaluation, evalOf, enrichWakes, clause, turnEndText, summaryOf, WAKE_TEXT_MAX, PENDING_MAX_MS };
