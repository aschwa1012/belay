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
// ADR 0058 amendment 4: how long a turn_end wake waits for its hand-backs' evaluation; BELAY_RELEASE_WAKE_HOLD_MS (ms) overrides it.
const RELEASE_WAKE_HOLD_MS = 30000;
const holdMs = () => (/^\d+$/.test(String(process.env.BELAY_RELEASE_WAKE_HOLD_MS || '').trim()) ? Number(process.env.BELAY_RELEASE_WAKE_HOLD_MS) : RELEASE_WAKE_HOLD_MS);

const failedKinds = (row) => ((row.results && row.results.checks) || []).filter((c) => !c.passed)
  .map((c) => (c.kind === 'command' ? `command ${Array.isArray(c.argv) ? c.argv.slice(0, 3).join(' ') : '?'}${c.exit_code != null ? ` exit ${c.exit_code}` : ''}` : c.kind));

function summaryOf(row) {
  const r = row.results || {};
  return { task_id: row.id, state: row.state, passed: !!r.passed, executable: !!r.executable, checks: ((r.checks) || []).length, failing: failedKinds(row), ...(r.flaky ? { flaky: true } : {}), ...(r.uncommitted ? { uncommitted: true } : {}) };
}

const unevaluated = (t, runId, workerId) => t.run_id === runId && t.state === 'released' && t.handoff && t.handoff.by === workerId
  && !(t.results && Number(t.results.evaluated_at) >= Number(t.handoff.at));

// Why a hand-back's evaluation may not start: a lifecycle operation, a park or a stop holds the worker, or the run manager closes.
const refused = (w, ctx) => !!(w.op || w.parkRequested || w.stopRequested || (ctx.shutdownFlags && (ctx.shutdownFlags.closing || ctx.shutdownFlags.closed)));
const usable = (ctx) => !!(ctx.core && ctx.core.task && typeof ctx.core.task.evaluate === 'function' && typeof ctx.core.task.list === 'function');

// Called in onTurnEnd before the turn is answered: the tasks this worker released with a hand-back that no evaluation has read,
// so the turn's answer can say `evaluating` (one read; no command runs here). Kept on the record for startRelease.
async function notePending(w, ctx) {
  w.releaseIds = null;
  if (!usable(ctx) || (ctx.shutdownFlags && (ctx.shutdownFlags.closing || ctx.shutdownFlags.closed))) return null;
  let tasks;
  try { tasks = ((await ctx.core.task.list({ states: ['released'] })) || {}).tasks || []; } catch (e) {
    w.lastError = { where: 'release-eval.list', code: e && e.code, message: e && e.message };
    return null;
  }
  // Announced only when it will run: not while an operation, a park or a stop holds the worker (startRelease refuses then too).
  if (refused(w, ctx)) return null;
  const ids = tasks.filter((t) => unevaluated(t, ctx.runId, w.id)).map((t) => t.id);
  w.releaseIds = ids.length ? { turn: w.turns, ids } : null;
  return w.releaseIds;
}

