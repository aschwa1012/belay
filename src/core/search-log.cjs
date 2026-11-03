'use strict';
// search-log.cjs — the search log (ADR 0050 decision 7). The store owner writes one `memory_event` of kind `search` for every memory
// search it serves, and of kind `index` for every first-message index. A search answered from a copy of the store (no owner) writes
// nothing: reading never writes (invariant 6). A failed log write is swallowed here and never fails the search.
//
// The row: run_id and worker_id as events carry them (the worker id is the CALLER's, never an argument: a worker cannot attribute a row
// to another worker, invariant 3); `row_ids` the ranked candidate ids; `bytes` the size of the row's two text columns; `message` one
// JSON object:
//   { v, role, worker_id, for_worker, for_task, channel, tier: { profile, embedder, reranker, device }, mode, namespaces, k, offset,
//     query (scrubbed, cut at QUERY_MAX), query_cut, ranks: [{ id, before, after }], ms: { <stage>: n, total: n }, fallback: null | {...} }
// `before` is the id's place after fusion, `after` its place after the reranker (the same when none ran); both 1-based. `for_worker` and
// `for_task` are set only by the harness channel, for an index it builds for a worker.
// The query and every fallback message are ALWAYS scrubbed (redact.cjs), whatever the run's `redact` lever says: the log is a research
// record read outside the run.
//
// The cap (`search_log_cap_mb`, default 500): the sum of `bytes` of the log's rows is kept in meta `search_log_bytes`, added to at each
// write, so a write costs one counter update and never a scan. The counter is built by one scan the first time it is missing. When it
// passes the cap, a prune is scheduled for after the answer (setImmediate), never inside the search: it works out the one `seq` below
// which the oldest runs (whole runs, in the order of their first event) hold more than is to go, to 90% of the cap, and deletes
// `seq <= cut` in one statement. When runs overlap in time, that cut can also drop a live run's oldest events; if the newest run alone
// is over, its oldest events go. The counter is then set from what is left. A crash between a row's insert and the counter update leaves
// the counter low until the next prune resyncs it (the drift is bounded by the rows lost to the crash and never loses a row).

const { redact } = require('./redact.cjs');

const QUERY_MAX = 2048;
const KINDS = ['search', 'index'];
const COUNTER = 'search_log_bytes';
const LOW_WATER = 0.9;
const INLIST = KINDS.map(() => '?').join(', ');

const bytesOf = (s) => (s == null ? 0 : Buffer.byteLength(s, 'utf8'));
const scrub = (s) => (typeof s === 'string' ? redact(s).text : s);

