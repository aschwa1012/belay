'use strict';
// search-tier.cjs — what memory.search needs to serve a retrieval tier (ADR 0050, amendment 1). Four things live here so that
// memory-search.cjs stays a search and not a tier manager:
//   - the tier: `tierFor(E, caller)` is the seam. Today it returns the default (nano, no reranker); it will read the tier pinned on
//     the worker row at spawn. A request never names its tier (invariant 3): memory-search takes a tier only as an internal argument.
//   - the candidate vectors: nano scans the resident inline vectors of the namespace cache as search always did (the vector cache is
//     consulted only for a row with no inline vector, and a store without the cache table has none); a heavy tier reads its own
//     vectors from the vector cache (memory-vectors.cjs), loaded once per namespace.
//   - the rerank step and its failure policy (on_heavy_failure), and the rank record the search log keeps.
//   - a heavy tier's refusal: it never serves a partial index (E_TIER_BEHIND).
// The embedder is never required here (invariant 9); the rerank provider registry is a plain map.

const { err } = require('./errors.cjs');
const RP = require('./retrieval-profiles.cjs');
const VT = require('./memory-vectors.cjs');
const { DEFAULTS } = require('./memory-levers.cjs');
const { leversOf, notifyEmbedderFailure } = require('./methods-memory.cjs');
const { rerank } = require('./rerank-stage.cjs');
const SL = require('./search-log.cjs');

const NANO_TIER = Object.freeze({ profile: RP.FALLBACK_PROFILE, embedder: RP.NANO, reranker: null, device: 'cpu', depth: 0, source: 'default' });
const BOUND_MAX_MS = 110000;
const isNano = (tier) => !!tier && tier.embedder === RP.NANO;

// The tier this caller's searches run on. The seam: the default today, the tier pinned at spawn later.
function tierFor(E, caller) { // eslint-disable-line no-unused-vars
  return NANO_TIER;
}

// The levers a search reads, from the built-in defaults, the run's own levers, then an internal override (tests).
function leversOfSearch(E, caller, over) {
  const run = leversOf(E, caller) || {};
  const pick = (k) => (over && over[k] !== undefined ? over[k] : run[k] !== undefined ? run[k] : DEFAULTS[k]);
  // The rerank bound stays under the MCP tool timeout whatever a lever says (110 s at most).
  return { rerank_depth: pick('rerank_depth'), rerank_bound_ms: Math.min(Number(pick('rerank_bound_ms')) || 10000, BOUND_MAX_MS), on_heavy_failure: pick('on_heavy_failure'), search_log_cap_mb: pick('search_log_cap_mb') };
}

// ---- candidates ---------------------------------------------------------------------------------------------------

// The { embedding_model, dim } the tier's vectors in `ns` are under: nano is bound per namespace (namespace_models); a heavy
// embedder is the tier's own. Null when the namespace has nothing to compare.
function binding(E, tier, ns) {
  if (isNano(tier)) return E.store.p('SELECT embedding_model, dim FROM namespace_models WHERE namespace = ?').get(ns) || null;
  if (!Number.isInteger(tier.dims) || tier.dims < 1) throw err('E_ARGS', `the tier's embedder ${tier.embedder} has no dims, so its vectors cannot be read`, { embedder: tier.embedder });
  return { embedding_model: tier.embedder, dim: tier.dims };
}
// The namespace's row count for the exact-scan ceiling. It reads the store's namespace cache, which the nano scan below uses too, so it
// adds no cost.
const countRows = (E, ns) => E.store._loadNs(ns).rows.length;

// The cache revision under which nano's content-keyed vectors in `ns` sit: the revision most of its rows were embedded under, ties
// broken by name (N2: a namespace may hold rows of more than one revision; the choice is deterministic). Only the rows that lack an
// inline vector need it.
function nanoKey(E, ns, m) {
  const r = E.store.p(`SELECT COALESCE(embedding_revision, '') AS rev, COUNT(*) AS n FROM memory_entries WHERE namespace = ? AND embedding_model = ? AND dim = ?
    AND embedding IS NOT NULL GROUP BY rev ORDER BY n DESC, rev ASC LIMIT 1`).get(ns, m.embedding_model, m.dim);
  return { model: m.embedding_model, revision: r ? r.rev : '', dims: m.dim };
}

