'use strict';
// search-tier.cjs — what memory.search needs to serve a retrieval tier (ADR 0050, amendment 1). Four things live here so that
// memory-search.cjs stays a search and not a tier manager:
//   - the tier: `tierFor(E, caller)` is the seam. Today it returns the default (nano, no reranker); it will read the tier pinned on
//     the worker row at spawn. A request never names its tier (invariant 3): memory-search takes a tier only as an internal argument.
//   - the candidate vectors: the semantic stage reads them from the vector cache (memory-vectors.cjs) under the tier's key. A store
//     with no cache table (an older core never migrated it, or a copy made before it existed) is read from the inline column, as
//     search did before the cache.
//   - the rerank step and its failure policy (on_heavy_failure), and the rank record the search log keeps.
//   - a heavy tier's refusal: it never serves a partial index (E_TIER_BEHIND).
// The embedder is never required here (invariant 9); the rerank provider registry is a plain map.

const { err } = require('./errors.cjs');
const RP = require('./retrieval-profiles.cjs');
const VT = require('./memory-vectors.cjs');
const { DEFAULTS } = require('./memory-levers.cjs');
const { leversOf, notifyEmbedderFailure, adviseEmbedderFailure } = require('./methods-memory.cjs');
const { rerank } = require('./rerank-stage.cjs');
const SL = require('./search-log.cjs');

const NANO_TIER = Object.freeze({ profile: RP.FALLBACK_PROFILE, embedder: RP.NANO, reranker: null, device: 'cpu', depth: 0, source: 'default' });
const isNano = (tier) => !!tier && tier.embedder === RP.NANO;

// The tier this caller's searches run on. The seam: the default today, the tier pinned at spawn later.
function tierFor(E, caller) { // eslint-disable-line no-unused-vars
  return NANO_TIER;
}

// The levers a search reads, from the built-in defaults, the run's own levers, then an internal override (tests).
function leversOfSearch(E, caller, over) {
  const run = leversOf(E, caller) || {};
  const pick = (k) => (over && over[k] !== undefined ? over[k] : run[k] !== undefined ? run[k] : DEFAULTS[k]);
  return { rerank_depth: pick('rerank_depth'), rerank_bound_ms: pick('rerank_bound_ms'), on_heavy_failure: pick('on_heavy_failure'), search_log_cap_mb: pick('search_log_cap_mb') };
}

// ---- candidates ---------------------------------------------------------------------------------------------------

// The { embedding_model, dim } the tier's vectors in `ns` are under: nano is bound per namespace (namespace_models); a heavy
// embedder is the tier's own. Null when the namespace has nothing to compare.
function binding(E, tier, ns) {
  if (isNano(tier)) return E.store.p('SELECT embedding_model, dim FROM namespace_models WHERE namespace = ?').get(ns) || null;
  if (!Number.isInteger(tier.dims) || tier.dims < 1) throw err('E_ARGS', `the tier's embedder ${tier.embedder} has no dims, so its vectors cannot be read`, { embedder: tier.embedder });
  return { embedding_model: tier.embedder, dim: tier.dims };
}
// The namespace's row count for the exact-scan ceiling. Read from the store's namespace cache, as before the vector cache: the
// existing ceiling test replaces `_loadNs` to fake a large namespace. (A COUNT(*) would not need the inline blobs resident; moving to it
// means changing that test's seam.)
const countRows = (E, ns) => E.store._loadNs(ns).rows.length;
const f32 = (blob) => new Float32Array(Uint8Array.from(blob).buffer);

// The cache key of the tier's vectors in `ns`. Nano's revision is the one its rows were embedded under (a row's own revision is
// part of its key); a heavy embedder's is the tier's.
function keyFor(db, tier, ns, m) {
  if (!isNano(tier)) return { model: tier.embedder, revision: tier.revision || '', dims: tier.dims };
  const r = db.prepare('SELECT embedding_revision AS rev FROM memory_entries WHERE namespace = ? AND embedding_model = ? AND dim = ? AND embedding IS NOT NULL LIMIT 1').get(ns, m.embedding_model, m.dim);
  return { model: m.embedding_model, revision: (r && r.rev) || '', dims: m.dim };
}

