'use strict';
// memory-relevance.cjs — how well each memory.index candidate fits the task in hand (ADR 0042 decision 2,
// amendment "relevance"). Without it the index ranks rows that carry no files and no task id by recency
// alone, so every task of a project is shown the same newest rows.
//
// Two signals, both read-only and both embedder-free:
//   - keyword: BM25 from FTS5's bm25() over the trigram index (memory_fts), queried with the task text's
//     salient terms joined by OR;
//   - semantic: cosine over the stored row vectors, only when the caller hands in a query embedding. This
//     module never embeds anything, so the read path never loads a model.
// With both, the two rankings are fused by reciprocal rank (fusion.cjs) with memory.search's hybrid weights (alpha 0.3, or the
// run's memory.alpha lever; k 10); with one, its own score is used.
//
// Why OR: memory.search joins by OR as well (fts-query.cjs). The index answers "which rows are most worth showing",
// and a task text is a paragraph, not a query: no row contains every word of it, so AND would match
// nothing. OR lets BM25 weigh each shared term by its rarity across the store, so a term every row carries
// (the project's name) counts for almost nothing and a rare one (TZ, CRLF) counts most.
//
// Nothing here writes, reads the clock or depends on iteration order: equal scores stay equal and the caller
// breaks ties by its own keys, ending with the id.

const { toMatch, MIN_TERM, MAX_TERMS, BM25 } = require('./fts-query.cjs');
const { rrfMany, HYBRID_ALPHA, HYBRID_K } = require('./fusion.cjs');
const { ftsReady } = require('./memory-schema.cjs');
const { err } = require('./errors.cjs');

const QUERY_MAX = 65536; // bytes of query text accepted; at most CANDIDATE_TERMS distinct terms of it are weighed
const DIM_MAX = 8192;
const QUERIES_MAX = 8; // query vectors in one call

// Function words carry no topic.
const FUNCTION_WORDS = `
about above after again against all also and any are aren because been before being below between both but
can cannot could did does doing done down during each either else even ever every few for from further had
has have having her here hers him his how however into its itself just let like may might more most much
must not now off once only other our ours out over own same she should since some such than that the their
theirs them then there these they this those through too under until upon very was were what when where
whether which while who whom whose why will with within without would yet you your yours`;
// The vocabulary of being given a task, not of what it is about. A spec often opens with the same framing for
// every task ("you are working in the repository at the current directory ... reply with a summary of what
// you changed"). Those words are rare in a project's store, so BM25 would weigh them above the task's own.
// Other generic words stay: BM25 discounts any term most rows share.
const FRAMING_WORDS = `
work working repository directory current project memory summary task tasks reply finish change changed
make used using`;
const STOPWORDS = new Set(`${FUNCTION_WORDS} ${FRAMING_WORDS}`.trim().split(/\s+/));

const bad = (msg, field) => err('E_ARGS', msg, field ? { field } : undefined);
const marks = (list) => list.map(() => '?').join(', ');

// memory.index's relevance arguments. Returns null fields for what was not given.
function parseArgs(args) {
  let query = null;
  if (args.query != null) {
    if (typeof args.query !== 'string' || !args.query.trim()) throw bad('memory.index query must be a non-empty string', 'query');
    if (Buffer.byteLength(args.query, 'utf8') > QUERY_MAX) throw bad(`memory.index query must be at most ${QUERY_MAX} bytes`, 'query');
    query = args.query;
  }
  const checkVector = (v, field) => {
    if (!Array.isArray(v) || !v.length || v.length > DIM_MAX || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
      throw bad(`memory.index ${field} must be an array of 1 to ${DIM_MAX} finite numbers`, field);
    }
    return v;
  };
  const checkModel = (m, field) => {
    if (m != null && (typeof m !== 'string' || !m)) throw bad(`memory.index ${field} must be a non-empty string`, field);
    return m || null;
  };
  // The query vectors: `query_embeddings` ([{ vector, model?, label? }]), and the single `query_embedding` (with
  // `embedding_model`) as an alias for one more, labelled 'query'. Each is its own semantic ranking in the fusion.
  const queries = [];
  if (args.query_embeddings != null) {
    const l = args.query_embeddings;
    if (!Array.isArray(l) || !l.length || l.length > QUERIES_MAX) throw bad(`memory.index query_embeddings must be an array of 1 to ${QUERIES_MAX} entries`, 'query_embeddings');
    l.forEach((q, i) => {
      if (!q || typeof q !== 'object') throw bad(`memory.index query_embeddings[${i}] must be { vector, model?, label? }`, 'query_embeddings');
      if (q.label != null && (typeof q.label !== 'string' || !q.label || q.label.length > 64)) throw bad(`memory.index query_embeddings[${i}].label must be a string of 1 to 64 characters`, 'query_embeddings');
      queries.push({ vector: checkVector(q.vector, `query_embeddings[${i}].vector`), model: checkModel(q.model, `query_embeddings[${i}].model`), label: q.label || `q${i + 1}` });
    });
  }
  const model = checkModel(args.embedding_model, 'embedding_model');
  if (args.query_embedding != null) {
    if (queries.length >= QUERIES_MAX) throw bad(`memory.index takes at most ${QUERIES_MAX} query vectors`, 'query_embedding');
    queries.push({ vector: checkVector(args.query_embedding, 'query_embedding'), model, label: 'query' });
  }
  return { query, queries, queryEmbedding: queries.length ? queries[0].vector : null, embeddingModel: model };
}