// A heavy tier's vectors for the rows of `ns`: id -> Float32Array. Loaded once per (tier key, namespace) and kept on the namespace cache
// object the Store keeps (store.cjs _loadNs), so every hook that drops or edits that cache drops this one too; each row's embed hash is
// computed once per load. A load that finds a row without a vector is NOT kept (the backlog may be drained by a writer that does not go
// through the Store), so a kept cache is always complete.
function heavyVectors(E, tier, ns, c) {
  const db = E.store.db;
  if (!VT.hasTable(db)) throw err('E_NO_INDEX', 'this store has no vector cache (memory_vectors), so a heavy tier has nothing to read');
  const key = `${tier.embedder}\u0000${tier.revision || ''}\u0000${tier.dims}`;
  if (c.heavy && c.heavy.has(key)) return c.heavy.get(key);
  const h = new Map();
  for (const [id, f] of VT.vectorsFor(db, { model: tier.embedder, revision: tier.revision || '', dims: tier.dims }, c.rows.map(r => r.id))) h.set(id, f.vector);
  if (c.rows.every(r => h.has(r.id))) (c.heavy || (c.heavy = new Map())).set(key, h);
  return h;
}

// [{ id, vec }] for the rows of `ns` the semantic scan may score, inside the caller's filter and not hidden by its gate.
//   nano: the resident inline vectors of the namespace cache, exactly as search read them before the vector cache (no per-row hashing,
//     no per-row blob read). Only a row with no inline vector (a cleared one: a v2 note found through its content vector) is looked up in
//     memory_vectors; a store without that table has none.
//   heavy: the tier's vectors (heavyVectors). A visible row without one throws E_TIER_BEHIND, so a heavy tier never serves a partial
//     index even for a note written after assertServable looked.
// Expiry: ttl_at 0 reads as no expiry (as the shared visibility rule does).
function candidates(E, tier, ns, m, o) {
  const db = E.store.db, c = E.store._loadNs(ns), t = Date.now(), hidden = o.hidden;
  let allowed = null;
  if (o.filterSql.where) allowed = new Set(db.prepare(`SELECT e.id FROM memory_entries e WHERE e.namespace = ? AND ${o.filterSql.where}`).all(ns, ...o.filterSql.params).map(r => r.id));
  const live = (r) => !((r.ttl_at && r.ttl_at < t) || (!o.includeSuperseded && c.superseded.has(r.id)) || (allowed && !allowed.has(r.id)) || (hidden && hidden.has(r.id)));
  const out = [], lacking = [];
  if (isNano(tier)) {
    for (const r of c.rows) { if (!live(r)) continue; if (r.vec) out.push({ id: r.id, vec: r.vec }); else lacking.push(r.id); }
    if (lacking.length && VT.hasTable(db)) for (const [id, f] of VT.vectorsFor(db, nanoKey(E, ns, m), lacking)) out.push({ id, vec: f.vector });
    return out;
  }
  const h = heavyVectors(E, tier, ns, c);
  for (const r of c.rows) { if (!live(r)) continue; const v = h.get(r.id); if (v) out.push({ id: r.id, vec: v }); else lacking.push(r.id); }
  if (lacking.length) throw behindError(tier, [ns], lacking);
  return out;
}

function behindError(tier, namespaces, ids) {
  return err('E_TIER_BEHIND', `the ${tier.embedder} tier is ${ids.length} note${ids.length === 1 ? '' : 's'} behind in ${namespaces.join(', ')}, and a heavy tier never serves a partial index; drain its backlog (belay memory embed --model ${tier.embedder}) or search on the nano tier`, { embedder: tier.embedder, behind: ids.length, namespaces, ids: ids.slice(0, 20) });
}

// A heavy tier never serves a partial index: a note in scope (every visible one, held and superseded included, as the backlog counts) without
// the tier's vector refuses the search, by name. A store with no cache table is not refused here: the semantic stage fails with E_NO_INDEX
// and a hybrid search answers from keywords (N3).
function assertServable(E, tier, namespaces) {
  if (isNano(tier) || !VT.hasTable(E.store.db)) return;
  binding(E, tier, namespaces[0]); // E_ARGS for a tier without dims
  const t = Date.now(), behind = [];
  for (const ns of namespaces) {
    const c = E.store._loadNs(ns), h = heavyVectors(E, tier, ns, c);
    for (const r of c.rows) if (!(r.ttl_at && r.ttl_at < t) && !h.has(r.id)) behind.push(r.id);
  }
  if (behind.length) throw behindError(tier, namespaces, behind);
}

// ---- rerank ---------------------------------------------------------------------------------------------------------

