'use strict';
// rows.cjs — append-only row mechanics for the five orchestration tables (api.md §1, §2).
// Rows supersede, never mutate: every write is an INSERT and the current row of an id is its highest
// `seq`. Nothing here issues an UPDATE or a DELETE against these tables.

const crypto = require('node:crypto');

const COLUMNS = {
  run: ['id', 'epoch', 'orchestrator_pid', 'adapter_pid', 'started_at', 'ended_at', 'exit_reason',
    'orch_model', 'orch_input_tokens', 'orch_output_tokens', 'orch_cache_read_tokens', 'orch_cache_creation_tokens',
    'orch_cost_usd', 'orch_turns', 'orch_effort_requested', 'max_fix_rounds', 'adapter_pid_created'],
  worker: ['id', 'run_id', 'substrate', 'pid', 'session_id', 'adapter_pid', 'argv_hash', 'state',
    'worktree', 'task_id', 'started_at', 'exited_at', 'exit_code', 'exit_signal', 'turns',
    'input_tokens', 'output_tokens', 'cost_usd', 'last_event_at', 'mid_turn', 'death_established_by',
    'permission_mode_requested', 'permission_mode_effective', 'claude_code_version',
    'paused_at', 'paused_by', 'park_turns',
    'model', 'cache_read_tokens', 'cache_creation_tokens', 'tool_calls', 'base_sha', 'head_sha',
    'effort_requested', 'head_error', 'base_error', 'pid_created', 'pid_created_error', 'pid_image', 'memory_queries', 'native_memory', 'native_memory_auth', 'tools', 'max_budget_usd', 'model_requested'],
  task: ['id', 'run_id', 'spec', 'acceptance', 'files_owned', 'state', 'results', 'depends_on', 'handoff', 'repairs', 'worktree'],
  lease: ['id', 'task_id', 'run_id', 'holder', 'holder_role', 'granted_at', 'expires_at',
    'released_at', 'supersedes', 'ttl_ms'],
  checkpoint: ['id', 'task_id', 'worker_id', 'run_id', 'turn', 'files_touched', 'tool_digest',
    'stated', 'source'],
  permission: ['id', 'run_id', 'worker_id', 'adapter_pid', 'tool', 'input', 'input_truncated',
    'input_sha256', 'state', 'verdict_by', 'reason', 'requested_at', 'decided_at'],
  // ADR 0053 decision 5.
  integration: ['id', 'run_id', 'repo', 'into_branch', 'worktree', 'created_worktree', 'base_sha', 'head_sha', 'state',
    'task_ids', 'merged', 'conflict', 'error', 'checks', 'passed', 'junctions', 'removed_at'],
};

// Text in SQLite, parsed objects on the wire (api.md §1).
const JSON_COLUMNS = {
  run: [], worker: ['memory_queries', 'tools'], lease: [],
  task: ['acceptance', 'files_owned', 'results', 'depends_on', 'handoff', 'worktree'],
  integration: ['task_ids', 'merged', 'conflict', 'error', 'checks', 'junctions'],
  checkpoint: ['files_touched', 'tool_digest', 'stated'],
  // build step 6d: `input` stays a string on the wire, never parsed here. A truncated JSON text
  // (input_truncated: 1) does not parse as JSON at all, and an operator reading `pending` needs to
  // see the digest as text either way — so it is never in this list, on purpose.
  permission: [],
};

// node:sqlite binds null, numbers, strings, bigints and buffers only: a boolean or an object thrown at
// it is a TypeError at call time, so coerce here rather than at each call site.
function bind(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const t = typeof v;
  if (t === 'number' || t === 'string' || t === 'bigint') return v;
  return JSON.stringify(v);
}

function parseRow(table, r) {
  if (!r) return null;
  const out = { ...r };
  for (const c of JSON_COLUMNS[table]) {
    if (typeof out[c] === 'string') { try { out[c] = JSON.parse(out[c]); } catch { /* leave text */ } }
    if (out[c] === undefined) out[c] = null;
  }
  return out;
}

function append(store, table, values, writtenBy, at = Date.now()) {
  const cols = COLUMNS[table];
  const all = [...cols, 'written_at', 'written_by'];
  const sql = `INSERT INTO ${table}(${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')})`;
  const params = cols.map(c => bind(values[c]));
  params.push(at, String(writtenBy));
  const info = store.p(sql).run(...params);
  const seq = Number(info.lastInsertRowid);
  return parseRow(table, store.p(`SELECT * FROM ${table} WHERE seq = ?`).get(seq));
}

function current(store, table, id) {
  return parseRow(table, store.p(`SELECT * FROM ${table} WHERE id = ? ORDER BY seq DESC LIMIT 1`).get(id));
}

// One row per id, each the highest-seq row for that id.
function currentAll(store, table) {
  const sql = `SELECT t.* FROM ${table} t JOIN (SELECT id, MAX(seq) AS m FROM ${table} GROUP BY id) x
               ON t.seq = x.m ORDER BY t.seq`;
  return store.p(sql).all().map(r => parseRow(table, r));
}

function history(store, table, id) {
  return store.p(`SELECT * FROM ${table} WHERE id = ? ORDER BY seq`).all(id).map(r => parseRow(table, r));
}

// The current lease of a task is the highest-seq lease row for that task, whatever its lease id
// (api.md §2). A row with `released_at` set means the task has no holder.
function currentLeaseForTask(store, taskId) {
  return parseRow('lease', store.p('SELECT * FROM lease WHERE task_id = ? ORDER BY seq DESC LIMIT 1').get(taskId));
}

// The leases a worker holds right now: the current lease row of each task (highest seq), held by this worker
// in role worker, not released and not past its expiry. Memory provenance is derived from this (ADR 0040 §2):
// a worker's task_id is its one held lease's task, else null, never something it says.
function leasesHeldBy(store, workerId, at = Date.now()) {
  const sql = `SELECT l.* FROM lease l JOIN (SELECT task_id, MAX(seq) AS m FROM lease GROUP BY task_id) x ON l.seq = x.m
               WHERE l.holder = ? AND l.holder_role = 'worker' AND l.released_at IS NULL
               AND (l.expires_at IS NULL OR l.expires_at >= ?) ORDER BY l.seq`;
  return store.p(sql).all(workerId, at).map(r => parseRow('lease', r));
}

function lastCheckpoint(store, taskId, source) {
  const sql = source
    ? 'SELECT * FROM checkpoint WHERE task_id = ? AND source = ? ORDER BY seq DESC LIMIT 1'
    : 'SELECT * FROM checkpoint WHERE task_id = ? ORDER BY seq DESC LIMIT 1';
  const row = source ? store.p(sql).get(taskId, source) : store.p(sql).get(taskId);
  return parseRow('checkpoint', row);
}

const newId = () => crypto.randomUUID();

module.exports = {
  COLUMNS, JSON_COLUMNS, bind, parseRow, append, current, currentAll, history,
  currentLeaseForTask, leasesHeldBy, lastCheckpoint, newId,
};
