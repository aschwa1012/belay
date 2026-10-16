'use strict';
// memory-index-rank.cjs — which notes the first-message index considers, and how relevant each is to the task.
//
// The candidates are the UNION of
//   - a vector top-200 over the whole live scope (one list per query vector),
//   - a keyword top-200 over the same scope,
//   - a path top-200: the notes whose `applies_to` paths match the task's `files_owned`, ranked by path idf over the whole store
//     (not over the candidates), and
//   - the newest 200 notes (the pad: it keeps a small store whole, and a note no ranking matched can still be listed),
// not the newest 1,000: the newest-N cap lost the target once a store held more than N notes (offline/scale/REPORT.md). The order is
// the hybrid relevance score, a reciprocal-rank fusion of the FULL vector list(s) and the FULL keyword list with the run's
// `memory.alpha` (the fusion memory.search uses), so a note's score does not depend on how many candidates were cut. Path match is
// a tiebreaker after relevance (path_mode 'tiebreak', the default) or a third fused list (path_mode 'rrf': it adds (1 - alpha) /
// (k + path rank), the keyword list's weight). With no relevance signal and no path match the candidates are the newest 1,000, as before.
//
// The scope is the live notes of the namespaces the caller may see: memory-note-gate.cjs decides that, once, for the index,
// memory.search, memory.list and memory.timeline. A read: every statement is a SELECT, the embedding library is never loaded (the
// vectors come from the store's own cache, the query vector from the caller).
//
// The vector pass is ONE sweep over the namespace's rows for all query vectors (each row is read once and dotted with every vector).
// The WHOLE index build has a time bound (index_bound_ms, 1,500 ms by default, counted from the start of memory.index). The vector
// sweep is the last and the largest step, so it is the one that degrades: when the bound is passed before it starts or while it runs,
// the vector lists are dropped, and the keyword, path and newest candidates stand. The receipt (candidates.degraded) says what was
// dropped, why and after how long. A bounded result can therefore depend on load: the same call may keep its vector lists on an idle
// machine and drop them on a busy one, and that is what the receipt is for.

const relevance = require('./memory-relevance.cjs');
const { rrfMany, HYBRID_ALPHA, HYBRID_K } = require('./fusion.cjs');
const { ftsReady } = require('./memory-schema.cjs');
const { toUnitF32 } = require('./store.cjs');
const gate = require('./memory-note-gate.cjs');

const TOP = 200; // candidates taken from each ranking
const NEWEST = 1000; // the fallback when nothing ranks
const PAD = 200; // the newest notes added to the union
const INDEX_BOUND_MS = 1500; // the whole index build; past it the vector lists are dropped and the receipt says why
const PATH_MODES = ['tiebreak', 'rrf'];

const marks = (list) => list.map(() => '?').join(', ');
const desc = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);

// The ids of the live notes in `namespaces` the caller may see, newest first.
function liveIds(E, caller, namespaces) {
  const g = gate.sql(E, caller, { namespaces }); // the body clauses are tested on the candidate rows (bodyLive in memory-index-notes.cjs)
  const sql = `SELECT e.id FROM memory_entries e WHERE e.namespace IN (${marks(namespaces)}) AND e.type = 'note'
      AND COALESCE(e.status, 'unverified') <> 'refuted' AND (e.ttl_at IS NULL OR e.ttl_at >= ?)
      AND NOT EXISTS (SELECT 1 FROM memory_entries s WHERE s.supersedes = e.id AND +s.namespace = e.namespace)${g ? ` AND ${g.where}` : ''}
    ORDER BY e.created_at DESC, e.id ASC`;
  return E.store.db.prepare(sql).all(...namespaces, Date.now(), ...(g ? g.params : [])).map((r) => r.id);
}

