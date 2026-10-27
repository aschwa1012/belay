'use strict';
// run-budget.cjs — run and task budgets (estimated dollars, off unless a limit is set). The store half: limit checks, the
// spend sums over the usage ledger, the task a turn is charged to, the status block, and the two methods the run process
// uses (run.setBudget, usage.spend). Pure of the run manager: the guard that pauses a run lives in src/run/budget-guard.cjs.
// Every figure is an estimate: belay bills nothing, and a dollar is what the substrate reports at API rates.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');

// The share of a limit at which the guard pauses (the turns in flight still add theirs after it).
const SOFT_THRESHOLD = 0.9;

const isLimit = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
function checkLimit(v, what) {
  if (!isLimit(v)) throw err('E_ARGS', `${what} must be a positive number (estimated dollars)`, { [what]: v });
  return v;
}

// Is the usage ledger on for this run row? A budget forces it on in the launch levers; a run with the lever alone has it too.
function ledgerOn(runRow) {
  if (!runRow) return false;
  if (runRow.budget_usd != null) return true;
  let lv = runRow.memory_levers;
  if (typeof lv === 'string') { try { lv = JSON.parse(lv); } catch { lv = null; } }
  return !!(lv && lv.cost_ledger === true);
}

// task.create: the optional task limit. Refused when the run's ledger is off, because the spend could not be measured.
function taskLimit(E, caller, args) {
  if (args.budget_usd === undefined || args.budget_usd === null) return null;
  checkLimit(args.budget_usd, 'budget_usd');
  const run = rows.current(E.store, 'run', caller.run_id);
  if (!ledgerOn(run)) {
    throw err('E_ARGS', 'task.create budget_usd needs the usage ledger, and this run does not write one: start the run with budget_usd (a limit high enough not to bind is fine) or with the memory lever cost_ledger on; nothing was written', { budget_usd: args.budget_usd });
  }
  return args.budget_usd;
}

// run.attach: the spec's limit, unless this is the same unended life and an operator raised the limit at a resume (the record says so).
function attachLimit(args, prev, carryPause) {
  if (carryPause && prev && prev.budget_usd != null && args.budget_usd !== undefined) {
    let rec = prev.budget;
    if (typeof rec === 'string') { try { rec = JSON.parse(rec); } catch { rec = null; } }
    if (rec && Array.isArray(rec.events) && rec.events.some((e) => e.type === 'raise' && e.scope === 'run')) return prev.budget_usd;
  }
  return args.budget_usd !== undefined ? args.budget_usd : (carryPause && prev ? prev.budget_usd : null);
}

// After a task row is written with a limit, tell the run process (the owner's guard), if there is one.
function noteTask(E, caller, row) {
  const h = E.owner && E.owner.opts && E.owner.opts.onTaskBudget;
  if (typeof h !== 'function') return;
  try { h({ task_id: row.id, run_id: caller.run_id, budget_usd: row.budget_usd }); } catch { /* the hook is the run's, never the caller's */ }
}

// The task a turn is charged to (one task per turn, never two): the newest lease the worker held when the turn ended
// (unreleased and granted by then); else the lease released last inside the turn's window; else none (the run alone).
function turnTask(store, workerId, runId, since, until) {
  const held = store.p(`SELECT l.task_id FROM lease l JOIN (SELECT id, MAX(seq) AS m FROM lease GROUP BY id) x ON l.seq = x.m
    WHERE l.holder = ? AND l.holder_role = 'worker' AND l.run_id IS ? AND l.released_at IS NULL AND l.granted_at <= ? AND (l.expires_at IS NULL OR l.expires_at >= ?) ORDER BY l.granted_at DESC, l.seq DESC LIMIT 1`).get(workerId, runId, until, until); // an expired lease nobody renewed was not held
  if (held) return held.task_id;
  const rel = store.p(`SELECT l.task_id FROM lease l JOIN (SELECT id, MAX(seq) AS m FROM lease GROUP BY id) x ON l.seq = x.m
    WHERE l.holder = ? AND l.holder_role = 'worker' AND l.run_id IS ? AND l.released_at IS NOT NULL AND l.released_at > ? AND l.released_at <= ? ORDER BY l.released_at DESC, l.seq DESC LIMIT 1`).get(workerId, runId, since, until);
  return rel ? rel.task_id : null;
}

