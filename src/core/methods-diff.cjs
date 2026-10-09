'use strict';
// methods-diff.cjs — build step 4c, design item 2.
// store.diff is a read method (engine.cjs: roles ALL, kind 'read'): rows added, updated, superseded or
// expired since a mark the caller supplies. The core never guesses a mark; since_ms is required.
//
// The five orchestration tables (api.md §2) are append-only: the current row of an id is its highest
// seq. "added" is the lowest-seq row an id has ever had (its very first row, whether or not that row
// itself is old enough to be at or before the mark it cannot be, since it IS the row that created the
// id); every later row for the same id that landed after the mark is "updated", carrying the seq of the
// row it supersedes. memory_entries is upserted in place (rows.cjs's comment, api.md §2): a "change" is
// read from created_at/updated_at/supersedes/ttl_at instead of seq.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');

const ORCH_TABLES = ['run', 'worker', 'task', 'lease', 'checkpoint'];

// `run` has no run_id column: its own id IS the run id (schema.cjs). Every other orchestration table
// carries run_id directly.
function runIdColumn(table) { return table === 'run' ? 'id' : 'run_id'; }

// An IN-list above this size costs more than just reading every id's own seq history off the table
// (FINDINGS.json line 30), so above it classification falls back to one GROUP BY over the whole table.
const ID_LIST_CEILING = 200;

function diffOrchestrationTable(store, table, sinceMs, runId) {
  const idCol = runIdColumn(table);
  const whereRunId = runId != null ? ` AND ${idCol} = ?` : '';
  const params = runId != null ? [sinceMs, runId] : [sinceMs];
  const changed = store.p(`SELECT * FROM ${table} WHERE written_at > ?${whereRunId} ORDER BY seq`).all(...params);
  if (changed.length === 0) return { added: [], updated: [] };

  // One extra query per table, not one or two per changed row: every changed id's own seq history,
  // sorted, so both "is this the first row" and "what seq did this one supersede" are answered from an
  // in-memory lookup rather than a query per row.
  const ids = [...new Set(changed.map(r => r.id))];
  const seqRows = ids.length <= ID_LIST_CEILING
    ? store.p(`SELECT id, seq FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : store.p(`SELECT id, seq FROM ${table}`).all();
  const seqsById = new Map();
  for (const r of seqRows) {
    const list = seqsById.get(r.id);
    if (list) list.push(Number(r.seq)); else seqsById.set(r.id, [Number(r.seq)]);
  }
  for (const list of seqsById.values()) list.sort((a, b) => a - b);

  const added = [];
  const updated = [];
  for (const r of changed) {
    const parsed = rows.parseRow(table, r);
    const seqs = seqsById.get(r.id) || [Number(r.seq)];
    const idx = seqs.indexOf(Number(r.seq));
    if (idx <= 0) {
      added.push(parsed);
    } else {
      updated.push({ ...parsed, supersedes_seq: seqs[idx - 1] });
    }
  }
  return { added, updated };
}

// The exact columns a diff row returns — no embedding, text cut at 200 characters at the SQL layer,
// matching store.list()'s own SELECT (store.cjs) rather than loading the vector and discarding it.
const MEMORY_COLUMNS = `id, namespace, worker_id, last_writer_id, type, substr(text, 1, 200) AS text,
  tags, provenance, supersedes, created_at, updated_at, ttl_at`;

function memRowOut(r) { return { ...r, tags: r.tags ? JSON.parse(r.tags) : null }; }

const EXPIRED_NOTE = 'ttl_at <= now_ms and ttl_at > since_ms (expired since the mark) and the row is '
  + 'still present; once store.sweep() deletes it, it no longer appears here. A row created after the '
  + 'mark that is also already expired since the mark appears in both added and expired.';

function diffMemory(store, sinceMs, runId, nowMs) {
  const ns = runId != null ? ` AND namespace = ?` : '';
  const nsParams = runId != null ? [`run/${runId}`] : [];

  const added = store.p(`SELECT ${MEMORY_COLUMNS} FROM memory_entries WHERE created_at > ?${ns}`)
    .all(sinceMs, ...nsParams).map(memRowOut);
  const updated = store.p(`SELECT ${MEMORY_COLUMNS} FROM memory_entries WHERE updated_at > ? AND created_at <= ?${ns}`)
    .all(sinceMs, sinceMs, ...nsParams).map(memRowOut);

  // A row is "superseded" when another row, written after the mark, names it in that row's own
  // supersedes column. The superseded row itself is what is returned, carrying superseded_by — it may
  // have been created long before the mark; what matters is when the superseding write landed. One
  // query for every superseded target, not one per superseder.
  const superseders = store.p(`SELECT id, supersedes FROM memory_entries WHERE supersedes IS NOT NULL AND created_at > ?${ns}`)
    .all(sinceMs, ...nsParams);
  const superseded = [];
  if (superseders.length) {
    const targetIds = [...new Set(superseders.map(s => s.supersedes))];
    const targets = new Map(store.p(`SELECT ${MEMORY_COLUMNS} FROM memory_entries WHERE id IN (${targetIds.map(() => '?').join(',')})`)
      .all(...targetIds).map(t => [t.id, t]));
    for (const s of superseders) {
      const target = targets.get(s.supersedes);
      if (target) superseded.push({ ...memRowOut(target), superseded_by: s.id });
    }
  }

  // Expired is judged since the mark, exactly as the other classes are: still expired now, but not
  // already expired at or before the mark (that row expired before this diff's window even opened).
  const expired = store.p(`SELECT ${MEMORY_COLUMNS} FROM memory_entries WHERE ttl_at IS NOT NULL AND ttl_at <= ? AND ttl_at > ?${ns}`)
    .all(nowMs, sinceMs, ...nsParams).map(memRowOut);

  return { added, updated, superseded, expired, note: EXPIRED_NOTE };
}

async function diff(E, caller, args) {
  const sinceMs = args.since_ms;
  if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs) || !Number.isInteger(sinceMs) || sinceMs < 0) {
    throw err('E_ARGS', 'store.diff needs since_ms as a finite non-negative integer epoch millisecond mark; the CLI supplies it, the core never guesses one');
  }
  const runId = args.run_id != null ? String(args.run_id) : null;
  const nowMs = Date.now();

  const tables = {};
  const counts = {};
  for (const t of ORCH_TABLES) {
    const d = diffOrchestrationTable(E.store, t, sinceMs, runId);
    tables[t] = d;
    counts[t] = { added: d.added.length, updated: d.updated.length };
  }
  const mem = diffMemory(E.store, sinceMs, runId, nowMs);
  tables.memory = mem;
  counts.memory = {
    added: mem.added.length, updated: mem.updated.length,
    superseded: mem.superseded.length, expired: mem.expired.length,
  };

  return { since_ms: sinceMs, now_ms: nowMs, run_id: runId, tables, counts, established_by: E.establishedBy };
}

module.exports = { diff };