// Cosines of every query vector against every allowed note of the namespaces, in ONE sweep of each namespace's rows (the store's vector
// cache holds unit vectors, so a dot product). Returns { lists: [Map id -> cosine per query], failed: [{ index, code, message }],
// bounded }. A query that cannot be compared with a namespace is named in `failed`, never skipped silently. `deadline` is an absolute
// time on `clock` (default Date.now); `bounded` is { reason } when the sweep was past it (the lists are then to be dropped).
function cosinesMany(E, namespaces, allowed, queries, defaultModel, deadline = Infinity, clock = Date.now) {
  const lists = queries.map(() => new Map());
  const failed = [];
  let bounded = null;
  for (const ns of [...namespaces].sort()) {
    const m = E.store.db.prepare('SELECT embedding_model, dim FROM namespace_models WHERE namespace = ?').get(ns);
    if (!m) continue;
    const use = []; // { j, u }
    queries.forEach((q, j) => {
      const model = q.model || defaultModel || null;
      if (model && model !== m.embedding_model) { failed.push({ index: j, code: 'E_MODEL', message: `the query was embedded with ${model} but namespace ${ns} is bound to ${m.embedding_model}` }); return; }
      if (m.dim !== q.vector.length) { failed.push({ index: j, code: 'E_MODEL', message: `the query has ${q.vector.length} dimensions but namespace ${ns} holds ${m.dim}` }); return; }
      try { use.push({ j, u: toUnitF32(q.vector, m.dim) }); } catch (e) { failed.push({ index: j, code: e.code || 'E_ARGS', message: `the query embedding is unusable: ${e.message}` }); }
    });
    if (!use.length) continue;
    const dim = m.dim, body = dim - (dim % 4), nq = use.length;
    const us = use.map((x) => x.u), outs = use.map((x) => lists[x.j]);
    let n = 0;
    for (const r of E.store._loadNs(ns).rows) {
      const v = r.vec;
      if (!v || v.length !== dim || !allowed.has(r.id)) continue;
      if ((n++ & 255) === 0 && clock() >= deadline) { bounded = { reason: `the index passed its time bound during the vector sweep of ${ns}` }; break; }
      for (let j = 0; j < nq; j++) {
        const q = us[j];
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0, d = 0;
        for (; d < body; d += 4) { s0 += v[d] * q[d]; s1 += v[d + 1] * q[d + 1]; s2 += v[d + 2] * q[d + 2]; s3 += v[d + 3] * q[d + 3]; }
        for (; d < dim; d++) s0 += v[d] * q[d];
        const s = s0 + s1 + s2 + s3;
        if (s > 0) outs[j].set(r.id, s);
      }
    }
    if (bounded) break;
  }
  return { lists, failed, bounded };
}