// [{ id, vec }] for the rows of `ns` the semantic scan may score: visible by the shared rule (memory-vectors visibleRowFilter),
// not hidden by the caller's gate, inside the caller's filter, with a vector under the tier.
function candidates(E, tier, ns, m, o, slow = false) {
  const db = E.store.db;
  let allowed = null;
  if (o.filterSql.where) allowed = new Set(db.prepare(`SELECT e.id FROM memory_entries e WHERE e.namespace = ? AND ${o.filterSql.where}`).all(ns, ...o.filterSql.params).map(r => r.id));
  const keep = (id) => !allowed || allowed.has(id);
  if (slow && isNano(tier)) return inline(E, ns, o, keep);
  if (!VT.hasTable(db)) { // E_NO_INDEX territory: no cache table, so read the inline column exactly as search did before the cache
    if (!isNano(tier)) throw err('E_NO_INDEX', 'this store has no vector cache (memory_vectors), and a heavy tier has no inline vectors to read');
    return inline(E, ns, o, keep);
  }
  const sel = VT.selectSearchable(db, keyFor(db, tier, ns, m), { namespaces: [ns], includeSuperseded: o.includeSuperseded, hidden: o.hidden });
  const out = [];
  for (const r of sel.rows) if (keep(r.id)) out.push({ id: r.id, vec: r.vector });
  if (isNano(tier) && sel.missing.length) { // a row the cache has no vector for but whose own inline vector is nano's still counts
    const ids = sel.missing.filter(keep);
    if (ids.length) {
      for (const r of db.prepare('SELECT id, embedding, embedding_model, dim FROM memory_entries WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids))) {
        if (r.embedding && r.embedding_model === m.embedding_model && r.dim === m.dim) out.push({ id: r.id, vec: f32(r.embedding) });
      }
    }
  }
  return out;
}

function inline(E, ns, o, keep) {
  const t = Date.now(), c = E.store._loadNs(ns), hidden = o.hidden, out = [];
  for (const r of c.rows) {
    if (!r.vec || (r.ttl_at && r.ttl_at < t) || (!o.includeSuperseded && c.superseded.has(r.id)) || !keep(r.id) || (hidden && hidden.has(r.id))) continue;
    out.push({ id: r.id, vec: r.vec });
  }
  return out;
}

// A heavy tier never serves a partial index: a note in scope without the tier's vector refuses the search, by name.
function assertServable(E, tier, namespaces) {
  if (isNano(tier)) return;
  const key = binding(E, tier, namespaces[0]);
  const behind = VT.backlog(E.store.db, { model: tier.embedder, revision: tier.revision || '', dims: key.dim }, { namespaces });
  if (behind.length) {
    throw err('E_TIER_BEHIND', `the ${tier.embedder} tier is ${behind.length} note${behind.length === 1 ? '' : 's'} behind in ${namespaces.join(', ')}, and a heavy tier never serves a partial index; drain its backlog (belay memory embed --model ${tier.embedder}) or search on the nano tier`, { embedder: tier.embedder, behind: behind.length, namespaces, ids: behind.slice(0, 20).map(b => b.id) });
  }
}

// ---- rerank ---------------------------------------------------------------------------------------------------------

const rerankText = (row) => {
  const t = VT.embedTextOf(row, VT.renderTemplateOf(row));
  return t === null ? row.text : t;
};

// Reranks the head of `ranked` when the tier has a reranker. Returns { ranked, info, failed } where `info` is the answer's `rerank`
// field (null when the tier has no reranker) and `failed` is the modes_failed entry for a stage that did not run. On failure:
// on_heavy_failure `fallback` returns the fusion order and says so; `pause` tells the run's hook (the ADR 0034 path) and throws.
async function rerankHead(E, caller, o, ranked, rowsOf, lv) {
  const tier = o.tier;
  if (!tier.reranker) return { ranked, info: null, failed: null };
  if (o.order !== 'score') return { ranked, info: { ran: false, reason: 'the order is not score, so there is no relevance order to refine' }, failed: null };
  if (!ranked.length) return { ranked, info: { ran: false, reason: 'no candidates' }, failed: null };
  const depth = Math.min(tier.depth > 0 ? tier.depth : lv.rerank_depth, ranked.length);
  const rows = rowsOf(ranked.slice(0, depth).map(h => h.id));
  try {
    const r = await rerank({ tier, query: o.query, ranked, textOf: (id) => (rows.has(id) ? rerankText(rows.get(id)) : null), depth, boundMs: lv.rerank_bound_ms });
    return { ranked: r.ranked, info: r.info, failed: null };
  } catch (e) {
    if (lv.on_heavy_failure === 'pause') {
      notifyEmbedderFailure(E, caller, 'memory.search', e);
      adviseEmbedderFailure(E, caller, e);
      throw e;
    }
    const cause = { code: e.code || 'E_INTERNAL', reason: e.detail && e.detail.reason ? e.detail.reason : null, message: e.message };
    return { ranked, info: { ran: false, skipped: true, cause }, failed: { mode: 'rerank', code: cause.code, message: cause.message } };
  }
}

// [{ id, before, after }]: the place of each of the first `cap` results after fusion and after the reranker.
function rankRecord(before, after, cap) {
  const pos = new Map(before.map((h, i) => [h.id, i + 1]));
  return after.slice(0, cap).map((h, i) => ({ id: h.id, before: pos.get(h.id) || null, after: i + 1 }));
}

module.exports = {
  NANO_TIER, isNano, tierFor, leversOfSearch, binding, countRows, candidates, assertServable, rerankHead, rankRecord,
  visibleRowFilter: VT.visibleRowFilter, logSearch: SL.record,
  logIndex: (E, caller, o) => SL.record(E, caller, { kind: 'index', tier: tierFor(E, caller), ...o, capMb: leversOfSearch(E, caller).search_log_cap_mb }),
};