async function run(w, ctx, ev) {
  const core = ctx.core;
  const out = [];
  // One evaluation at a time per worker, in order: a hand-back released while this runs joins ev.task_ids (startRelease).
  for (ev.next = 0; ev.next < ev.task_ids.length; ev.next += 1) {
    const t = { id: ev.task_ids[ev.next] };
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
  ev.done = true; // in the same tick the loop ends: from here a later hand-back starts a new chain instead of joining this one
  return out;
}

// Called by onTurnEnd once the turn's row is written; not awaited. One evaluation per worker at a time, none while a lifecycle
// operation, a park or a stop holds the worker, and none after the run manager closed.
function startRelease(w, ctx) {
  const pending = w.releaseIds && w.releaseIds.turn === w.turns ? w.releaseIds.ids : null;
  w.releaseIds = null; // from here on w.evaluation (or nothing) is what is reported
  if (!pending || refused(w, ctx) || !usable(ctx)) return null;
  if (w.evaluation && !w.evaluation.done) { // a later hand-back waits behind the one being evaluated; a cancel cancels the whole chain
    const ev = w.evaluation;
    for (const id of pending) if (!ev.task_ids.includes(id)) ev.task_ids.push(id);
    ev.turn = w.turns;
    return ev;
  }
  const ev = { key: `release:${w.id}:${crypto.randomUUID()}`, ctx, turn: w.turns, task_ids: pending.slice(), next: 0, done: false, cancelled: null, promise: null };
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
  return { cancelled: ev.task_ids.slice(ev.next || 0), by: ev.cancelled }; // the hand-backs not yet evaluated
}

// worker_wait's view of the last turn: what its release evaluation found, or the tasks it is still evaluating.
function evalOf(w) {
  if (w.evaluation && !w.evaluation.done && w.evaluation.turn === w.turns) return { evaluating: w.evaluation.task_ids.slice(w.evaluation.next || 0) };
  if (w.releaseIds && w.releaseIds.turn === w.turns) return { evaluating: w.releaseIds.ids }; // about to start
  return w.turnEvaluated && w.turnEvaluatedTurn === w.turns ? { evaluated: w.turnEvaluated } : {};
}

const cut = (s, max) => {
  if (max <= 3) return '';
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  return `${Buffer.from(s, 'utf8').subarray(0, max - 3).toString('utf8').replace(/�$/, '')}...`;
};

// The evaluation clause, at most `room` bytes: " task T evaluated at release: passed, done." or "...: not done; failing: ...".
function clause(evs, room) {
  const parts = evs.map((e) => (e.error === 'E_BUSY' ? `task ${e.task_id} not evaluated at release: another evaluation of it is running`
    : e.error ? `task ${e.task_id} could not be evaluated at release (${e.error})`
    : `task ${e.task_id} evaluated at release: ${e.state === 'done' ? `${e.flaky ? 'passed on a retry (flaky), done' : 'passed, done'}${e.uncommitted ? '; uncommitted changes: commit before integrate' : ''}` : `not done; failing: ${e.failing.join(', ') || 'no executable check'}`}`));
  return cut(` ${parts.join('; ')}.`, room);
}

// The turn_end wake with its clause, the whole cut to WAKE_TEXT_MAX: the clause gives way, never the head or the pointer.
// `evaluating` (task ids still being evaluated) is a count and a pointer, so it fits where a list would not.
function turnEndText(head, tail, evs, evaluating) {
  const room = WAKE_TEXT_MAX - Buffer.byteLength(head + tail, 'utf8');
  const n = Array.isArray(evaluating) ? evaluating.length : 0;
  const ing = n ? cut(` Evaluating ${n} hand-back${n === 1 ? '' : 's'} at release; a wake follows with the result.`, room) : '';
  return `${head}${evs && evs.length ? clause(evs, room - Buffer.byteLength(ing, 'utf8')) : ''}${ing}${tail}`;
}

// For each turn_end wake: the release evaluations of that worker's tasks that have landed and were not reported, attached; those
// still running are watched. Watched tasks whose evaluation landed since become one `evaluated` wake per worker. `seen` is the
// caller's Map task_id -> evaluated_at, carried across polls (its `pending` holds the watched tasks, its `held` the held wakes).
// Tasks are read only when there is a turn_end, something watched or something held.
//
// ADR 0058 amendment 4: with `holdMs`, a turn_end whose hand-backs are still being evaluated is held until they land, so the result
// rides on that one wake instead of a second; past `holdMs` it goes out saying `evaluating`, and one `evaluated` wake follows when
// the result lands, so the result never waits on a call the orchestrator may not make. Any other event about the worker sends its
// held wake first, so a worker's wakes keep their order. `holdMs` 0 holds nothing. `now` is the clock, for a test to set.
async function enrichWakes(core, runId, events, seen, { holdMs = 0, now = Date.now } = {}) {
  const pending = seen.pending || (seen.pending = new Map());
  const held = seen.held || (seen.held = new Map());
  if (!events.some((e) => e.event === 'turn_end') && !pending.size && !held.size) return events;
  let tasks = null;
  try { tasks = ((await core.task.list({})) || {}).tasks || []; } catch { /* nothing is attached and nothing lands this poll */ }
  if (!tasks) { const flushed = [...held.values()].map((h) => h.ev); held.clear(); return flushed.concat(events); }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const landed = (t) => t.results && t.results.trigger === 'release' && seen.get(t.id) !== t.results.evaluated_at && (!t.handoff || Number(t.results.evaluated_at) >= Number(t.handoff.at));
  const t0 = now();
  const out = [];
  // A held wake takes what has landed since; a hand-back no longer awaiting evaluation (cancelled, re-assigned) is dropped from it.
  const settle = (h) => {
    h.ids = h.ids.filter((id) => {
      const t = byId.get(id);
      if (t && landed(t)) { seen.set(id, t.results.evaluated_at); pending.delete(id); h.evs.push(summaryOf(t)); return false; }
      if (!t || !unevaluated(t, runId, h.ev.worker_id)) { pending.delete(id); return false; }
      return true;
    });
  };
  const release = (wid) => {
    const h = held.get(wid);
    held.delete(wid);
    settle(h);
    if (h.evs.length) h.ev.evaluated = h.evs;
    if (h.ids.length) h.ev.evaluating = h.ids; // still watched in `pending`: its result follows as one wake
    out.push(h.ev);
  };
  for (const ev of events) {
    if (held.has(ev.worker_id)) release(ev.worker_id);
    if (ev.event !== 'turn_end') { out.push(ev); continue; }
    const evs = []; const ing = [];
    for (const t of tasks) {
      if (t.run_id !== runId || !t.handoff || t.handoff.by !== ev.worker_id) continue;
      if (landed(t)) { seen.set(t.id, t.results.evaluated_at); pending.delete(t.id); evs.push(summaryOf(t)); } else if (unevaluated(t, runId, ev.worker_id)) { pending.set(t.id, { worker_id: ev.worker_id, since: t0 }); ing.push(t.id); }
    }
    if (ing.length && holdMs > 0) { held.set(ev.worker_id, { ev, evs, ids: ing, since: t0 }); continue; }
    if (evs.length) ev.evaluated = evs;
    if (ing.length) ev.evaluating = ing;
    out.push(ev);
  }
  for (const [wid, h] of [...held]) {
    settle(h);
    if (!h.ids.length || t0 - h.since >= holdMs) release(wid);
  }
  // A held wake's tasks were settled above, so what lands here belongs to a wake already sent.
  const follow = new Map(); // worker id -> the summaries of its watched tasks that landed this poll
  for (const [id, p] of [...pending]) {
    const t = byId.get(id);
    if (t && landed(t)) {
      seen.set(id, t.results.evaluated_at); pending.delete(id);
      if (!follow.has(p.worker_id)) follow.set(p.worker_id, []);
      follow.get(p.worker_id).push(summaryOf(t));
    } else if (!t || !unevaluated(t, runId, p.worker_id) || t0 - p.since > PENDING_MAX_MS) pending.delete(id);
  }
  for (const [wid, evs] of follow) {
    const text = cut(`belay: worker ${wid}'s hand-back:${clause(evs, WAKE_TEXT_MAX)}`, WAKE_TEXT_MAX);
    const seq = Math.max(...evs.map((e) => Number(seen.get(e.task_id)) || 0));
    out.push({ event: 'evaluated', worker_id: `eval:${evs[0].task_id}`, turn: 0, seq, task_id: evs[0].task_id, ...(evs.length > 1 ? { task_ids: evs.map((e) => e.task_id) } : {}), text });
  }
  return out;
}

// The headless idle close (orchestrator.cjs) holds while a watched evaluation runs for a worker of this run that is still live:
// a stopped or dead worker's evaluation was cancelled, so it holds nothing. Returns 'eval:<task id>' entries for the hold record,
// and 'wake:<worker id>' for a turn_end wake still held (ADR 0058 amendment 4), whatever the worker's state: that hold is bounded.
function evaluatingHolds(seen, rows, runId) {
  const pending = seen && seen.pending;
  const held = [...((seen && seen.held) || new Map()).keys()].map((w) => `wake:${w}`); // a held turn_end wake holds the close too
  if (!pending || !pending.size) return held;
  const live = new Set((rows || []).filter((r) => r.run_id === runId && r.pid_alive === true && !['stopped', 'dead', 'paused'].includes(r.state)).map((r) => r.id));
  return [...pending].filter(([, p]) => live.has(p.worker_id)).map(([id]) => `eval:${id}`).concat(held);
}

module.exports = { unevaluated, notePending, evaluatingHolds, startRelease, cancelEvaluation, evalOf, enrichWakes, clause, turnEndText, summaryOf, holdMs, WAKE_TEXT_MAX, PENDING_MAX_MS, RELEASE_WAKE_HOLD_MS };
