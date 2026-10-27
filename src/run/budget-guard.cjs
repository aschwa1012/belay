'use strict';
// budget-guard.cjs — run and task budgets in the run process. Built like the embedder guard (embedder-guard.cjs): the owner's
// usage.record hook (onUsageRecorded) and the headless orchestrator's turn ends feed it; a breach calls the run pause's own
// pause with a reason, so `paused_by` reads `operator:<pid> [budget (...)]` on the run row and on every park.
//
// Every figure is an estimate (belay bills nothing). Codex turns report no dollars: they are counted as unknown and the text
// says "at least". The guard pauses at SOFT_THRESHOLD of a limit because a turn's spend is seen only when the turn ends.
// With no limit anywhere nothing here runs: no query, no write. A resume of a budget pause is refused unless it raises the
// breached limit or overrides it; each is recorded on the run row's `budget` column (operator only: run.resume answers only the operator).

const { SOFT_THRESHOLD } = require('../core/run-budget.cjs');

const BUDGET_PAUSE = /\[budget [(]/;
const usd = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
const isBudgetPause = (pausedBy) => BUDGET_PAUSE.test(String(pausedBy || ''));
const argError = (message, detail) => Object.assign(new Error(message), { code: 'E_ARGS', detail });

// The wake text: facts only, at most `max` bytes (the interactive wake budget). Longest form first; the resume commands give way last.
function wakeTextOf({ runId, scope, taskId, spent, limit, unknown }, max = 221) {
  const where = scope === 'task' ? `task ${taskId}` : 'run';
  const amount = `${unknown ? 'at least ' : ''}${usd(spent)} of ${usd(limit)} est.`;
  const forms = [
    `belay: ${where} budget reached (${amount}); run ${runId} is paused. Resume: belay resume ${runId} ${scope === 'task' ? '--task-budget <task> <usd>' : '--budget <usd>'} or --over-budget`,
    `belay: ${where} budget reached (${amount}); run paused. belay resume ${runId} with a raised budget or --over-budget`,
    `belay: ${where} budget reached (${amount}); run paused`,
    'belay: budget reached; run paused',
  ];
  return forms.find((t) => Buffer.byteLength(t, 'utf8') <= max) || forms[forms.length - 1];
}

function createBudgetGuard({ core, runId, runLimit = null, source = null, pauseRun, interactive = false, record = null }) {
  let limit = runLimit;
  const taskLimits = new Map();
  const overrides = { run: false, tasks: new Set() };
  let open = null; // the breach the run is paused for: { scope, task_id }
  const orch = { base: 0, last: 0 };
  const rec = record && typeof record === 'object' ? record : { source, soft_threshold: SOFT_THRESHOLD, events: [] };
  let chain = Promise.resolve();
  const pending = new Set();
  const wakes = [];
  let wakeSeq = 0;

  const orchSpend = () => (interactive ? 0 : orch.base + orch.last);
  const active = () => limit != null || taskLimits.size > 0;

  async function flush() { await core.run.setBudget({ budget: rec }); }

  async function check(taskId) {
    if (open) return;
    const c = { scope: null };
    if (limit != null && !overrides.run) {
      const s = await core.usage.spend({});
      const total = s.usd + orchSpend();
      if (total >= SOFT_THRESHOLD * limit) Object.assign(c, { scope: 'run', limit, spent: total, unknown: s.unknown_turns });
    }
    if (!c.scope && taskId && taskLimits.has(taskId) && !overrides.tasks.has(taskId)) {
      const s = await core.usage.spend({ task_id: taskId });
      if (s.usd >= SOFT_THRESHOLD * taskLimits.get(taskId)) Object.assign(c, { scope: 'task', task_id: taskId, limit: taskLimits.get(taskId), spent: s.usd, unknown: s.unknown_turns });
    }
    if (!c.scope) return;
    open = { scope: c.scope, task_id: c.task_id || null };
    const why = `budget (${c.scope === 'task' ? `task ${c.task_id}` : 'run'}, ${usd(c.spent)} of ${usd(c.limit)} est.)`;
    let paused;
    try { paused = await pauseRun(why); } catch (e) { open = null; rec.events.push({ type: 'pause_failed', at: Date.now(), scope: c.scope, message: (e && e.message) || String(e) }); await flush().catch(() => {}); return; }
    if (paused && paused.already) { open = null; return; } // someone else's pause holds the run; a later turn checks again after it resumes
    // Measured again after the parks settled: the turns in flight when the threshold was crossed still added theirs.
    const detail = await core.usage.spend({ detail: true });
    const after = c.scope === 'task' ? (await core.usage.spend({ task_id: c.task_id })).usd : detail.usd + orchSpend();
    const ev = {
      type: 'pause', at: Date.now(), scope: c.scope, ...(c.task_id ? { task_id: c.task_id } : {}), limit: c.limit, spent: c.spent, spent_after_parks: after,
      first_seq: detail.first_seq, last_seq: detail.last_seq, per_worker: detail.per_worker, per_task: detail.per_task, unknown_turns: detail.unknown_turns, unknown_workers: detail.unknown_workers,
      orchestrator: interactive ? { counted: false, why: 'an interactive session is not counted; belay agents prices its transcript' } : { counted: true, usd: orchSpend() },
      estimate: true,
    };
    rec.events.push(ev);
    await flush().catch(() => {});
    wakes.push({ id: `${runId}:budget:${++wakeSeq}`, text: wakeTextOf({ runId, scope: c.scope, taskId: c.task_id, spent: after, limit: c.limit, unknown: detail.unknown_turns > 0 }) });
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
  function onUsage(row) { return schedule(row && row.task_id ? row.task_id : null); }
  function onTaskBudget({ task_id: id, budget_usd: usdLimit }) { if (id && usdLimit > 0) { taskLimits.set(id, usdLimit); rec.tasks = { ...(rec.tasks || {}), [id]: usdLimit }; } }
  // The headless orchestrator's cumulative cost after a turn (a lower figure than the last is a new process: its own count starts over).
  function noteOrchestratorCost(cost) {
    if (interactive || typeof cost !== 'number' || !Number.isFinite(cost) || limit == null) return undefined;
    if (cost < orch.last) orch.base += orch.last;
    orch.last = cost;
    return schedule(null);
  }

  // run-pause's beforeResume: a budget pause resumes only with a raised limit for what was breached, or an override. Recorded on the row.
  async function authorizeResume(row, params) {
    if (!isBudgetPause(row && row.paused_by)) return null;
    const p = params || {};
    const who = `${(p.caller && p.caller.role) || 'operator'}:${(p.caller && p.caller.pid) || '?'}`;
    const b = open || { scope: 'run', task_id: null };
    const hint = b.scope === 'task' ? `belay resume ${runId} --task-budget ${b.task_id} <usd>` : `belay resume ${runId} --budget <usd>`;
    const given = [p.budget != null, p.task_budget != null, p.over_budget === true].filter(Boolean).length;
    if (given === 0) throw argError(`run ${runId} is paused because ${b.scope === 'task' ? `task ${b.task_id}` : 'the run'} reached its estimated budget; resume with a raised limit (${hint}) or with --over-budget (the limit is then no longer enforced for the rest of the run)`, { budget_pause: true, scope: b.scope });
    if (given > 1) throw argError('give one of --budget, --task-budget and --over-budget', { budget_pause: true });
    const at = Date.now();
    if (p.over_budget === true) {
      if (b.scope === 'task') overrides.tasks.add(b.task_id); else overrides.run = true;
      const ev = { type: 'override', at, by: who, scope: b.scope, ...(b.task_id ? { task_id: b.task_id } : {}), override: true, old: b.scope === 'task' ? taskLimits.get(b.task_id) : limit };
      rec.events.push(ev); rec.overrides = { run: overrides.run, tasks: [...overrides.tasks] };
      await flush(); open = null; return ev;
    }
    const spent = b.scope === 'task' ? (await core.usage.spend({ task_id: b.task_id })).usd : (await core.usage.spend({})).usd + orchSpend();
    const need = spent / SOFT_THRESHOLD;
    const isTask = p.task_budget != null;
    if (isTask !== (b.scope === 'task')) throw argError(`the run is paused for ${b.scope === 'task' ? `task ${b.task_id}` : 'the run'}: ${hint}, or --over-budget`, { budget_pause: true, scope: b.scope });
    const tb = isTask ? p.task_budget : null;
    if (isTask && tb.task_id !== b.task_id) throw argError(`the budget that was reached is task ${b.task_id}'s, not ${tb.task_id}'s: ${hint}`, { budget_pause: true, scope: b.scope });
    const next = isTask ? tb.usd : p.budget;
    const old = isTask ? taskLimits.get(b.task_id) : limit;
    if (typeof next !== 'number' || !Number.isFinite(next) || next <= 0) throw argError('the raised budget must be a positive number (estimated dollars)', { budget_pause: true });
    if (!(next > old)) throw argError(`the raised budget ${usd(next)} is not above the current limit ${usd(old)}`, { budget_pause: true, limit: old });
    if (!(next > need)) throw argError(`the raised budget ${usd(next)} is below the estimated spend (${usd(spent)}) over the ${SOFT_THRESHOLD * 100}% threshold at which the run pauses; give more than ${usd(need)}`, { budget_pause: true, spent, minimum: need });
    if (isTask) { taskLimits.set(b.task_id, next); rec.tasks = { ...(rec.tasks || {}), [b.task_id]: next }; }
    else { limit = next; await core.run.setBudget({ budget_usd: next }); }
    const ev = { type: 'raise', at, by: who, scope: b.scope, ...(b.task_id ? { task_id: b.task_id } : {}), old, new: next };
    rec.events.push(ev);
    await flush(); open = null; return ev;
  }

  return {
    onUsage, onTaskBudget, noteOrchestratorCost, authorizeResume, active,
    // the one wake a budget pause sends, taken once; the orchestrator's launcher writes it past the run's hold
    takeWakes() { return wakes.splice(0).map((w) => ({ event: 'budget_pause', worker_id: `budget:${runId}`, turn: 0, seq: 0, id: w.id, text: w.text, unheld: true })); },
    settled: () => Promise.all([...pending]).then(() => undefined),
    state: () => ({ limit, tasks: Object.fromEntries(taskLimits), overrides: { run: overrides.run, tasks: [...overrides.tasks] }, open, record: rec }),
  };
}

module.exports = { createBudgetGuard, wakeTextOf, isBudgetPause, BUDGET_PAUSE };
