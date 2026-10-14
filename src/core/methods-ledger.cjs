'use strict';
// methods-ledger.cjs — the two append-only ledgers of ADR 0041: the memory-event receipt table
// (decision 3) and the per-turn usage table (decision 6). Four methods, each `(E, caller, args)`:
// recordEvent and usageRecord write and return the row they wrote; events and usageList read.
//
// Both tables are append-only like the orchestration tables: nothing here issues an UPDATE or a DELETE.
// `written_by` comes from the caller (E.writtenBy), never from the arguments. Ids are minted here.

const crypto = require('node:crypto');
const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const { redact } = require('./redact.cjs');

const EVENT_KINDS = ['observation', 'summary', 'project_write', 'usage', 'index_injected', 'bottle', 'wrapup',
  'corpus_primed', 'knowledge_ask'];
const SUBSTRATES = ['claude-code', 'codex'];
const COST_BASES = ['delta-of-cumulative', 'delta-of-cumulative (new process)', 'none'];
const GROUPS = ['task', 'worker', 'model', 'turn'];
const TOKENS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens'];

const isStr = v => typeof v === 'string' && v.length > 0;
const isCount = v => Number.isInteger(v) && v >= 0;
const optStr = (v, what) => {
  if (v === undefined || v === null) return null;
  if (!isStr(v)) throw err('E_ARGS', `${what} must be a non-empty string when given`);
  return v;
};
const optCount = (v, what) => {
  if (v === undefined || v === null) return null;
  if (!isCount(v)) throw err('E_ARGS', `${what} must be a non-negative integer when given`);
  return v;
};
// ok, dropped and over_budget arrive as a boolean or 0/1 and are stored as 0/1.
const flag = (v, what) => {
  if (v === true || v === 1) return 1;
  if (v === false || v === 0) return 0;
  throw err('E_ARGS', `${what} must be a boolean or 0/1`);
};

// The run's `memory.redact` lever, read as methods-memory.cjs reads it for a row: on unless the caller's run row
// says `redact: false`. A receipt's message can carry a worker's own words (a wrap-up quotes the handoff verdict),
// so it is scrubbed exactly as a stored row's text is (ADR 0040 §3).
function redactOn(E, caller) {
  let raw = null;
  try { const run = rows.current(E.store, 'run', caller.run_id); raw = run ? run.memory_levers : null; } catch { return true; }
  if (raw == null) return true;
  try { const o = typeof raw === 'string' ? JSON.parse(raw) : raw; return !(o && o.redact === false); } catch { return true; }
}
const scrubMessage = (E, caller, m) => (m == null || !redactOn(E, caller) ? m : redact(m).text);

const isMissingTable = e => /no such table/i.test(String(e && e.message));

function eventOut(r) {
  if (!r) return r;
  let ids = null;
  if (typeof r.row_ids === 'string') { try { ids = JSON.parse(r.row_ids); } catch { ids = r.row_ids; } }
  return { ...r, row_ids: ids };
}

