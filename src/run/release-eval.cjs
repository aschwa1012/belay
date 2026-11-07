'use strict';
// release-eval.cjs — ADR 0058 decision 5: a worker that released its task with a hand-back has the task evaluated by the run
// manager once its turn has ended and the turn's row is written, so the orchestrator need not remember to call task_evaluate.
// The evaluation is the core's task.evaluate in the worker's own worktree, marked `trigger: 'release'` in its results. It runs
// detached: it is never on the worker's queue, so no turn, row, message or lifecycle operation waits on its acceptance commands.
// A stop, pause, restart or resume (lifecycle.cjs runOp, and so the run's shutdown) cancels it first: the owner kills the command
// running by its live child handle and the evaluation writes nothing (core evaluate-cancel.cjs). Nothing waits on the cancel.
//
// `enrichWakes` is the wake side, facts only (task, state, which checks failed), never the worker's words, except a review's verdict, counts, finding titles and a cut summary (review-wake.cjs; ADR 0015 section 2). A
// turn_end wake carries the result if it has landed; otherwise the task is watched and a later poll sends one `evaluated` wake.
// Every wake text is cut to WAKE_TEXT_MAX, the interactive mod's own text budget (src/mod/hooks/wake/core.mjs maxTextBytes: 226 B
// less the plugin name), so the mod never cuts it and the headless line stays inside the 400-byte hook budget (invariant 9).

const crypto = require('node:crypto');
const reviewWake = require('./review-wake.cjs');
const { forecastTask } = require('../core/conflict-forecast.cjs');

const WAKE_TEXT_MAX = 221;
const FORECAST_EXIT_CEILING_MS = 30000; // how long past its answer a forecast may hold its slot while its git calls have not exited
const FORECASTS_MAX = 4; // conflict forecasts running at once (conflict-forecast.cjs)
const PENDING_MAX_MS = 900000; // a watched evaluation that never lands (cancelled, or the owner gone) is forgotten after this, unless its worker is live: a release evaluation may queue for a slot and then run 540 s
// ADR 0058 amendment 4: how long a turn_end wake waits for its hand-backs' evaluation; BELAY_RELEASE_WAKE_HOLD_MS (ms) overrides it.
const RELEASE_WAKE_HOLD_MS = 30000;
const holdMs = () => (/^\d+$/.test(String(process.env.BELAY_RELEASE_WAKE_HOLD_MS || '').trim()) ? Number(process.env.BELAY_RELEASE_WAKE_HOLD_MS) : RELEASE_WAKE_HOLD_MS);

// A failing command that ran beside other evaluations says so: a failure under load is not read as the code's alone.
const beside = (c) => { const n = Array.isArray(c.concurrent) ? c.concurrent.length : 0; return n ? ` (ran beside ${n} other evaluation${n === 1 ? '' : 's'})` : ''; };
const failedKinds = (row) => ((row.results && row.results.checks) || []).filter((c) => !c.passed)
  .map((c) => (c.kind === 'command' ? `command ${Array.isArray(c.argv) ? c.argv.slice(0, 3).join(' ') : '?'}${c.exit_code != null ? ` exit ${c.exit_code}` : ''}${beside(c)}` : c.kind));

// A refuted review's wake names the fix rounds the reviewed work has used in this run and the run's max_fix_rounds, read from the work's derived `review` (facts, so the orchestrator sees the count before it asks for another fix).
function fixRoundsOf(row, byId) {
  const r = row.results || {};
  const dep = byId && Array.isArray(row.depends_on) && row.depends_on.length === 1 ? byId.get(row.depends_on[0]) : null;
  const rv = dep && dep.review;
  if (!rv || r.passed || !r.executable || !(r.checks || []).some((c) => c.kind === 'verdict') || rv.max_fix_rounds == null) return null;
  let root = dep; // a fix of a fix names the work it began from, not the fix before it
  for (let n = 0; root.repairs && byId.get(root.repairs) && n < 100; n++) root = byId.get(root.repairs);
  return { work: root.id, used: rv.fix_rounds_used, max: rv.max_fix_rounds, hard: rv.fix_hard_cap == null ? null : rv.fix_hard_cap };
}