// The ledger sum for a run (and a task of it): dollars, turns, turns that reported no dollars, and the seq range summed.
function spendOf(store, runId, taskId = null) {
  const sql = `SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS turns, COALESCE(SUM(cost_usd IS NULL), 0) AS unknown_turns, MIN(seq) AS first_seq, MAX(seq) AS last_seq
    FROM usage WHERE run_id = ?${taskId == null ? '' : ' AND task_id = ?'}`;
  try {
    const r = taskId == null ? store.p(sql).get(runId) : store.p(sql).get(runId, taskId);
    return { usd: r.usd, turns: r.turns, unknown_turns: r.unknown_turns, first_seq: r.first_seq, last_seq: r.last_seq };
  } catch (e) {
    if (/no such table/i.test(e.message)) return { usd: 0, turns: 0, unknown_turns: 0, first_seq: null, last_seq: null };
    throw e;
  }
}

// The detail written with a pause: per worker and per task sums, and the workers whose turns reported no dollars.
function detailOf(store, runId) {
  const by = (col) => store.p(`SELECT ${col} AS k, COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS turns, COALESCE(SUM(cost_usd IS NULL), 0) AS unknown_turns FROM usage WHERE run_id = ? GROUP BY ${col}`).all(runId);
  const out = { per_worker: {}, per_task: {}, unknown_workers: [] };
  for (const r of by('worker_id')) { out.per_worker[r.k === null ? '(none)' : r.k] = r.usd; if (r.unknown_turns) out.unknown_workers.push({ worker_id: r.k, turns: r.unknown_turns }); }
  for (const r of by('task_id')) out.per_task[r.k === null ? '(run)' : r.k] = r.usd;
  return out;
}

// usage.spend { run_id?, task_id?, detail? } — a read: the sum above for the caller's run (or the run named).
async function usageSpend(E, caller, args) {
  const runId = args.run_id || caller.run_id;
  const out = spendOf(E.store, runId, args.task_id == null ? null : args.task_id);
  return args.detail ? { ...out, ...detailOf(E.store, runId) } : out;
}

// run.setBudget { budget_usd?, budget? } — the run process's write (operator): the run's limit and/or its budget record.
async function setBudget(E, caller, args) {
  const { appendRunRow } = require('./methods-run.cjs');
  const prev = rows.current(E.store, 'run', caller.run_id);
  if (!prev) throw err('E_NOT_FOUND', `no run row exists for ${caller.run_id}`, { run_id: caller.run_id });
  if (prev.ended_at != null) throw err('E_ARGS', `run ${caller.run_id} has already ended`, { run_id: caller.run_id, ended_at: prev.ended_at });
  const next = { ...prev };
  if (args.budget_usd !== undefined) next.budget_usd = args.budget_usd === null ? null : checkLimit(args.budget_usd, 'budget_usd');
  if (args.budget !== undefined) {
    if (args.budget !== null && (typeof args.budget !== 'object' || Array.isArray(args.budget))) throw err('E_ARGS', 'run.setBudget budget must be an object or null');
    next.budget = args.budget === null ? null : JSON.stringify(args.budget);
  }
  const row = appendRunRow(E, next, E.writtenBy(caller));
  E.noteWrite();
  return row;
}

// The run's budget block (status.get's run.budget, belay agents' budget): from the run row and a ledger sum. Only for a run whose row
// carries a limit (the caller checks), so a run without one never reaches the query.
function blockOf(runRow, s) {
  let rec = runRow.budget;
  if (typeof rec === 'string') { try { rec = JSON.parse(rec); } catch { rec = null; } }
  const overridden = !!(rec && rec.overrides && rec.overrides.run);
  const state = overridden ? 'overridden' : runRow.paused_by && /\[budget [(]/.test(runRow.paused_by) && runRow.paused_at != null ? 'paused' : 'under';
  return {
    limit_usd: runRow.budget_usd, spent_usd: s.usd, unknown_turns: s.unknown_turns, state, estimate: true,
    orchestrator: rec && rec.orchestrator ? rec.orchestrator : { counted: 'headless runs only; an interactive session is not counted' },
  };
}
const statusBlock = (store, runRow) => blockOf(runRow, spendOf(store, runRow.id));

// One line, every figure an estimate: "at least $4.10 of $20.00 est. (under); 6 turns report no dollars".
function textOf(b) {
  const m = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
  return `${b.unknown_turns ? 'at least ' : ''}${m(b.spent_usd)} of ${m(b.limit_usd)} est. (${b.state})${b.unknown_turns ? `; ${b.unknown_turns} turn${b.unknown_turns === 1 ? '' : 's'} report no dollars` : ''}`;
}

module.exports = { SOFT_THRESHOLD, isLimit, checkLimit, ledgerOn, taskLimit, attachLimit, noteTask, turnTask, spendOf, detailOf, usageSpend, setBudget, statusBlock, blockOf, textOf };
