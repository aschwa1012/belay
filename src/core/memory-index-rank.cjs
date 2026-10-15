'use strict';
// memory-index-rank.cjs — which notes the first-message index considers, and how relevant each is to the task.
//
// The candidates are the UNION of a vector top-200 over the whole live scope and a keyword top-200 over the same scope,
// not the newest 1,000: the newest-N cap lost the target once a store held more than N notes (offline/scale/REPORT.md). Their
// order is the hybrid relevance score, a reciprocal-rank fusion of the FULL vector list(s) and the FULL keyword list with the run's
// `memory.alpha` (the fusion memory.search uses), so a note's score does not depend on how many candidates were cut.
// The union is padded with the newest 200 notes (they rank after every note that matched, by the tiers). With no relevance signal (no task text and no query vector, or neither matched a note) the candidates are the newest 1,000
// as before, and the source says so.
//
// The scope is the live notes of the namespaces the caller may see: memory-note-gate.cjs decides that, once, for the
// index, memory.search and memory.list. A read: every statement is a SELECT, the embedding library is never loaded (the
// vectors come from the store's own cache, the query vector from the caller).

const relevance = require('./memory-relevance.cjs');
const { rrfMany, HYBRID_ALPHA, HYBRID_K } = require('./fusion.cjs');
const { ftsReady } = require('./memory-schema.cjs');
const { toUnitF32 } = require('./store.cjs');
const gate = require('./memory-note-gate.cjs');

const TOP = 200; // candidates taken from each ranking
const NEWEST = 1000; // the fallback when nothing ranks
const PAD = 200; // the newest notes added to the union, so a small store is listed whole and path and term notes that match no text still compete

const marks = (list) => list.map(() => '?').join(', ');
const desc = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);

// The ids of the live notes in `namespaces` the caller may see, newest first.
function liveIds(E, caller, namespaces) {
  const g = gate.sql(E, caller);
  const sql = `SELECT e.id FROM memory_entries e WHERE e.namespace IN (${marks(namespaces)}) AND e.type = 'note'
      AND COALESCE(e.status, 'unverified') <> 'refuted' AND (e.ttl_at IS NULL OR e.ttl_at >= ?)
      AND NOT EXISTS (SELECT 1 FROM memory_entries s WHERE s.supersedes = e.id AND +s.namespace = e.namespace)${g ? ` AND ${g.where}` : ''}
    ORDER BY e.created_at DESC, e.id ASC`;
  return E.store.db.prepare(sql).all(...namespaces, Date.now(), ...(g ? g.params : [])).map((r) => r.id);
}

// Cosine of one query vector against every allowed note of the namespaces, from the store's vector cache (unit vectors, so a dot
// product). A namespace that cannot be compared is named in `failed`, never skipped silently.
function cosines(E, namespaces, allowed, q, model) {
  const out = new Map(), failed = [];
  for (const ns of [...namespaces].sort()) {
    const m = E.store.db.prepare('SELECT embedding_model, dim FROM namespace_models WHERE namespace = ?').get(ns);
    if (!m) continue;
    if (model && model !== m.embedding_model) { failed.push({ code: 'E_MODEL', message: `the query was embedded with ${model} but namespace ${ns} is bound to ${m.embedding_model}` }); continue; }
    if (m.dim !== q.length) { failed.push({ code: 'E_MODEL', message: `the query has ${q.length} dimensions but namespace ${ns} holds ${m.dim}` }); continue; }
    let u;
    try { u = toUnitF32(q, m.dim); } catch (e) { failed.push({ code: e.code || 'E_ARGS', message: `the query embedding is unusable: ${e.message}` }); continue; }
    for (const r of E.store._loadNs(ns).rows) {
      if (!r.vec || !allowed.has(r.id) || r.vec.length !== m.dim) continue;
      let s = 0;
      for (let d = 0; d < m.dim; d++) s += r.vec[d] * u[d];
      if (s > 0) out.set(r.id, s);
    }
  }
  return { out, failed };
}