// memory.recordEvent — one receipt for one harness memory action. A failed action is recorded with
// ok 0 and the code that failed it, never skipped (ADR 0041 decision 3). A wrap-up is once per
// (run, key): the store's partial unique index decides, so the loser gets E_EXISTS naming the winner.
async function recordEvent(E, caller, args) {
  if (!EVENT_KINDS.includes(args.kind)) {
    throw err('E_ARGS', `memory.recordEvent kind must be one of ${EVENT_KINDS.join(', ')}, and this call carried ${JSON.stringify(args.kind)}`);
  }
  const code = optStr(args.code, 'code');
  const ok = flag(args.ok === undefined ? (code ? 0 : 1) : args.ok, 'ok');
  if (ok && code) throw err('E_ARGS', 'memory.recordEvent: an ok event carries no code');
  if (!ok && !code) throw err('E_ARGS', 'memory.recordEvent: a failed event (ok 0) must name the code that failed it');
  const key = optStr(args.key, 'key');
  const runId = optStr(args.run_id, 'run_id') || caller.run_id;
  if (args.kind === 'wrapup' && !key) {
    throw err('E_ARGS', "memory.recordEvent: a wrapup event needs a key ('task:<id>' or 'run'), because once-per-key is what the store guarantees");
  }
  let rowIds = null;
  if (args.row_ids !== undefined && args.row_ids !== null) {
    if (!Array.isArray(args.row_ids) || args.row_ids.some(x => !isStr(x))) throw err('E_ARGS', 'row_ids must be an array of row id strings');
    rowIds = JSON.stringify(args.row_ids);
  }
  const vals = [
    `me-${crypto.randomUUID()}`, runId, optStr(args.worker_id, 'worker_id'), optStr(args.task_id, 'task_id'),
    args.kind, key, rowIds, optStr(args.newest_row_id, 'newest_row_id'), optCount(args.bytes, 'bytes'),
    optStr(args.sha256, 'sha256'), ok, code, scrubMessage(E, caller, optStr(args.message, 'message')),
    args.dropped === undefined || args.dropped === null ? null : flag(args.dropped, 'dropped'),
    args.over_budget === undefined || args.over_budget === null ? null : flag(args.over_budget, 'over_budget'),
    Date.now(), caller.channel === 'harness' ? 'harness' : E.writtenBy(caller), // ADR 0044: the run manager's events say harness
  ];
  const sql = `INSERT INTO memory_event(id, run_id, worker_id, task_id, kind, key, row_ids, newest_row_id, bytes,
    sha256, ok, code, message, dropped, over_budget, written_at, written_by) VALUES (${vals.map(() => '?').join(', ')})`;
  let info;
  try {
    info = E.store.p(sql).run(...vals);
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(String(e && e.message)) && args.kind === 'wrapup') {
      const prior = E.store.p("SELECT * FROM memory_event WHERE run_id = ? AND key = ? AND kind = 'wrapup' AND ok = 1 ORDER BY seq LIMIT 1").get(runId, key);
      throw err('E_EXISTS', `a wrapup event for key ${key} already exists in run ${runId}; nothing was written`, { run_id: runId, key, existing: eventOut(prior) });
    }
    throw e;
  }
  E.noteWrite();
  return eventOut(E.store.p('SELECT * FROM memory_event WHERE seq = ?').get(Number(info.lastInsertRowid)));
}

// memory.events { run_id?, worker_id?, task_id?, kinds?, limit? } — receipts in write order. A read.
async function events(E, caller, args) {
  const where = [];
  const params = [];
  for (const f of ['run_id', 'worker_id', 'task_id']) {
    if (args[f] === undefined || args[f] === null) continue;
    if (!isStr(args[f])) throw err('E_ARGS', `memory.events ${f} must be a non-empty string`);
    where.push(`${f} = ?`); params.push(args[f]);
  }
  if (args.kinds !== undefined && args.kinds !== null) {
    if (!Array.isArray(args.kinds) || !args.kinds.length) throw err('E_ARGS', 'memory.events kinds must be a non-empty array');
    for (const k of args.kinds) if (!EVENT_KINDS.includes(k)) throw err('E_ARGS', `memory.events kinds named ${JSON.stringify(k)}, and must be among ${EVENT_KINDS.join(', ')}`);
    where.push(`kind IN (${args.kinds.map(() => '?').join(', ')})`); params.push(...args.kinds);
  }
  let limit = '';
  if (args.limit !== undefined && args.limit !== null) {
    if (!Number.isInteger(args.limit) || args.limit < 1) throw err('E_ARGS', 'memory.events limit must be a positive integer');
    limit = ` LIMIT ${args.limit}`;
  }
  const sql = `SELECT * FROM memory_event${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq${limit}`;
  try {
    return { events: E.store.p(sql).all(...params).map(eventOut) };
  } catch (e) {
    // A copy of a store no owner has upgraded yet has no table. That is an empty ledger, said so.
    if (isMissingTable(e)) return { events: [], table_absent: true };
    throw e;
  }
}