// pool: ids newest first. o: { text, source, queries, embeddingModel, alpha, pathIds (ids whose paths match the task, best first),
// pathMode, deadline (absolute, on `clock`), boundMs (for the receipt), clock }. Returns { ids, scores: Map id -> fused relevance, info, candidates }.
function select(E, namespaces, pool, o) {
  const allowed = new Set(pool);
  const queries = o.queries || [];
  const pathIds = (o.pathIds || []).filter((id) => allowed.has(id));
  const pathMode = o.pathMode || 'tiebreak';
  const scores = new Map();
  const info = { source: o.source, terms: [], keyword: 'ran', semantic: queries.length ? 'ran' : 'not_requested', matched: 0 };
  const cand = { source: 'newest', scope: pool.length, vector: 0, keyword: 0, path: 0, union: 0, padding: 0, total: 0, path_mode: pathMode };
  const db = E.store.db;
  const alpha = o.alpha === undefined || o.alpha === null ? HYBRID_ALPHA : o.alpha;

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
    const clock = o.clock || Date.now;
    const deadline = o.deadline === undefined ? Infinity : o.deadline;
    const sweep = clock() >= deadline
      ? { lists: [], failed: [], bounded: { reason: 'the index had already passed its time bound before the vector sweep started' } }
      : cosinesMany(E, namespaces, allowed, queries, o.embeddingModel, deadline, clock);
    for (const f of sweep.failed) failed.push({ label: queries[f.index].label, code: f.code, message: f.message });
    if (sweep.bounded) {
      info.semantic = { code: 'E_INDEX_BOUND', message: sweep.bounded.reason };
      cand.degraded = { dropped: ['vector lists'], kept: ['keyword', 'path', 'newest'], reason: sweep.bounded.reason, bound_ms: o.boundMs === undefined ? null : o.boundMs, elapsed_ms: o.started === undefined ? null : clock() - o.started };
      info.semantic_lists = queries.map((q) => ({ label: q.label, matched: 0 }));
    } else {
      sweep.lists.forEach((out, j) => {
        info.semantic_lists.push({ label: queries[j].label, matched: out.size });
        if (out.size) sems.push(out);
      });
      if (failed.length === queries.length) info.semantic = { code: failed[0].code, message: failed.map((f) => f.message).join('; ') };
      else if (failed.length) info.semantic_failed = failed;
    }
  }
  info.semantic_contributed = sems.length > 0;

  if (sems.length && (kw.size || sems.length > 1)) {
    for (const h of rrfMany(sems.map(desc), desc(kw), { alpha, k: HYBRID_K })) scores.set(h.id, h.score);
    info.fusion = { method: 'rrf', alpha, k: HYBRID_K, lists: sems.length };
  } else for (const [id, s] of (kw.size ? kw : (sems[0] || new Map()))) scores.set(id, s);
  info.matched = scores.size;
  const vec = new Set(sems.flatMap((m) => desc(m).slice(0, TOP)));
  const key = new Set(desc(kw).slice(0, TOP));
  if (pathMode === 'rrf' && pathIds.length) { // the path list as a third fused list, at the keyword list's weight
    if (!info.fusion) { // one list alone carries a raw score (bm25 or cosine): put it on the rank scale the fusion uses
      scores.clear();
      if (kw.size) desc(kw).forEach((id, i) => scores.set(id, (1 - alpha) / (HYBRID_K + i + 1)));
      else if (sems[0]) desc(sems[0]).forEach((id, i) => scores.set(id, alpha / (HYBRID_K + i + 1)));
    }
    pathIds.forEach((id, i) => scores.set(id, (scores.get(id) || 0) + (1 - alpha) / (HYBRID_K + i + 1)));
    info.path_fusion = { method: 'rrf', weight: 1 - alpha, k: HYBRID_K, matched: pathIds.length };
  }
  const path = new Set(pathIds.slice(0, TOP));

  if (!vec.size && !key.size && !path.size) { // nothing ranked: the newest notes
    cand.total = Math.min(pool.length, NEWEST);
    return { ids: pool.slice(0, NEWEST), scores, info: o.text || queries.length ? info : null, candidates: cand };
  }
  const ranked = new Set([...vec, ...key, ...path]);
  const ids = [...new Set([...ranked, ...pool.slice(0, PAD)])];
  Object.assign(cand, {
    source: [sems.length && kw.size ? 'hybrid' : sems.length ? 'vector' : kw.size ? 'keyword' : '', path.size ? 'path' : ''].filter(Boolean).join('+'),
    vector: vec.size, keyword: key.size, path: path.size, union: ranked.size, padding: ids.length - ranked.size, total: ids.length,
  });
  return { ids, scores, info: o.text || queries.length ? info : null, candidates: cand };
}

// The sinking seam. A note's relevance is multiplied by sinkFactor(note, ctx) in the index ranking. It returns 1 for every note and
// every notes_sink mode: the operator has gated a live penalty until pinning, a calibration and the simulation arms exist
// (the operator's sinking ruling of 2026-10-15), and `penalty` records exactly like `record`. The
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

module.exports = { liveIds, select, sinkFactor, sunk, cosinesMany, TOP, NEWEST, PAD, PATH_MODES, INDEX_BOUND_MS };