// pool: ids newest first. o: { text, source, queries, embeddingModel, alpha }.
// Returns { ids, scores: Map id -> fused relevance, info, candidates: { source, scope, vector, keyword, union, padding, total } }.
function select(E, namespaces, pool, o) {
  const allowed = new Set(pool);
  const queries = o.queries || [];
  const scores = new Map();
  const info = { source: o.source, terms: [], keyword: 'ran', semantic: queries.length ? 'ran' : 'not_requested', matched: 0 };
  const cand = { source: 'newest', scope: pool.length, vector: 0, keyword: 0, union: 0, padding: 0, total: 0 };
  if (!o.text && !queries.length) {
    cand.total = Math.min(pool.length, NEWEST);
    return { ids: pool.slice(0, NEWEST), scores, info: null, candidates: cand };
  }
  const db = E.store.db;

  let kw = new Map();
  const terms = o.text ? relevance.termStats(o.text) : [];
  if (!o.text) info.keyword = 'not_requested';
  else if (!terms.length) info.keyword = { code: 'E_QUERY_SHORT', message: 'the task text has no term long enough for the trigram index outside the stopwords; keyword relevance did not run' };
  else if (!ftsReady(db)) info.keyword = { code: 'E_NO_INDEX', message: 'this store has no keyword index; keyword relevance did not run' };
  else {
    try {
      const selected = relevance.selectTerms(db, terms, namespaces);
      info.terms = selected.map((x) => x.t);
      kw = relevance.keywordScores(selected, allowed);
    } catch (e) {
      info.keyword = { code: /no such (table|column)|malformed/i.test(e.message) ? 'E_NO_INDEX' : 'E_INTERNAL', message: `the keyword index could not be read: ${e.message}` };
    }
  }

  const sems = [], failed = [];
  if (queries.length) {
    info.semantic_lists = [];
    for (const q of queries) {
      const s = cosines(E, namespaces, allowed, q.vector, q.model || o.embeddingModel || null);
      if (s.failed.length) failed.push(...s.failed.map((f) => ({ label: q.label, code: f.code, message: f.message })));
      info.semantic_lists.push({ label: q.label, matched: s.out.size });
      if (s.out.size) sems.push(s.out);
    }
    if (failed.length === queries.length) info.semantic = { code: failed[0].code, message: failed.map((f) => f.message).join('; ') };
    else if (failed.length) info.semantic_failed = failed;
  }
  info.semantic_contributed = sems.length > 0;

  const alpha = o.alpha === undefined || o.alpha === null ? HYBRID_ALPHA : o.alpha;
  if (sems.length && (kw.size || sems.length > 1)) {
    for (const h of rrfMany(sems.map(desc), desc(kw), { alpha, k: HYBRID_K })) scores.set(h.id, h.score);
    info.fusion = { method: 'rrf', alpha, k: HYBRID_K, lists: sems.length };
  } else for (const [id, s] of (kw.size ? kw : (sems[0] || new Map()))) scores.set(id, s);
  info.matched = scores.size;

  if (!scores.size) { // nothing ranked: the newest notes, as when there is no signal
    cand.total = Math.min(pool.length, NEWEST);
    return { ids: pool.slice(0, NEWEST), scores, info, candidates: cand };
  }
  const vec = new Set(sems.flatMap((m) => desc(m).slice(0, TOP)));
  const key = new Set(desc(kw).slice(0, TOP));
  const ranked = new Set([...vec, ...key]);
  const ids = [...new Set([...ranked, ...pool.slice(0, PAD)])];
  Object.assign(cand, { source: sems.length && kw.size ? 'hybrid' : sems.length ? 'vector' : 'keyword', vector: vec.size, keyword: key.size, union: ranked.size, padding: ids.length - ranked.size, total: ids.length });
  return { ids, scores, info, candidates: cand };
}

// The sinking seam. A note's relevance is multiplied by sinkFactor(note, ctx) in the index ranking. It returns 1 for every note and
// every notes_sink mode: the operator has gated a live penalty until pinning, a calibration and the simulation arms exist
// (the notes-lifecycle rulings, Sinking), and `penalty` records exactly like `record`. The
// notes-lifecycle owner fills this function in; the miss definition it needs is not built, so nothing here counts misses.
// note: { id, b (parsed body), status }; ctx: { lv (the run's levers), runId }.
function sinkFactor(note, ctx) { // eslint-disable-line no-unused-vars
  return 1;
}

// The scores with the seam applied (a new Map; the input is not changed).
function sunk(notes, scores, ctx) {
  const out = new Map(scores);
  for (const n of notes) if (out.has(n.id)) out.set(n.id, out.get(n.id) * sinkFactor(n, ctx));
  return out;
}

module.exports = { liveIds, select, sinkFactor, sunk, TOP, NEWEST };