// A plural stem: the trigram index matches substrings, so "date" finds dates and dated alike. Only a plural
// `s` and an `-ing` are stripped (their removal leaves a prefix of the other forms), never below four
// characters; `-ed` is kept, since "stored" cut to "stor" matched every row naming store.cjs.
function stem(t) {
  if (t.endsWith('ing') && [...t].length - 3 >= 4) return t.slice(0, -3);
  if (t.endsWith('s') && !/(ss|us|is)$/.test(t) && [...t].length - 1 >= 4) return t.slice(0, -1);
  return t;
}

// A trigram phrase matches inside words, so a short plain word is noise ("day" in "today", "old" in
// "holds"). Plain words need four characters; an identifier-shaped term (a flag such as --csv, a path, a
// dotted name, a digit, an inner capital) keeps the trigram minimum of three.
const PLAIN_MIN = 4;
const CANDIDATE_TERMS = 128;

// The task text's candidate terms with how often the text uses each, at most `cap`, in a fixed order. Words
// split on anything that is not a letter, digit, `_`, `.`, `/` or `-`, so paths and identifiers
// (src/dates.cjs, usage.fail) stay whole. Order: identifier-shaped first, then the more often the text repeats
// it, then the longer, then the earlier. `score` keeps at most MAX_TERMS, choosing by rarity in the store.
function termStats(text, cap = CANDIDATE_TERMS) {
  if (typeof text !== 'string' || !text) return [];
  const seen = new Map();
  let pos = 0;
  for (const raw of text.split(/[^\p{L}\p{N}_./-]+/u)) {
    const trimmed = raw.replace(/^[._/-]+|[._/-]+$/g, '');
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    const shaped = /^-/.test(raw) || /[._/\d-]/.test(trimmed) || /\p{Ll}\p{Lu}/u.test(trimmed);
    if ([...lower].length < (shaped ? MIN_TERM : PLAIN_MIN) || STOPWORDS.has(lower)) continue;
    const t = shaped ? lower : stem(lower); // a path or identifier is matched as written
    if (STOPWORDS.has(t)) continue; // "changes" stems to a stopword
    const cur = seen.get(t);
    if (cur) { cur.count++; cur.shaped = cur.shaped || shaped; } else seen.set(t, { t, count: 1, shaped, at: pos++ });
  }
  return [...seen.values()]
    .sort((a, b) => (b.shaped - a.shaped) || (b.count - a.count) || ([...b.t].length - [...a.t].length) || (a.at - b.at))
    .slice(0, cap)
    .map(({ t, count }) => ({ t, count }));
}
const termsOf = (text, cap) => termStats(text, cap).map((x) => x.t);

// Every matching row of the stated namespaces, with its bm25() for one FTS5 expression.
function matchRows(db, match, namespaces) {
  return db.prepare(`SELECT e.id AS id, ${BM25} AS bm FROM memory_fts JOIN memory_entries e ON e.rowid = memory_fts.rowid
    WHERE memory_fts MATCH ? AND e.namespace IN (${marks(namespaces)})`).all(match, ...namespaces);
}

// The terms the keyword score uses: those that occur in at least one row of the stated namespaces, rarest
// first, at most MAX_TERMS. A term no row holds cannot change a score, so it never takes a slot, and the
// rarest terms are the ones BM25 weighs most. Ties keep termStats's order. Each comes back with its rows.
function selectTerms(db, stats, namespaces) {
  const found = [];
  stats.forEach((s, i) => {
    const m = toMatch(s.t);
    if (m.error) return;
    const rows = matchRows(db, m.match, namespaces);
    if (rows.length) found.push({ ...s, rows, i });
  });
  return found.sort((a, b) => (a.rows.length - b.rows.length) || (a.i - b.i)).slice(0, MAX_TERMS);
}

// The FTS5 OR expression of a term list: fts-query.cjs quotes every term as a phrase (so no operator in the
// text is parsed), and phrases are joined by OR. A term never holds a double quote.
function orMatch(terms) {
  const m = toMatch(terms.join(' '));
  if (m.error) return null;
  return m.match;
}

