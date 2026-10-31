'use strict';
// budget-guard.cjs — run and task budgets in the run process. Built like the embedder guard (embedder-guard.cjs): the owner's
// usage.record hook (onUsageRecorded) and the headless orchestrator's turn ends feed it; a breach calls the run pause's own
// pause with a reason, so `paused_by` reads `operator:<pid> [budget (...)]` on the run row and on every park.
//
// Every figure is the cost the substrate reported (belay bills nothing), unless the run's lever budget_counts_in_flight is on: then the
// estimate of the turns in flight (inflight-cost.cjs, labelled) is added to what the guard compares, and the pause says so. Codex turns report no dollars: they are counted as unknown and the text
// says "at least". The guard pauses at SOFT_THRESHOLD of a limit because a turn's spend is seen only when the turn ends.
// With no limit anywhere nothing here runs: no query, no write. A resume of a budget pause is refused unless it raises the
// breached limit or overrides it; each is recorded on the run row's `budget` column (operator only: run.resume answers only the operator).
// The guard treats a pause as its own only when the run row's paused_by carries its reason; a pause another caller holds is theirs,
// and every resume that is not a budget resume clears what the guard believed and checks the budget again.

const { SOFT_THRESHOLD } = require('../core/run-budget.cjs');
const { createAccumulator, createTracker } = require('../core/inflight-cost.cjs');