const RERANK_TEXT_MAX = 2000;
// What the reranker reads of a row: a v2 note's title and its text (the body of the note, not the embedding template, which is only
// the title and a When line); a fact or v1 row's text. Cut at about 2,000 characters.
const rerankText = (row) => {
  const t = VT.renderTemplateOf(row) === 'v2' && row.title ? `${row.title}\n${row.text}` : row.text;
  return t.length > RERANK_TEXT_MAX ? t.slice(0, RERANK_TEXT_MAX) : t;
};

// A provider failure is sticky for the rest of the run (ADR 0050 decision 6): the first one is kept per run id on the engine, in memory,
// and later searches of that run skip the provider and say so. A search with no query text is not a provider failure and is not sticky.
const STICKY = new Set(['timeout', 'error', 'absent', 'malformed']);
const stickyOf = (E) => E._rerankFallback || (E._rerankFallback = new Map());

const pauseAdvice = (caller) => (caller.role === 'worker'
  ? 'Stop and wait: do not run belay commands; the operator will resume the run.'
  : `Tell the operator (belay status shows the run); fix the reranker, or set on_heavy_failure to fallback, then belay resume ${caller.run_id}.`);

// Reranks the head of `ranked` when the tier has a reranker. Returns { ranked, info, failed } where `info` is the answer's `rerank`
// field (null when the tier has no reranker) and `failed` is the modes_failed entry for a stage that did not run. On failure:
// on_heavy_failure `fallback` returns the fusion order and says so; `pause` tells the run's hook (the ADR 0034 path, with a
// stage: 'rerank' marker the guard pauses on whatever the embedder mode is) and throws.
async function rerankHead(E, caller, o, ranked, rowsOf, lv) {
  const tier = o.tier;
  if (!tier.reranker) return { ranked, info: null, failed: null };
  if (o.order !== 'score') return { ranked, info: { ran: false, reason: 'the order is not score, so there is no relevance order to refine' }, failed: null };
  if (!ranked.length) return { ranked, info: { ran: false, reason: 'no candidates' }, failed: null };
  const sticky = stickyOf(E), run = String(caller.run_id ?? '');
  if (sticky.has(run)) {
    const first = sticky.get(run);
    const cause = { code: 'E_RERANK', reason: 'fallback_sticky', first_cause: first, message: `the reranker failed earlier in this run (${first.reason}: ${first.message}), so reranking stays off for the rest of it` };
    return { ranked, info: { ran: false, skipped: true, cause }, failed: { mode: 'rerank', code: cause.code, message: cause.message } };
  }
  const depth = Math.min(tier.depth > 0 ? tier.depth : lv.rerank_depth, ranked.length);
  const rows = rowsOf(ranked.slice(0, depth).map(h => h.id));
  try {
    const r = await rerank({ tier, query: o.query, ranked, textOf: (id) => (rows.has(id) ? rerankText(rows.get(id)) : null), depth, boundMs: lv.rerank_bound_ms });
    return { ranked: r.ranked, info: r.info, failed: null };
  } catch (e) {
    if (lv.on_heavy_failure === 'pause') {
      e.detail = { ...e.detail, advised: true }; // the reranker's own advice below; adviseEmbedderFailure's text is about the embedder
      e.message = `${e.message} ${pauseAdvice(caller)}`;
      notifyEmbedderFailure(E, caller, 'memory.search', e);
      throw e;
    }
    const cause = { code: e.code || 'E_INTERNAL', reason: e.detail && e.detail.reason ? e.detail.reason : null, message: e.message };
    if (STICKY.has(cause.reason)) sticky.set(run, cause);
    return { ranked, info: { ran: false, skipped: true, cause }, failed: { mode: 'rerank', code: cause.code, message: cause.message } };
  }
}

// [{ id, before, after }]: the place of each of the first `cap` results after fusion and after the reranker.
// Recorded only for a score order (another order has no relevance order to compare); at most 200 entries.
function rankRecord(before, after, cap, order = 'score') {
  if (order !== 'score') return [];
  cap = Math.min(cap, 200);
  const pos = new Map(before.map((h, i) => [h.id, i + 1]));
  return after.slice(0, cap).map((h, i) => ({ id: h.id, before: pos.get(h.id) || null, after: i + 1 }));
}

module.exports = {
  NANO_TIER, isNano, tierFor, leversOfSearch, binding, countRows, nanoKey, candidates, assertServable, rerankHead, rankRecord,
  visibleRowFilter: VT.visibleRowFilter, logSearch: SL.record,
  logIndex: (E, caller, o) => SL.record(E, caller, { kind: 'index', tier: tierFor(E, caller), ...o, capMb: leversOfSearch(E, caller).search_log_cap_mb }),
};