// FTS5's bm25() of an OR query is the sum, over its phrases, of each phrase's own bm25(); it is computed here
// term by term so each term can carry its query-term frequency (BM25's qtf: a term the task text repeats
// counts that many times; tests check that unit weights give the OR query's own bm25). bm25() is negative
// for a match and lower is better, so a score is its negation.
function keywordScores(selected, ids) {
  const out = new Map();
  for (const s of selected) {
    for (const r of s.rows) if (ids.has(r.id) && r.bm < 0) out.set(r.id, (out.get(r.id) || 0) - s.count * r.bm);
  }
  return out;
}

// Cosine between the query and each candidate's stored vector, per namespace, checked against the model the
// namespace is bound to. A namespace that cannot be compared is named, never skipped silently.
function semanticScores(db, cands, q, model) {
  const out = new Map();
  const failed = [];
  let qn = 0;
  for (const x of q) qn += x * x;
  qn = Math.sqrt(qn);
  if (!(qn > 0)) return { out, failed: [{ code: 'E_ARGS', message: 'the query embedding has zero length' }] };
  const byNs = new Map();
  for (const c of cands) { if (!byNs.has(c.namespace)) byNs.set(c.namespace, []); byNs.get(c.namespace).push(c.id); }
  for (const [ns, ids] of [...byNs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const m = db.prepare('SELECT embedding_model, dim FROM namespace_models WHERE namespace = ?').get(ns);
    if (!m) continue; // no embedded rows in this namespace: nothing to compare, nothing withheld
    if (model && model !== m.embedding_model) { failed.push({ code: 'E_MODEL', namespace: ns, message: `the query was embedded with ${model} but namespace ${ns} is bound to ${m.embedding_model}` }); continue; }
    if (m.dim !== q.length) { failed.push({ code: 'E_MODEL', namespace: ns, message: `the query has ${q.length} dimensions but namespace ${ns} holds ${m.dim}` }); continue; }
    const got = db.prepare(`SELECT id, embedding FROM memory_entries WHERE id IN (${marks(ids)})`).all(...ids);
    for (const r of got) {
      if (!r.embedding || r.embedding.byteLength !== m.dim * 4) continue;
      const v = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, m.dim);
      let dot = 0, vn = 0;
      for (let d = 0; d < m.dim; d++) { dot += v[d] * q[d]; vn += v[d] * v[d]; }
      const s = vn > 0 ? dot / (qn * Math.sqrt(vn)) : 0;
      if (s > 0) out.set(r.id, s);
    }
  }
  return { out, failed };
}

// The run's `memory.alpha` lever, the weight memory.search uses when a call gives none (methods-memory.cjs runAlpha; not required here:
// this is a read module). `lv` is the run's parsed levers or null; null back means the built-in default.
const alphaOf = (lv) => (lv && typeof lv.alpha === 'number' && lv.alpha >= 0 && lv.alpha <= 1 ? lv.alpha : null);

const desc = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);

// score(E, cands, { text, source, queries: [{ vector, model, label }], namespaces, alpha }) → { scores: Map id→number,
// info }. `cands` are the index's candidate rows ({ id, namespace }). A row absent from `scores` has zero
// relevance. `info` is null when there was nothing to rank against, else it says what ran and what did not.
function score(E, cands, o) {
  const scores = new Map();
  const queries = o.queries || [];
  if (!o.text && !queries.length) return { scores, info: null };
  const db = E.store.db;
  const ids = new Set(cands.map((c) => c.id));
  const cand = termStats(o.text);
  const info = { source: o.source, terms: [], keyword: 'ran', semantic: queries.length ? 'ran' : 'not_requested', matched: 0 };

  let kw = new Map();
  if (!o.text) info.keyword = 'not_requested';
  else if (!cand.length) info.keyword = { code: 'E_QUERY_SHORT', message: 'the task text has no term long enough for the trigram index outside the stopwords; keyword relevance did not run' };
  else if (!ftsReady(db)) info.keyword = { code: 'E_NO_INDEX', message: 'this store has no keyword index; keyword relevance did not run' };
  else {
    // A term no row holds leaves every score at zero: with none left the ranking is the old one, and that is
    // a finding (matched 0), not a failure.
    try {
      const selected = selectTerms(db, cand, o.namespaces);
      info.terms = selected.map((x) => x.t);
      kw = keywordScores(selected, ids);
    } catch (e) {
      info.keyword = { code: /no such (table|column)|malformed/i.test(e.message) ? 'E_NO_INDEX' : 'E_INTERNAL', message: `the keyword index could not be read: ${e.message}` };
    }
  }

  // One semantic ranking per query vector. `semantic_lists` says how many candidates each matched, and
  // `semantic_contributed` is true only when some list matched a candidate (a project with no embedded rows is keyword-only).
  const sems = [];
  const failed = [];
  if (queries.length) {
    info.semantic_lists = [];
    for (const q of queries) {
      const s = semanticScores(db, cands, q.vector, q.model || o.embeddingModel || null);
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
  return { scores, info };
}

module.exports = { QUERIES_MAX, alphaOf, parseArgs, termsOf, termStats, selectTerms, orMatch, keywordScores, score, STOPWORDS, QUERY_MAX };