// usage.record — one row per turn. cost_basis defaults from the substrate (Codex reports no dollars,
// so 'none' and a null cost; Claude Code's cumulative cost is differenced by the caller).
async function usageRecord(E, caller, args) {
  const substrate = optStr(args.substrate, 'substrate');
  if (substrate && !SUBSTRATES.includes(substrate)) throw err('E_ARGS', `usage.record substrate must be one of ${SUBSTRATES.join(', ')}`);
  const basis = args.cost_basis === undefined || args.cost_basis === null
    ? (substrate === 'codex' ? 'none' : 'delta-of-cumulative')
    : args.cost_basis;
  if (!COST_BASES.includes(basis)) throw err('E_ARGS', `usage.record cost_basis must be one of ${COST_BASES.join(', ')}`);
  let cost = args.cost_usd === undefined ? null : args.cost_usd;
  if (cost !== null && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) throw err('E_ARGS', 'usage.record cost_usd must be a non-negative number or null');
  if (basis === 'none' && cost !== null) throw err('E_ARGS', "usage.record: cost_basis 'none' means the substrate reported no dollars, so cost_usd must be null");
  if (basis !== 'none' && cost === null) throw err('E_ARGS', `usage.record: cost_basis '${basis}' needs a cost_usd; use cost_basis 'none' when no dollars were reported`);
  const tok = TOKENS.map(f => optCount(args[f], f));
  const vals = [
    `us-${crypto.randomUUID()}`, optStr(args.run_id, 'run_id') || caller.run_id, optStr(args.worker_id, 'worker_id'),
    optStr(args.task_id, 'task_id'), optCount(args.turn, 'turn'), substrate, optStr(args.model, 'model'), ...tok,
    cost, basis, optCount(args.at, 'at') ?? Date.now(), Date.now(), E.writtenBy(caller),
  ];
  const sql = `INSERT INTO usage(id, run_id, worker_id, task_id, turn, substrate, model, input_tokens, output_tokens,
    cache_read_tokens, cache_creation_tokens, cost_usd, cost_basis, at, written_at, written_by)
    VALUES (${vals.map(() => '?').join(', ')})`;
  const info = E.store.p(sql).run(...vals);
  E.noteWrite();
  return E.store.p('SELECT * FROM usage WHERE seq = ?').get(Number(info.lastInsertRowid));
}

const sum = (rows, f) => rows.reduce((n, r) => n + (r[f] || 0), 0);

// A group's dollars are comparable only when every row's cost has one meaning. A 'none' row carries no
// dollars at all, so a total over 'none' and dollar rows is partial: that is cost_basis_mixed. The
// '(new process)' suffix only marks where a delta restarted, so it does not make a group mixed.
function summarise(key, rows) {
  const meanings = new Set(rows.map(r => (r.cost_basis === 'none' ? 'none' : 'delta')));
  const priced = rows.filter(r => r.cost_usd !== null && r.cost_usd !== undefined);
  return {
    key, turns: rows.length,
    input_tokens: sum(rows, 'input_tokens'), output_tokens: sum(rows, 'output_tokens'),
    cache_read_tokens: sum(rows, 'cache_read_tokens'), cache_creation_tokens: sum(rows, 'cache_creation_tokens'),
    cost_usd: priced.length ? sum(priced, 'cost_usd') : null,
    cost_basis_mixed: meanings.size > 1,
  };
}

// usage.list { run_id?, group_by? } — rows with totals, or groups with totals. A read. The key of a
// row with no task, worker or model is null, grouped together rather than dropped.
async function usageList(E, caller, args) {
  if (args.group_by !== undefined && args.group_by !== null && !GROUPS.includes(args.group_by)) {
    throw err('E_ARGS', `usage.list group_by must be one of ${GROUPS.join(', ')}`);
  }
  if (args.run_id !== undefined && args.run_id !== null && !isStr(args.run_id)) throw err('E_ARGS', 'usage.list run_id must be a non-empty string');
  const hasRun = isStr(args.run_id);
  let rows;
  try {
    rows = E.store.p(`SELECT * FROM usage${hasRun ? ' WHERE run_id = ?' : ''} ORDER BY seq`).all(...(hasRun ? [args.run_id] : []));
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    rows = [];
    const empty = summarise(null, rows);
    return args.group_by ? { groups: [], totals: empty, table_absent: true } : { rows, totals: empty, table_absent: true };
  }
  const totals = summarise(null, rows);
  if (!args.group_by) return { rows, totals };
  const field = args.group_by === 'task' ? 'task_id' : args.group_by === 'worker' ? 'worker_id' : args.group_by;
  const by = new Map();
  for (const r of rows) {
    const k = r[field] === undefined ? null : r[field];
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  return { groups: [...by].map(([k, rs]) => summarise(k, rs)), totals };
}

module.exports = { recordEvent, events, usageRecord, usageList, EVENT_KINDS };
