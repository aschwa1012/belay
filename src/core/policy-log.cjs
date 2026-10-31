'use strict';
// policy-log.cjs — the policy step log shown to the human (0.4.0, ADR 0072 decision 3 and ADR 0075 decision 4). A read: the newest steps of a
// run in claim order, each with its trigger, outcome, the row it names or the error, and the cost of the turn it started. The cost is the
// usage ledger's own figure for (run, worker, turn): facts, no judgement, null when the step carries no turn or the ledger has no row for it.
// One indexed query for the steps and one for the costs of the turns shown; a store from before the tables answers empty.

const { err } = require('./errors.cjs');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const missing = (e) => /no such table/i.test(String(e && e.message)); // only a store from before the tables reads as empty; a missing column or a busy read is an error

function view(r, cost) {
  const c = r.turn != null ? cost.get(`${r.worker_id == null ? '' : r.worker_id}|${r.turn}`) : null;
  return {
    seq: r.seq, step: r.step, task_id: r.task_id == null ? null : r.task_id,
    trigger: `${r.trigger_table}:${r.trigger_id}${r.trigger_seq ? `:${r.trigger_seq}` : ''}`, policy_rev: r.policy_rev == null ? null : r.policy_rev,
    outcome: r.outcome, row_ref: r.row_ref == null ? null : r.row_ref, error: r.error == null ? null : r.error,
    worker_id: r.worker_id == null ? null : r.worker_id, turn: r.turn == null ? null : r.turn, at: r.at, finished_at: r.finished_at == null ? null : r.finished_at,
    turn_cost_usd: c ? c.usd : null, turn_cost_rows: c ? c.n : 0,
  };
}

// readLog(E, runId, limit) -> { steps (oldest first of the newest `limit`), total }
function readLog(E, runId, limit) {
  if (!runId) return { steps: [], total: 0 };
  let rows, total;
  try {
    total = E.store.p('SELECT COUNT(*) AS n FROM policy_step WHERE run_id = ?').get(runId).n;
    rows = total ? E.store.p('SELECT * FROM policy_step WHERE run_id = ? ORDER BY seq DESC LIMIT ?').all(runId, limit).reverse() : [];
  } catch (e) { if (missing(e)) return { steps: [], total: 0 }; throw e; }
  const turns = [...new Set(rows.filter((r) => r.turn != null).map((r) => r.turn))];
  const cost = new Map();
  if (turns.length) {
    try {
      for (const g of E.store.p(`SELECT COALESCE(worker_id, '') AS w, turn, SUM(cost_usd) AS usd, COUNT(*) AS n FROM usage WHERE run_id = ? AND turn IN (${turns.map(() => '?').join(', ')}) GROUP BY w, turn`).all(runId, ...turns)) cost.set(`${g.w}|${g.turn}`, { usd: g.usd == null ? null : g.usd, n: g.n });
    } catch (e) { if (!missing(e)) throw e; }
  }
  return { steps: rows.map((r) => view(r, cost)), total };
}

// policy.log { run_id?, limit? } -> { steps, total }
async function list(E, caller, args) {
  const a = args || {};
  for (const k of Object.keys(a)) if (k !== 'caller' && k !== 'run_id' && k !== 'limit') throw err('E_ARGS', `policy.log takes run_id and limit, not ${k}`, { field: k });
  if (a.run_id !== undefined && (typeof a.run_id !== 'string' || !a.run_id)) throw err('E_ARGS', 'policy.log run_id must be a non-empty string', { field: 'run_id' });
  if (a.limit !== undefined && (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > MAX_LIMIT)) throw err('E_ARGS', `policy.log limit must be 1 to ${MAX_LIMIT}`, { field: 'limit' });
  return readLog(E, a.run_id || caller.run_id, a.limit || DEFAULT_LIMIT);
}

const when = (ms) => new Date(Number(ms)).toISOString().slice(11, 19);
const usd = (x) => { let t = Number(x).toFixed(4); if (Number(t) !== 0) t = t.replace(/0+$/, '').replace(/\.$/, ''); return `$${t}`; };

// Control characters and bidi marks become spaces and the string is capped, so nothing a row holds starts a line of its own.
const CONTROL = new RegExp('[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u2060\u202a-\u202e\u2066-\u2069\ufeff]', 'g');
const clean = (x, cap = 80) => Array.from(String(x).replace(CONTROL, ' ').replace(new RegExp(String.fromCharCode(92) + 's{2,}', 'g'), ' ')).slice(0, cap).join('');

// One line per step: facts only.
function line(s) {
  const cost = s.turn == null ? 'no turn' : (s.turn_cost_rows ? `turn ${s.turn} ${s.turn_cost_usd == null ? 'cost not priced' : usd(s.turn_cost_usd)}` : `turn ${s.turn} cost not yet recorded`);
  const effect = s.row_ref ? ` -> ${s.row_ref}` : (s.error ? ` error: ${clean(s.error, 120)}` : '');
  return `step ${s.seq} ${s.step} ${s.task_id == null ? '-' : clean(s.task_id)} on ${clean(s.trigger)}${s.policy_rev == null ? '' : ` rev ${s.policy_rev}`} at ${when(s.at)}: ${s.outcome}${effect} (${cost})`;
}

const STATUS_N = 5;
// The status.get key: only when the run has a step, so a run without a policy reads as before.
function statusOf(E, runId) {
  const l = readLog(E, runId, STATUS_N);
  return l.total ? { policy_log: { steps: l.steps, total: l.total } } : {};
}
const statusLines = (receipt) => {
  const p = receipt.policy_log;
  if (!p) return [];
  return [`policy steps: ${p.total} in all${p.total > p.steps.length ? `, newest ${p.steps.length}` : ''}`, ...p.steps.map((s) => `  ${line(s)}`)];
};

module.exports = { list, readLog, line, statusOf, statusLines, STATUS_N, MAX_LIMIT };