// The stored counter, or null when it has not been built.
function counter(E) {
  const r = E.store.p('SELECT value FROM meta WHERE key = ?').get(COUNTER);
  return r && Number.isFinite(Number(r.value)) ? Number(r.value) : null;
}
function setCounter(E, n) { E.store.p('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(COUNTER, String(Math.max(0, Math.trunc(n)))); }
const sumBytes = (E) => Number(E.store.p(`SELECT COALESCE(SUM(bytes), 0) AS n FROM memory_event WHERE kind IN (${INLIST})`).get(...KINDS).n);
function resync(E) { const n = sumBytes(E); setCounter(E, n); return n; }

// Deletes the oldest runs' log events until the log is at or under `target` bytes, with one DELETE. Returns the number removed.
function pruneTo(E, target) {
  return E.store.tx(() => {
    let remaining = sumBytes(E), cut = 0;
    const runs = E.store.p(`SELECT run_id, MIN(seq) AS first, MAX(seq) AS last, SUM(bytes) AS b FROM memory_event WHERE kind IN (${INLIST}) GROUP BY run_id ORDER BY first`).all(...KINDS);
    for (let i = 0; i < runs.length && remaining > target; i++) {
      const r = runs[i];
      if (i < runs.length - 1) { remaining -= Number(r.b); cut = Math.max(cut, Number(r.last)); continue; } // a whole run, oldest first
      // the newest run alone is over the cap: its oldest events go
      for (const e of E.store.db.prepare(`SELECT seq, bytes FROM memory_event WHERE kind IN (${INLIST}) AND run_id IS ? AND seq > ? ORDER BY seq`).iterate(...KINDS, r.run_id, cut)) {
        if (remaining <= target) break;
        remaining -= Number(e.bytes || 0); cut = Math.max(cut, Number(e.seq));
      }
    }
    const removed = cut > 0 ? Number(E.store.p(`DELETE FROM memory_event WHERE kind IN (${INLIST}) AND seq <= ?`).run(...KINDS, cut).changes) : 0;
    resync(E);
    return removed;
  });
}

// Adds a written row's bytes to the counter; past the cap, schedules one prune for after the answer. Never throws.
function account(E, added, capMb) {
  try {
    const cap = (Number(capMb) > 0 ? Number(capMb) : 500) * 1048576;
    const have = counter(E);
    const total = have === null ? resync(E) : have + added; // a counter built now already counts the row just written
    if (have !== null) setCounter(E, total);
    if (total > cap && !E._searchPrunePending) {
      E._searchPrunePending = true;
      setImmediate(() => {
        E._searchPrunePending = false;
        try { pruneTo(E, Math.floor(cap * LOW_WATER)); } catch { /* the store may be closing; the next write schedules again */ }
      });
    }
  } catch { /* the log is a record, never the search's failure */ }
}

// record(E, caller, { kind, tier, query, mode, namespaces, k, offset, ranks, ms, fallback, capMb, for_worker, for_task }) -> the event row or null.
function record(E, caller, o) {
  try {
    if (!E.owner) return null; // a copy writes nothing
    const { recordEventSync } = require('./methods-ledger.cjs'); // lazily: the read path loads this file
    const q = typeof o.query === 'string' ? redact(o.query).text : null;
    const cut = q !== null && q.length > QUERY_MAX;
    const t = o.tier || {};
    const harness = caller.channel === 'harness';
    const fallback = o.fallback && Array.isArray(o.fallback.failed)
      ? { ...o.fallback, failed: o.fallback.failed.map(f => ({ ...f, message: scrub(f.message) })) } : (o.fallback || null);
    const detail = {
      v: 1, role: caller.role, worker_id: caller.worker_id || null, for_worker: harness ? o.for_worker || null : null, for_task: harness ? o.for_task || null : null,
      channel: caller.channel || null,
      tier: { profile: t.profile || null, embedder: t.embedder || null, reranker: t.reranker || null, device: t.device || null },
      ...(o.pinned_tier ? { pinned_tier: { profile: o.pinned_tier.profile || null, embedder: o.pinned_tier.embedder || null, reranker: o.pinned_tier.reranker || null, device: o.pinned_tier.device || null } } : {}), // an index ranks on nano whatever the worker's tier is: `tier` is what served, `pinned_tier` what the worker was pinned with
      mode: o.mode || null, namespaces: o.namespaces || null, k: o.k ?? null, offset: o.offset ?? 0,
      query: cut ? q.slice(0, QUERY_MAX) : q, query_cut: cut,
      ranks: o.ranks || [], ms: o.ms || {}, fallback,
    };
    const message = JSON.stringify(detail);
    const ids = detail.ranks.map(r => r.id);
    const rowIds = ids.length ? ids : undefined;
    const bytes = bytesOf(message) + bytesOf(rowIds ? JSON.stringify(rowIds) : null);
    const ev = recordEventSync(E, caller, {
      kind: o.kind === 'index' ? 'index' : 'search', ...(o.code ? { code: o.code } : {}), worker_id: caller.worker_id || undefined, task_id: detail.for_task || undefined, row_ids: rowIds, message, bytes,
    }, { prescrubbed: true, searchLog: true });
    account(E, bytes, o.capMb);
    return ev;
  } catch { return null; }
}

module.exports = { record, account, pruneTo, QUERY_MAX, COUNTER };
