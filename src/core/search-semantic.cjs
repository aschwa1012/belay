'use strict';
// search-semantic.cjs — memory.search's semantic stage (moved out of memory-search.cjs): the query vector, from the caller, the heavy tier's
// embed provider or the shared embedding phase, then the exact cosine scan over the tier's candidates. It requires no embedder module.

const { err } = require('./errors.cjs');
const { scanCeiling } = require('./schema.cjs');
const { toUnitF32 } = require('./store.cjs');
const gate = require('./memory-note-gate.cjs');
const ST = require('./search-tier.cjs');
const HE = require('./heavy-embed.cjs');
const { withEmbedding } = require('./methods-memory.cjs');

async function queryVector(E, caller, o, lv) {
  if (o.queryEmbedding) return { vec: o.queryEmbedding, model: o.embeddingModel || null };
  // A heavy tier's query is embedded by the owner's heavy embed provider (heavy-embed.cjs); a failure is decided by on_heavy_failure.
  if (!ST.isNano(o.tier)) {
    const h = await HE.queryVector(E, caller, o, lv);
    if (h.vec) return h;
    o.tier = h.fallback.tier; o.tierFallback = h.fallback; // served on the fallback profile, and the answer says so
  }
  // The shared embedding phase: loads on first use, raises E_NO_EMBEDDER, E_MODEL_ABSENT or E_MODEL_CHANGED, and
  // reports a failure to the ADR 0034 hook. A keyword stage never reaches this.
  const e = await withEmbedding(E, { query: o.query }, 'query_embedding', 'query', caller);
  return { vec: e.query_embedding, model: e.embedding_model };
}

// Exact cosine over the tier's cached unit vectors (search-tier.cjs candidates) of every stated namespace, restricted to the filter.
// Returns the best `depth` hits best first. The scan ceiling, the model binding and the dimension are enforced as before.
async function semanticStage(E, caller, o, depth, lv) {
  const { vec, model: qModel } = await queryVector(E, caller, o, lv);
  const scored = [];
  const cos = new Map(); // every scanned row's cosine, below min_score too: a keyword-only hit's relevance and the absence claim read it
  let scanned = 0, model = null, dim = null;
  for (const ns of o.namespaces) {
    const m = ST.binding(E, o.tier, ns);
    if (!m) continue;
    if (qModel && qModel !== m.embedding_model) {
      throw err('E_MODEL', `the query was embedded with ${qModel} but namespace ${ns} is bound to ${m.embedding_model}`, { namespace: ns, bound: m.embedding_model });
    }
    model = model || m.embedding_model; dim = dim || m.dim;
    const q = toUnitF32(vec, m.dim);
    const total = ST.countRows(E, ns), ceiling = scanCeiling(m.dim);
    if (total > ceiling && !o.allowSlow) {
      throw err('E_NAMESPACE_TOO_LARGE', `namespace ${ns} holds ${total} rows, above the ${ceiling}-row exact-scan ceiling; pass allow_slow to scan it anyway`, { namespace: ns, rows: total, ceiling });
    }
    const legacy = gate.legacyIds(E, caller, ns); // the project's rows that are not notes, hidden from a gated caller in a notes run
    for (const r of ST.candidates(E, o.tier, ns, m, legacy ? { ...o, legacy } : o)) {
      scanned++;
      let s = 0;
      for (let d = 0; d < m.dim; d++) s += r.vec[d] * q[d];
      cos.set(r.id, s);
      if (s >= o.minScore) scored.push({ id: r.id, score: s });
    }
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return { hits: scored.slice(0, depth), scanned, model, dim, cos };
}

module.exports = { queryVector, semanticStage };