const BUDGET_PAUSE = /\[budget [(]/;
const TICK_MS = 2000; // the least gap between two reads of the live workers' streams and two in-flight checks
const PUBLISH_STEP_USD = 0.05; // the least move of the published in-flight figure that is written, or this fraction of it if larger
const PUBLISH_STEP_FRACTION = 0.05;
const usd = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
const isBudgetPause = (pausedBy) => BUDGET_PAUSE.test(String(pausedBy || ''));
const argError = (message, detail) => Object.assign(new Error(message), { code: 'E_ARGS', detail });

// The wake text: facts only, at most `max` bytes (the interactive wake budget). Longest form first. In an interactive run the
// orchestrator is the user's own session: the text asks the user to decide and does not hand the session the raise command.
function wakeTextOf({ runId, scope, taskId, spent, limit, unknown, interactive = false, inFlight = false }, max = 221) {
  const where = scope === 'task' ? `task ${taskId}` : 'run';
  const amount = `${unknown ? 'at least ' : ''}${usd(spent)} of ${usd(limit)} reported${inFlight ? ' + in flight (estimate)' : ''}`;
  const forms = interactive ? [
    `belay: ${where} budget reached (${amount}); run ${runId} is paused. Ask your user to raise the budget or override it with belay resume ${runId}`,
    `belay: ${where} budget reached (${amount}); run paused. Ask your user to raise or override it`,
    `belay: ${where} budget reached (${amount}); run paused. Ask your user`,
    'belay: budget reached; run paused. Ask your user',
  ] : [
    `belay: ${where} budget reached (${amount}); run ${runId} is paused. Wait for the operator's resume, which raises the budget or overrides it`,
    `belay: ${where} budget reached (${amount}); run paused. Wait for the operator's resume`,
    `belay: ${where} budget reached (${amount}); run paused`,
    'belay: budget reached; run paused',
  ];
  return forms.find((t) => Buffer.byteLength(t, 'utf8') <= max) || forms[forms.length - 1];
}

function createBudgetGuard({ core, runId, runLimit = null, source = null, pauseRun, interactive = false, record = null, warn = null, countInFlight = false, tickMs = TICK_MS, dataDir = null }) {
  let limit = runLimit;
  const taskLimits = new Map();
  const overrides = { run: false, tasks: new Set() };
  let open = null; // the breach the run is paused for: { scope, task_id }
  let lastAuth = null; // the breach a resume was authorised for, kept so a retry of a resume that failed afterwards can succeed
  const orch = { base: 0, last: 0, inFlight: 0 };
  const acc = createAccumulator(); // the headless orchestrator's turn in flight, priced from its stream lines as they arrive
  const workers = dataDir ? createTracker({ dataDir }) : { update() {}, figures: () => ({ usd: 0, by_worker: {}, partial: [], unpriced: [] }) }; // the live workers' turns in flight
  let lastTick = 0; let lastRead = 0;
  let published = { total: 0, key: '[[],[]]' };
  const rec = record && typeof record === 'object' ? record : { source, soft_threshold: SOFT_THRESHOLD, events: [] };
  let chain = Promise.resolve();
  const pending = new Set();
  const wakes = [];
  let wakeSeq = 0;

  const orchSpend = () => (interactive ? 0 : orch.base + orch.last);
  // What the run row's budget record says about the orchestrator's part, so status shows the figure the guard pauses on.
  const orchRecord = () => (interactive ? { counted: false, why: 'an interactive session is not counted; belay agents prices its transcript' } : { counted: true, usd: orchSpend(), base: orch.base, last: orch.last, in_flight_usd: orch.inFlight });
  const active = () => limit != null || taskLimits.size > 0;
  rec.counts_in_flight = countInFlight; // status reads it from the run row's record
  // The run's spend as the guard counts it: the ledger and the orchestrator's reported cost, plus the in-flight estimate when the lever is on.
  async function runSpent() {
    const s = await core.usage.spend({});
    const fl = countInFlight && !interactive ? orch.inFlight + workers.figures().usd : 0;
    return { s, total: s.usd + orchSpend() + fl, inFlight: fl };
  }
  const ownPause = (row) => isBudgetPause(row && row.paused_by);

  async function flush() { await core.run.setBudget({ budget: rec }); }
  if (limit != null && typeof warn === 'function') warn('belay: this run has a budget. Codex turns report no dollars, so they count as unknown (shown as "at least"), never as free; the run budget cannot bind a Codex-only run.\n');

  // A re-attach of the same life: what an earlier run process recorded (a raised limit, overrides, task limits) is kept, not reset.
  // The task limits come first from the task rows (task.budget_usd, which can be stale after a raise), read once and only when the run's
  // ledger is on; the run row's budget record is applied on top and wins, as the live limit (status and the record read it).
  async function loadAttach(runRow) {
    if (!runRow || typeof runRow !== 'object') return;
    if (require('../core/run-budget.cjs').ledgerOn(runRow)) {
      try { for (const t of ((await core.task.list({})) || {}).tasks || []) if (t.run_id === runId && t.budget_usd > 0) taskLimits.set(t.id, t.budget_usd); } catch { /* the record below still applies */ }
    }
    const b = runRow.budget && typeof runRow.budget === 'object' ? runRow.budget : null;
    if (!b) { if (countInFlight) await flush().catch(() => {}); return; } // the lever is part of the record status reads
    const stale = !!(b.in_flight_workers || (b.orchestrator && b.orchestrator.in_flight_usd));
    Object.assign(rec, b);
    rec.counts_in_flight = countInFlight; // this life's lever, not a record from an earlier one
    orch.inFlight = 0; rec.in_flight_workers = null; if (rec.orchestrator) rec.orchestrator.in_flight_usd = 0; // a figure the earlier life left is not this life's
    if (!interactive && b.orchestrator && b.orchestrator.counted === true) { orch.base = (Number(b.orchestrator.base) || 0) + (Number(b.orchestrator.last) || 0); orch.last = 0; } // a new run process has a new orchestrator process: its own count starts over
    if (!Array.isArray(rec.events)) rec.events = [];
    if (runRow.budget_usd != null) limit = runRow.budget_usd;
    if (b.overrides) { overrides.run = !!b.overrides.run; for (const t of b.overrides.tasks || []) overrides.tasks.add(t); }
    for (const [id, v] of Object.entries(b.tasks || {})) taskLimits.set(id, v);
    if (countInFlight || stale) await flush().catch(() => {});
  }

  async function check(taskId) {
    if (open) return;
    const c = { scope: null };
    if (limit != null && !overrides.run) {
      const { s, total, inFlight } = await runSpent();
      if (total >= SOFT_THRESHOLD * limit) Object.assign(c, { scope: 'run', limit, spent: total, unknown: s.unknown_turns, inFlight: inFlight > 0 });
    }
    if (!c.scope && taskId && taskLimits.has(taskId) && !overrides.tasks.has(taskId)) {
      const s = await core.usage.spend({ task_id: taskId });
      if (s.usd >= SOFT_THRESHOLD * taskLimits.get(taskId)) Object.assign(c, { scope: 'task', task_id: taskId, limit: taskLimits.get(taskId), spent: s.usd, unknown: s.unknown_turns });
    }
    if (!c.scope) return;
    open = { scope: c.scope, task_id: c.task_id || null };
    lastAuth = null;
    const why = `budget (${c.scope === 'task' ? `task ${c.task_id}` : 'run'}, ${usd(c.spent)} of ${usd(c.limit)} reported${c.inFlight ? ' + in flight (estimate)' : ''})`;
    try { await pauseRun(why); } catch (e) { open = null; rec.events.push({ type: 'pause_failed', at: Date.now(), scope: c.scope, message: (e && e.message) || String(e) }); await flush().catch(() => {}); return; }
    // The pause is ours only if the row carries our reason. pause() hands back a pause already in flight, whoever started it; if that is
    // an operator's or the embedder guard's, it is theirs, the guard must not wait for a budget resume that will never come, and the
    // next row or resume checks again.
    let now = null; let rowRead = true;
    try { now = ((await core.run.get()) || {}).run || null; } catch { rowRead = false; } // the pause landed (pauseRun resolved): an unreadable row keeps the breach open and says so
    if (rowRead && !ownPause(now)) { open = null; return; }
    // Measured again after the parks settled: the turns in flight when the threshold was crossed still added theirs.
    const detail = await core.usage.spend({ detail: true });
    const after = c.scope === 'task' ? (await core.usage.spend({ task_id: c.task_id })).usd : (await runSpent()).total; // the parks settled: what is still in flight is counted when the lever is on
    const ev = {
      type: 'pause', at: Date.now(), scope: c.scope, ...(c.task_id ? { task_id: c.task_id } : {}), limit: c.limit, spent: c.spent, spent_after_parks: after,
      first_seq: detail.first_seq, last_seq: detail.last_seq, per_worker: detail.per_worker, per_task: detail.per_task, unknown_turns: detail.unknown_turns, unknown_workers: detail.unknown_workers,
      orchestrator: orchRecord(),
      basis: countInFlight ? 'reported + in flight (estimate)' : 'reported', ...(countInFlight ? { in_flight_usd: (await runSpent()).inFlight } : {}), ...(rowRead ? {} : { run_row_unreadable: true }),
    };
    rec.events.push(ev);
    await flush().catch(() => {});
    wakes.push({ id: `${runId}:budget:${++wakeSeq}`, text: wakeTextOf({ runId, scope: c.scope, taskId: c.task_id, spent: after, limit: c.limit, unknown: detail.unknown_turns > 0, interactive, inFlight: !!c.inFlight }) });
  }

  function schedule(taskId) {
    if (!active()) return undefined;
    const p = chain.then(() => check(taskId)).catch(() => {});
    chain = p;
    pending.add(p);
    p.then(() => pending.delete(p));
    return p;
  }

  // The owner's usage.record hook: a row was written. Does nothing when no limit is set.
  // With the lever on, the worker's stream is read first: its turn just ended, so the `result` line must empty its estimate before the
  // reported cost (now in the ledger) is compared, or the turn would be counted twice until the next tick.
  function onUsage(row) {
    if (countInFlight && !interactive && dataDir && row && typeof row.worker_id === 'string') workers.refresh(row.worker_id);
    return schedule(row && row.task_id ? row.task_id : null);
  }
  function onTaskBudget({ task_id: id, budget_usd: usdLimit }) {
    if (!id || !(usdLimit > 0)) return;
    taskLimits.set(id, usdLimit);
    rec.tasks = { ...(rec.tasks || {}), [id]: usdLimit };
    Promise.resolve().then(flush).catch(() => {}); // the record on the run row is what a restarted run process loads
  }
  // The headless orchestrator's cumulative cost after a turn (a lower figure than the last is a new process: its own count starts over).
  function noteOrchestratorCost(cost) {
    if (interactive || typeof cost !== 'number' || !Number.isFinite(cost) || limit == null) return undefined;
    if (cost < orch.last) orch.base += orch.last;
    orch.last = cost; orch.inFlight = 0; // the turn ended: its reported cost replaces the estimate
    publish(); // the run row carries it for status and for a restarted run process; the in-flight figure goes with it
    return schedule(null);
  }

  // What the run row's record carries about turns in flight, and one write of it. Written only when the figure moved by a material
  // step (the larger of PUBLISH_STEP_USD and PUBLISH_STEP_FRACTION of the last published figure), when it fell to zero, or when the set
  // of partial streams changed; an unchanged figure, and zero staying zero, write nothing (each write is a new run-row version).
  function publish() {
    const wk = workers.figures();
    const total = orch.inFlight + wk.usd;
    rec.orchestrator = orchRecord();
    rec.in_flight_workers = { usd: wk.usd, by_worker: wk.by_worker, partial: wk.partial, unpriced: wk.unpriced };
    published = { total, key: JSON.stringify([wk.partial, wk.unpriced]) };
    Promise.resolve().then(flush).catch(() => {});
  }
  function maybePublish() {
    const wk = workers.figures();
    const total = orch.inFlight + wk.usd;
    const key = JSON.stringify([wk.partial, wk.unpriced]);
    const step = Math.max(PUBLISH_STEP_USD, PUBLISH_STEP_FRACTION * published.total);
    const moved = Math.abs(total - published.total) >= step || (total === 0 && published.total !== 0) || (key !== published.key && total > 0);
    if (moved) publish();
  }

  // One line of the headless orchestrator's stream, fed as it arrives: a running sum, then the throttled pulse.
  function noteOrchestratorLine(line) {
    if (interactive || limit == null) return undefined;
    acc.feed(line);
    const snap = acc.snapshot();
    orch.inFlight = snap && typeof snap.usd === 'number' ? snap.usd : 0;
    return tick();
  }

  // The run's own timer-free pulse (the orchestrator's poll, with its worker rows, and its stream lines call it), at most once per tickMs:
  // reads the next bytes of each live worker's stream (the only place a stream is read), publishes a figure that moved materially, and
  // with the lever on checks the budget. A run with no limit does nothing; an interactive run has no tick.
  function tick(rows) {
    if (interactive || !active()) return undefined;
    const now = Date.now();
    // The worker read has its own slot: a tick fired by an orchestrator line carries no rows, and must not use up the poll's slot.
    if (Array.isArray(rows) && dataDir && now - lastRead >= tickMs) { lastRead = now; workers.update(rows); }
    if (now - lastTick < tickMs) return undefined;
    lastTick = now;
    maybePublish();
    return countInFlight ? schedule(null) : undefined;
  }

  // Called when a resume has settled (run-pause's afterResume): the budget is checked again, so a run still over its limit pauses again
  // instead of running free. No timer: nothing outlives the run, and the check joins the guard's own chain (settled() waits for it).
  function recheck() { for (const id of [null, ...taskLimits.keys()]) schedule(id); }

  // run-pause's beforeResume: a budget pause resumes only with a raised limit for what was breached, or an override. Recorded on the row.
  async function authorizeResume(row, params) {
    if (!ownPause(row)) { open = null; lastAuth = null; return null; }
    const p = params || {};
    const who = `${(p.caller && p.caller.role) || 'operator'}:${(p.caller && p.caller.pid) || '?'}`;
    const b = open || lastAuth || { scope: 'run', task_id: null };
    const sameScope = (e) => e.scope === b.scope && (e.task_id || null) === (b.task_id || null);
    const hint = b.scope === 'task' ? `belay resume ${runId} --task-budget ${b.task_id} <usd>` : `belay resume ${runId} --budget <usd>`;
    const given = [p.budget != null, p.task_budget != null, p.over_budget === true].filter(Boolean).length;
    if (given === 0) throw argError(`run ${runId} is paused because ${b.scope === 'task' ? `task ${b.task_id}` : 'the run'} reached its budget; resume with a raised limit (${hint}) or with --over-budget (the limit is then no longer enforced for the rest of the run)`, { budget_pause: true, scope: b.scope });
    if (given > 1) throw argError('give one of --budget, --task-budget and --over-budget', { budget_pause: true });
    const at = Date.now();
    const done = (ev) => { lastAuth = b; open = null; return ev; };
    if (p.over_budget === true) {
      const prior = [...rec.events].reverse().find((e) => e.type === 'override' && sameScope(e));
      if (prior && lastAuth) return done(prior); // a retry of a resume that failed after this was recorded
      if (b.scope === 'task') overrides.tasks.add(b.task_id); else overrides.run = true;
      const ev = { type: 'override', at, by: who, scope: b.scope, ...(b.task_id ? { task_id: b.task_id } : {}), override: true, old: b.scope === 'task' ? taskLimits.get(b.task_id) : limit };
      rec.events.push(ev); rec.overrides = { run: overrides.run, tasks: [...overrides.tasks] };
      await flush(); return done(ev);
    }
    const isTask = p.task_budget != null;
    if (isTask !== (b.scope === 'task')) throw argError(`the run is paused for ${b.scope === 'task' ? `task ${b.task_id}` : 'the run'}: ${hint}, or --over-budget`, { budget_pause: true, scope: b.scope });
    const tb = isTask ? p.task_budget : null;
    if (isTask && tb.task_id !== b.task_id) throw argError(`the budget that was reached is task ${b.task_id}'s, not ${tb.task_id}'s: ${hint}`, { budget_pause: true, scope: b.scope });
    const next = isTask ? tb.usd : p.budget;
    if (typeof next !== 'number' || !Number.isFinite(next) || next <= 0) throw argError('the raised budget must be a positive number (dollars at API rates)', { budget_pause: true });
    const prior = [...rec.events].reverse().find((e) => e.type === 'raise' && sameScope(e));
    if (prior && lastAuth && prior.new === next) return done(prior); // the same raise again after a resume that failed: it already holds
    const spent = b.scope === 'task' ? (await core.usage.spend({ task_id: b.task_id })).usd : (await runSpent()).total;
    const need = spent / SOFT_THRESHOLD;
    const old = isTask ? taskLimits.get(b.task_id) : limit;
    if (!(next > old)) throw argError(`the raised budget ${usd(next)} is not above the current limit ${usd(old)}`, { budget_pause: true, limit: old });
    if (!(next > need)) throw argError(`the raised budget ${usd(next)} is below the reported spend (${usd(spent)}) over the ${SOFT_THRESHOLD * 100}% threshold at which the run pauses; give more than ${usd(need)}`, { budget_pause: true, spent, minimum: need });
    if (isTask) { taskLimits.set(b.task_id, next); rec.tasks = { ...(rec.tasks || {}), [b.task_id]: next }; }
    else { limit = next; await core.run.setBudget({ budget_usd: next }); }
    const ev = { type: 'raise', at, by: who, scope: b.scope, ...(b.task_id ? { task_id: b.task_id } : {}), old, new: next };
    rec.events.push(ev);
    await flush(); return done(ev);
  }

  return {
    onUsage, onTaskBudget, noteOrchestratorCost, noteOrchestratorLine, tick, authorizeResume, loadAttach, recheck, active,
    // the one wake a budget pause sends, taken once; the orchestrator's launcher writes it past the run's hold
    takeWakes() { return wakes.splice(0).map((w) => ({ event: 'budget_pause', worker_id: `budget:${runId}`, turn: 0, seq: 0, id: w.id, text: w.text, unheld: true })); },
    settled: () => Promise.all([...pending]).then(() => undefined),
    state: () => ({ limit, tasks: Object.fromEntries(taskLimits), overrides: { run: overrides.run, tasks: [...overrides.tasks] }, open, record: rec }),
  };
}

module.exports = { createBudgetGuard, wakeTextOf, isBudgetPause, BUDGET_PAUSE };