// The work a refuted review judged, read for the turn's own summary (worker_wait): a Map of that task and the fixes it repairs back to the original work, or null.
async function workOf(core, row) {
  const r = row.results || {};
  if (r.passed || !r.executable || !Array.isArray(row.depends_on) || row.depends_on.length !== 1 || typeof core.task.get !== 'function') return null;
  try {
    // The judged task and the chain of fixes it repairs, up to the work they began from, so the wake names that work.
    const m = new Map();
    let t = await core.task.get({ task_id: row.depends_on[0] });
    for (let n = 0; t && !m.has(t.id) && n < 100; n++) { m.set(t.id, t); t = t.repairs ? await core.task.get({ task_id: t.repairs }).catch(() => null) : null; }
    return m.size ? m : null;
  } catch { return null; }
}

// `forecasts` (optional): the conflict forecasts enrichWakes made, by `<task id>:<hand-back at>` (conflict-forecast.cjs).
function summaryOf(row, byId, forecasts) {
  const r = row.results || {};
  const fr = fixRoundsOf(row, byId);
  const fc = forecasts && typeof forecasts.get === 'function' && forecasts.get(`${row.id}:${row.handoff && row.handoff.at}`);
  const review = reviewWake.reviewOf(row); // a review whose verdict check was executable: its facts ride on the wake (review-wake.cjs)
  return { task_id: row.id, state: row.state, passed: !!r.passed, executable: !!r.executable, checks: ((r.checks) || []).length, failing: failedKinds(row), ...(review ? { review } : {}), ...(r.flaky ? { flaky: true } : {}), ...(r.uncommitted ? { uncommitted: true } : {}), ...(r.queued ? { queued: r.queued } : {}), ...(fr ? { fix_rounds: fr } : {}), ...(fc ? { forecast: fc } : {}) };
}

const unevaluated = (t, runId, workerId) => t.run_id === runId && t.state === 'released' && t.handoff && t.handoff.by === workerId && !t.handoff.stood_down
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

// A release evaluation that ends without writing a result leaves the hand-back released and unevaluated. The run process polls from
// another process and cannot see that, so the end is a ledger event (kind release_failed, ok 0, the code), the same cross-process
// path call_detached/call_ended use; enrichWakes reads it, drops the watched entry and tells the orchestrator. Best effort: a write
// that fails is dropped, and the entry is then forgotten by age once its worker is not live.
// The message carries the seq of the task's row current when the failure is written (best effort), so a plan amend after it is found by row order and not by clock.
function recordFailure(ctx, w, taskId, code, message, turn) {
  const rec = ctx.core && ctx.core.memory && ctx.core.memory.recordEvent;
  if (typeof rec !== 'function') return Promise.resolve();
  return Promise.resolve().then(async () => {
    let seq = null;
    try { const t = ctx.core.task && typeof ctx.core.task.get === 'function' ? await ctx.core.task.get({ task_id: taskId }) : null; if (t && Number.isFinite(Number(t.seq))) seq = Number(t.seq); } catch { /* the time comparison stands in */ }
    return rec({ kind: 'release_failed', ok: 0, code: String(code || 'E_INTERNAL'), worker_id: w.id, task_id: taskId, message: JSON.stringify({ turn, by: String(message || '').slice(0, 150), ...(seq == null ? {} : { seq }) }) });
  }).catch(() => {});
}

