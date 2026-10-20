'use strict';
// search-log.cjs — the search log (ADR 0050 decision 7). The store owner writes one `memory_event` of kind `search` for every memory
// search it serves, and of kind `index` for every first-message index. A search answered from a copy of the store (no owner) writes
// nothing: reading never writes (invariant 6). A failed log write is swallowed here and never fails the search.
//
// The row: run_id and worker_id as events carry them; `row_ids` the ranked candidate ids; `bytes` the size of the row's two text
// columns; `message` one JSON object:
//   { v, role, worker_id, channel, tier: { profile, embedder, reranker, device }, mode, namespaces, k, offset,
//     query (scrubbed, cut at QUERY_MAX), query_cut, ranks: [{ id, before, after }], ms: { <stage>: n, total: n }, fallback: null | {...} }
// `before` is the id's place after fusion, `after` its place after the reranker (the same when none ran); both 1-based.
//
// The cap (`search_log_cap_mb`, default 500): the sum of `bytes` of the log's rows is kept in meta `search_log_bytes`, added to at each
// write, so a write costs one counter update and never a scan. The counter is built by one scan the first time it is missing. When it
// passes the cap, the oldest runs' events go first (whole runs, in the order of their first event) down to 90% of the cap, so the next
// prune is far off; if the newest run alone is over, its oldest events go. The counter is then set from what is left.

const { redact } = require('./redact.cjs');
const { recordEventSync } = require('./methods-ledger.cjs');

const QUERY_MAX = 2048;
const KINDS = ['search', 'index'];
const COUNTER = 'search_log_bytes';
const LOW_WATER = 0.9;
const INLIST = KINDS.map(() => '?').join(', ');

const bytesOf = (s) => (s == null ? 0 : Buffer.byteLength(s, 'utf8'));

// The stored counter, or null when it has not been built.
function counter(E) {
  const r = E.store.p('SELECT value FROM meta WHERE key = ?').get(COUNTER);
  return r && Number.isFinite(Number(r.value)) ? Number(r.value) : null;
}
function setCounter(E, n) { E.store.p('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(COUNTER, String(Math.max(0, Math.trunc(n)))); }
function resync(E) {
  const n = Number(E.store.p(`SELECT COALESCE(SUM(bytes), 0) AS n FROM memory_event WHERE kind IN (${INLIST})`).get(...KINDS).n);
  setCounter(E, n);
  return n;
}

// Deletes the oldest runs' log events until the log is at or under `target` bytes. Returns the number of events removed.
function pruneTo(E, target) {
  return E.store.tx(() => {
    let total = Number(E.store.p(`SELECT COALESCE(SUM(bytes), 0) AS n FROM memory_event WHERE kind IN (${INLIST})`).get(...KINDS).n);
    let removed = 0;
    const runs = E.store.p(`SELECT run_id, MIN(seq) AS first, SUM(bytes) AS b FROM memory_event WHERE kind IN (${INLIST}) GROUP BY run_id ORDER BY first`).all(...KINDS);
    for (let i = 0; i < runs.length && total > target; i++) {
      const r = runs[i];
      if (i < runs.length - 1) { // a whole run, oldest first
        removed += Number(E.store.p(`DELETE FROM memory_event WHERE kind IN (${INLIST}) AND run_id IS ?`).run(...KINDS, r.run_id).changes);
        total -= Number(r.b);
        continue;
      }
      // the newest run alone is over the cap: its oldest events go
      let cut = null;
      for (const e of E.store.db.prepare(`SELECT seq, bytes FROM memory_event WHERE kind IN (${INLIST}) AND run_id IS ? ORDER BY seq`).iterate(...KINDS, r.run_id)) {
        if (total <= target) break;
        total -= Number(e.bytes || 0); cut = e.seq;
      }
      if (cut !== null) removed += Number(E.store.p(`DELETE FROM memory_event WHERE kind IN (${INLIST}) AND run_id IS ? AND seq <= ?`).run(...KINDS, r.run_id, cut).changes);
    }
    setCounter(E, total);
    return removed;
  });
}

// Adds a written row's bytes to the counter and prunes when the cap is passed. Never throws.
function account(E, added, capMb) {
  try {
    const cap = (Number(capMb) > 0 ? Number(capMb) : 500) * 1048576;
    const have = counter(E);
    const total = have === null ? resync(E) : have + added; // a counter built now already counts the row just written
    if (total > cap) return pruneTo(E, Math.floor(cap * LOW_WATER));
    setCounter(E, total);
  } catch { /* the log is a record, never the search's failure */ }
  return 0;
}

// record(E, caller, { kind, tier, query, mode, namespaces, k, offset, ranks, ms, fallback, capMb }) -> the event row or null.
function record(E, caller, o) {
  try {
    if (!E.owner) return null; // a copy writes nothing
    const q = typeof o.query === 'string' ? redact(o.query).text : null;
    const cut = q !== null && q.length > QUERY_MAX;
    const t = o.tier || {};
    const detail = {
      v: 1, role: caller.role, worker_id: o.worker_id || caller.worker_id || null, channel: caller.channel || null,
      tier: { profile: t.profile || null, embedder: t.embedder || null, reranker: t.reranker || null, device: t.device || null },
      mode: o.mode || null, namespaces: o.namespaces || null, k: o.k ?? null, offset: o.offset ?? 0,
      query: cut ? q.slice(0, QUERY_MAX) : q, query_cut: cut,
      ranks: o.ranks || [], ms: o.ms || {}, fallback: o.fallback || null,
    };
    const message = JSON.stringify(detail);
    const ids = detail.ranks.map(r => r.id);
    const rowIds = ids.length ? ids : undefined;
    const bytes = bytesOf(message) + bytesOf(rowIds ? JSON.stringify(rowIds) : null);
    const ev = recordEventSync(E, caller, {
      kind: o.kind === 'index' ? 'index' : 'search', worker_id: o.worker_id || caller.worker_id || undefined, task_id: o.task_id || undefined, row_ids: rowIds, message, bytes,
    }, { prescrubbed: true, searchLog: true });
    account(E, bytes, o.capMb);
    return ev;
  } catch { return null; }
}

module.exports = { record, account, pruneTo, QUERY_MAX, COUNTER };