async function run(w, ctx, ev) {
  const core = ctx.core;
  const out = [];
  // One evaluation at a time per worker, in order: a hand-back released while this runs joins ev.task_ids (startRelease).
  for (ev.next = 0; ev.next < ev.task_ids.length; ev.next += 1) {
    const t = { id: ev.task_ids[ev.next] };
    if (ev.cancelled) { out.push({ task_id: t.id, cancelled: true, by: ev.cancelled }); recordFailure(ctx, w, t.id, 'E_CANCELLED', ev.cancelled, ev.turn); continue; }
    try {
      const row = await core.task.evaluate({ task_id: t.id, worktree: w.worktree, trigger: 'release', cancel_key: ev.key });
      out.push(summaryOf(row, await workOf(core, row)));
      // ADR 0058 decision 8: the stop waits for the worker's queue itself, and this is not on it.
      if (row.state === 'done' && ctx.stopIdleOnDone && ctx.manager && !ev.cancelled) { out[out.length - 1].stop_idle_on_done = true; w.idleStopping = ctx.manager.idleStop(row).then((r) => { if (r) w.idleStop = r; }, () => {}); }
    } catch (e) {
      const reason = e && e.detail && e.detail.reassigned ? 'the task was re-assigned while its checks ran' : (e && e.message) || e;
      recordFailure(ctx, w, t.id, e && e.detail && e.detail.cancelled ? 'E_CANCELLED' : (e && e.code) || 'E_INTERNAL', reason, ev.turn);
      out.push(e && e.detail && e.detail.cancelled ? { task_id: t.id, cancelled: true, by: e.detail.by || ev.cancelled }
        : { task_id: t.id, error: (e && e.code) || 'E_INTERNAL', message: String(reason).slice(0, 200) });
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
  const ev = { key: `release:${w.id}:${crypto.randomUUID()}`, ctx, turn: w.turns, task_ids: pending.slice(), next: 0, done: false, cancelled: null, promise: null, cancelSignal: null };
  ev.cancelSignal = new Promise((res) => { ev.signalCancel = res; }); // a wait holding on this evaluation stops holding when it is cancelled
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
  if (ev.signalCancel) ev.signalCancel();
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

// A forecast conflict as a tail of a passed clause, at most `spare` bytes: the first whole file names, then a count; never part of a name.
// A clean, unavailable or absent forecast says nothing, and neither does a conflict whose shortest form does not fit.
function conflictTail(e, spare) {
  const files = e.state === 'done' && e.forecast && Array.isArray(e.forecast.files) ? e.forecast.files : [];
  const n = files.length;
  for (let k = Math.min(3, n); k >= 0 && n; k -= 1) {
    const t = k ? `; forecast: conflicts with the integration branch in ${files.slice(0, k).join(', ')}${n > k ? ` +${n - k}` : ''}` : `; forecast: ${n} file${n === 1 ? '' : 's'} would conflict with the integration branch`;
    if (Buffer.byteLength(t, 'utf8') <= spare) return t;
  }
  return '';
}
// The evaluation clause, at most `room` bytes: " task T evaluated at release: passed, done." or "...: not done; failing: ...".
function clause(evs, room) {
  // An evaluation that waited for a slot (max_parallel_evaluations) says so: queued behind `ahead` others, `waited_ms` before it ran.
  const waited = (e) => (e.queued ? ` (queued behind ${e.queued.ahead}, waited ${Math.round(e.queued.waited_ms / 1000)} s)` : '');
  const parts = evs.map((e) => `${one(e)}${waited(e)}`);
  // The forecast tails take what room the bare clauses leave (the review render below is given room - 2, so they leave that too).
  let spare = room - 2 - Buffer.byteLength(` ${parts.join('; ')}.`, 'utf8');
  evs.forEach((e, i) => { const t = conflictTail(e, spare); parts[i] += t; spare -= Buffer.byteLength(t, 'utf8'); });
  function one(e) { return (e.stood_down ? `task ${e.task_id}: the worker stood down with no result (${e.stood_down}); nothing was evaluated`
    : e.error === 'E_BUSY' ? `task ${e.task_id} not evaluated at release: another evaluation of it is running`
    : e.error ? `task ${e.task_id} could not be evaluated at release (${e.error}); call task_evaluate to run it`
    : `task ${e.task_id} evaluated at release: ${e.state === 'done' ? `${e.flaky ? 'passed on a retry (flaky), done' : 'passed, done'}${e.uncommitted ? '; uncommitted changes: commit before integrate' : ''}` : `not done${e.fix_rounds ? `; fix rounds ${e.fix_rounds.used} of max ${e.fix_rounds.max}${e.fix_rounds.hard == null ? '' : `, hard cap ${e.fix_rounds.hard}`}` : ''}; failing: ${e.failing.join(', ') || 'no executable check'}`}`); }
  if (evs.some((e) => e.review)) {
    const body = reviewWake.render(parts, evs, room - 2);
    if (body) return ` ${body}.`;
    // Even the bare clauses do not fit: they are cut, but a review's findings and changed tree are still said.
    const flags = reviewWake.flagsOf(evs);
    return `${cut(` ${parts.join('; ')}`, room - 1 - Buffer.byteLength(flags, 'utf8'))}${flags}.`;
  }
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
// `workers` (the poll's worker rows, optional): a watched evaluation whose worker is live is not forgotten by age, because a queued release
// evaluation waits for its slot without bound (ADR 0061 amendment); it leaves `pending` when it lands, is no longer awaiting evaluation, or its worker is gone.
async function enrichWakes(core, runId, events, seen, { holdMs = 0, now = Date.now, workers = null, dataDir = null, forecaster = forecastTask, exitCeilingMs = FORECAST_EXIT_CEILING_MS, log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const pending = seen.pending || (seen.pending = new Map());
  const held = seen.held || (seen.held = new Map());
  if (!events.some((e) => e.event === 'turn_end' || e.event === 'death') && !pending.size && !held.size && !(seen.deathHeld && seen.deathHeld.size)) return events;
  let tasks = null;
  try { tasks = ((await core.task.list({})) || {}).tasks || []; } catch { /* nothing is attached and nothing lands this poll */ }
  if (!tasks) { const flushed = [...held.values()].map((h) => h.ev).concat([...(seen.deathHeld || new Map()).values()].map((h) => h.ev)); held.clear(); if (seen.deathHeld) seen.deathHeld.clear(); return flushed.concat(events); }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const PR = require('./policy-relaunch.cjs');
  const PW = require('./policy-wakes.cjs'); // ADR 0073: a task under a plan wakes on exceptions only, so its routine events are consumed here and not sent
  const polOf = (t) => PW.policyOf(t, byId);
  if (tasks.some((t) => t.run_id === runId && polOf(t))) { seen.policyArmed = true; seen.policyTasks = tasks; } // the policy watcher reads these rows this poll
  if (seen.policyArmed || (seen.deathHeld && seen.deathHeld.size)) events = await PR.holdDeaths({ core, runId, events, seen, tasks, byId, polOf, rootOf: (t) => PW.rootOf(t, byId), workers, dataDir, now }); // a dead builder the plan relaunches is not a wake unless the relaunch did not work (policy-relaunch.cjs)
  const landed = (t) => t.results && t.results.trigger === 'release' && seen.get(t.id) !== t.results.evaluated_at && (!t.handoff || Number(t.results.evaluated_at) >= Number(t.handoff.at));
  // The conflict forecast (a warning on the wake; it never gates anything) is started, never awaited, when a hand-back is first watched, so
  // it has usually settled when the evaluation lands; a wake carries it only if it has. One per hand-back, at most FORECASTS_MAX at once.
  const forecasts = seen.forecasts || (seen.forecasts = new Map());
  const kick = (t) => {
    const key = `${t.id}:${t.handoff && t.handoff.at}`;
    const started = seen.forecastStarted || (seen.forecastStarted = new Set());
    if (started.has(key) || (seen.forecastRunning || 0) >= FORECASTS_MAX) return;
    started.add(key); seen.forecastRunning = (seen.forecastRunning || 0) + 1;
    let p; try { p = Promise.resolve(forecaster(t, runId)); } catch { p = Promise.resolve(null); }
    // Running until its git calls have exited (`exited`, conflict-forecast.cjs), not just until it has an answer, so the cap stays honest.
    // The wait has a ceiling: a survivor holding the pipes after a timeout kill must not pin the slot for the life of the process.
    const free = () => { seen.forecastRunning -= 1; };
    const ceiling = (fc) => {
      const exited = fc && fc.exited;
      if (!exited) return undefined;
      let timer; const cut = new Promise((res) => { timer = setTimeout(() => {
        let live = [], kills = ''; try { live = fc.lingering ? fc.lingering() : []; } catch { /* the line stays without them */ }
        try { kills = (fc.killReports ? fc.killReports() : []).map((k) => ` [killTree of git ${String(k.argv).slice(0, 200)}: ${k.ms} ms, process snapshot ${k.snapshot_ms} ms]`).join(''); } catch { /* the line stays without them */ }
        const named = live.map((c) => ` [git ${String(c.argv).slice(0, 200)}, running ${c.ms} ms]`).join('');
        log(live.length ? `belay: conflict forecast of task ${t.id} still had git running ${exitCeilingMs} ms after its answer${named}${kills}; its slot is freed`
          : `belay: conflict forecast of task ${t.id} had not finished ${exitCeilingMs} ms after its answer, and no git child of it was alive (a git call's result or kill report was still pending)${kills}; its slot is freed`); res();
      }, exitCeilingMs); if (timer.unref) timer.unref(); });
      return Promise.race([exited, cut]).finally(() => clearTimeout(timer));
    };
    p.then((fc) => { if (fc) { forecasts.set(key, fc); recordForecast(core, runId, t, fc); } return ceiling(fc); }, () => { /* a forecast is optional */ }).then(free, free);
  };
  // A hand-back that was over the cap when first watched is started on a later poll, as slots free (kick marks only what it starts).
  for (const id of pending.keys()) { const t = byId.get(id); if (t && t.state === 'released') kick(t); }
  const fails = await releaseFailures(core, runId, seen, pending, held, events, tasks);
  // A failure ends the attempt of its own turn: a hand-back gets a new attempt after every cancel or error, so a failure from an earlier turn
  // (stale, not yet read) is not this attempt's. `turn` is the turn_end turn the attempt belongs to.
  const failedOf = (t, turn) => t.handoff && fails.find((f) => f.task_id === t.id && !seen.failedIds.has(f.id) && Number(f.written_at) >= Number(t.handoff.at) && !(Number(f.turn) < Number(turn)));
  const failure = (f) => { seen.failedIds.add(f.id); return f.code === 'E_CANCELLED' ? null : { task_id: f.task_id, error: f.code, seq: Number(f.seq) || 0 }; }; // a cancel is the lifecycle call's own doing: no wake
  const t0 = now();
  const liveWorkers = workers ? new Set(workers.filter((r) => r.run_id === runId && r.pid_alive === true && !["stopped", "dead", "paused"].includes(r.state)).map((r) => r.id)) : null;
  const out = [];
  // A held wake takes what has landed since; a hand-back no longer awaiting evaluation (cancelled, re-assigned) is dropped from it.
  const settle = (h) => {
    h.ids = h.ids.filter((id) => {
      const t = byId.get(id);
      if (t && landed(t)) { seen.set(id, t.results.evaluated_at); pending.delete(id); if (t.state === 'done') kick(t); h.evs.push(summaryOf(t, byId, forecasts)); return false; }
      const f = t && unevaluated(t, runId, h.ev.worker_id) && failedOf(t, h.ev.turn);
      if (f) { pending.delete(id); const s = failure(f); if (s) h.evs.push(s); return false; }
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
    const evs = []; const ing = []; let sawPolicy = false; const took = [];
    for (const t of tasks) {
      if (t.run_id !== runId || !t.handoff || t.handoff.by !== ev.worker_id) continue;
      if (t.handoff.stood_down) { const key = `${t.id}:${t.handoff.at}`; if (!(seen.stood = seen.stood || new Set()).has(key) && t.state === 'released') { seen.stood.add(key); evs.push({ task_id: t.id, stood_down: t.handoff.stood_down }); } continue; } // a stand-down is a fact for the wake, once
      const pol = polOf(t);
      if (!pol) { const x = PW.unplannedEscalation(t); if (x && !(seen.escalated = seen.escalated || new Set()).has(x.uid)) { seen.escalated.add(x.uid); out.push(PW.wakeOf(x)); } } // ADR 0074 amendment 4: an escalation wakes for a task under no plan too; a planned one is the policy watcher's
      if (pol && (landed(t) || unevaluated(t, runId, ev.worker_id))) { sawPolicy = true; took.push(t.id); }
      if (landed(t)) { seen.set(t.id, t.results.evaluated_at); pending.delete(t.id); if (t.state === 'done') kick(t); if (!pol) evs.push(summaryOf(t, byId, forecasts)); } else if (unevaluated(t, runId, ev.worker_id) && failedOf(t, ev.turn)) { const s = failure(failedOf(t, ev.turn)); if (s && !pol) evs.push(s); } else if (unevaluated(t, runId, ev.worker_id)) { pending.set(t.id, { worker_id: ev.worker_id, since: t0, turn: ev.turn }); if (!pol) ing.push(t.id); kick(t); }
    }
    if (sawPolicy && !evs.length && !ing.length) { (seen.absorbed || (seen.absorbed = [])).push({ worker_id: ev.worker_id, task_ids: took }); continue; } // the turn end of a hand-back of a task under a plan is routine; a turn end with no hand-back is not, and wakes as before. stall-wake.cjs reads `absorbed`
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
      if (t.state === 'done') kick(t); // a forecast is kicked for a task under a plan too
      if (polOf(t)) continue;
      if (!follow.has(p.worker_id)) follow.set(p.worker_id, []);
      follow.get(p.worker_id).push(summaryOf(t, byId, forecasts));
    } else if (t && unevaluated(t, runId, p.worker_id) && failedOf(t, p.turn)) {
      pending.delete(id);
      const s = failure(failedOf(t, p.turn));
      if (s && !polOf(t)) { if (!follow.has(p.worker_id)) follow.set(p.worker_id, []); follow.get(p.worker_id).push(s); }
    } else if (!t || !unevaluated(t, runId, p.worker_id) || (t0 - p.since > PENDING_MAX_MS && !(liveWorkers && liveWorkers.has(p.worker_id)))) pending.delete(id);
  }
  for (const [wid, evs] of follow) {
    const head = `belay: worker ${wid}'s hand-back:`;
    const text = cut(`${head}${clause(evs, WAKE_TEXT_MAX - Buffer.byteLength(head, 'utf8'))}`, WAKE_TEXT_MAX);
    const seq = Math.max(...evs.map((e) => Number(seen.get(e.task_id)) || Number(e.seq) || 0));
    out.push({ event: 'evaluated', worker_id: `eval:${evs[0].task_id}`, turn: 0, seq, task_id: evs[0].task_id, ...(evs.length > 1 ? { task_ids: evs.map((e) => e.task_id) } : {}), text });
  }
  return out;
}

// The receipt of a settled forecast: a ledger event (kind release_forecast), once per forecast, whether or not a wake carried it.
// Best effort, like release_failed: a write that fails is dropped.
function recordForecast(core, runId, t, fc) {
  const rec = core && core.memory && core.memory.recordEvent;
  if (typeof rec !== 'function') return;
  const body = { task_id: t.id, handoff_at: t.handoff && t.handoff.at, ...(Array.isArray(fc.files) ? { files: fc.files.slice(0, 20) } : {}), ...(fc.clean ? { clean: true } : {}), ...(fc.unavailable ? { unavailable: String(fc.unavailable).slice(0, 150) } : {}), against: fc.against == null ? null : fc.against, ms: fc.ms };
  Promise.resolve().then(() => rec({ kind: 'release_forecast', run_id: runId, worker_id: t.handoff && t.handoff.by, task_id: t.id, ...(fc.unavailable ? { ok: 0, code: 'E_FORECAST_UNAVAILABLE' } : { ok: 1 }), message: JSON.stringify(body) })).catch(() => {});
}

// The release_failed events of this run, read only when a hand-back is awaiting its evaluation (nothing is read otherwise).
async function releaseFailures(core, runId, seen, pending, held, events, tasks) {
  if (!seen.failedIds) seen.failedIds = new Set();
  const awaiting = pending.size || held.size || (events.some((e) => e.event === 'turn_end') && tasks.some((t) => t.run_id === runId && t.state === 'released' && t.handoff));
  if (!awaiting || !core.memory || typeof core.memory.events !== 'function') return [];
  try { return (((await core.memory.events({ run_id: runId, kinds: ['release_failed'] })) || {}).events || []).filter((e) => e.kind === 'release_failed').map((e) => { let m = {}; try { m = JSON.parse(e.message) || {}; } catch { /* no turn */ } return { ...e, turn: m.turn !== undefined ? m.turn : e.turn }; }); } catch { return []; }
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

// The turn_end wakes still held for their evaluation when a run ends, removed from `seen.held`: the caller records each as
// suppressed with its reason, so no wake found is left out of the receipt.
function drainHeld(seen) {
  const held = seen && seen.held;
  if (!held || !held.size) return [];
  const evs = [...held.values()].map((h) => h.ev);
  held.clear();
  return evs;
}

module.exports = { __recordFailure: recordFailure, unevaluated, notePending, evaluatingHolds, drainHeld, startRelease, cancelEvaluation, evalOf, enrichWakes, clause, turnEndText, summaryOf, workOf, cut, holdMs, WAKE_TEXT_MAX, PENDING_MAX_MS, RELEASE_WAKE_HOLD_MS };
