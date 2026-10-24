'use strict';
// memory-search.cjs — the memory read methods (api.md §3, ADR 0040 §2): layered, filtered, hybrid search with
// the honesty contract, plus timeline, get_many, get and list. Every function is (E, caller, args).
//
// Reading never writes: nothing here touches accessed_at, and every statement is a SELECT. Nothing here
// requires the embedder module; the one vector this file ever needs is the query's, asked of the engine's
// getEmbedder() provider, which a read copy does not have. The honesty contract: a search names the modes
// that ran and the modes that failed, and `absence_established` is true only when BOTH ran over the stated
// namespaces and filter and found nothing. A weaker result carries a `warning`, the first key of the object.

const { err } = require('./errors.cjs');
const { BM25, DEFAULT_PAGE } = require('./fts-query.cjs');
const { pickTerms, orMatch } = require('./memory-relevance.cjs');
const { rrf, HYBRID_ALPHA, HYBRID_K } = require('./fusion.cjs');
const { deriveTitle, indexRowOf, dupVeto, filterSql } = require('./memory-rows.cjs');
const { ftsReady } = require('./memory-schema.cjs');
const { scanCeiling } = require('./schema.cjs');
const { toUnitF32 } = require('./store.cjs');
const gate = require('./memory-note-gate.cjs');
const W = require('./memory-withhold.cjs');
const { notesDefaults } = require('./memory-search-scope.cjs');
const { nsFor, resolveNamespace, runAlpha, withEmbedding, reachOf, checkReach, runEmbedderMode } = require('./methods-memory.cjs');

const MODES = ['semantic', 'keyword', 'hybrid'];
const VIEWS = ['full', 'index'];
const SCOPES = ['task', 'worker', 'run', 'namespace'];
const NS_MAX = 10, OFFSET_MAX = 1000, K_MAX = 100, ID_MAX = 50, SPAN_MAX = 50, LIST_MAX = 500, DEPTH_MAX = 1200;
// ADR 0040 amendment (hybrid default): rrf k=10, alpha 0.3, OR join, chosen by the second hybrid evaluation.
const DEFAULT_ALPHA = HYBRID_ALPHA, RRF_K = HYBRID_K, DUP_THRESHOLD = 0.95;

const bad = (msg, field) => err('E_ARGS', msg, field ? { field } : undefined);
const marks = list => list.map(() => '?').join(', ');
const asCode = e => (e && typeof e.code === 'string' && e.code.startsWith('E_') ? e.code : 'E_INTERNAL');

function intArg(name, v, dflt, min, max) {
  if (v === undefined || v === null) return dflt;
  if (!Number.isInteger(v) || v < min || v > max) throw bad(`${name} must be an integer from ${min} to ${max}`, name);
  return v;
}
function numArg(name, v, dflt) {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < -1 || v > 1) throw bad(`${name} must be a number from -1 to 1`, name);
  return v;
}
function enumArg(name, v, allowed, dflt) {
  if (v === undefined || v === null) return dflt;
  if (!allowed.includes(v)) throw bad(`${name} must be one of ${allowed.join(', ')}`, name);
  return v;
}
// The namespaces a read covers, held to the caller's reach: a worker reads only its run's namespace and its run's
// project (methods-memory.cjs reachOf); the orchestrator and the operator read any.
function namespacesOf(E, caller, args) {
  let out;
  if (args.namespaces === undefined || args.namespaces === null) out = [nsFor(E, caller, args)];
  else {
    if (args.namespace) throw bad('pass namespace or namespaces, not both', 'namespaces');
    const l = args.namespaces;
    if (!Array.isArray(l) || !l.length || l.length > NS_MAX || l.some(x => typeof x !== 'string' || !x)) {
      throw bad(`namespaces must be an array of 1 to ${NS_MAX} non-empty strings`, 'namespaces');
    }
    out = [...new Set(l.map(x => resolveNamespace(E, caller, x)))];
  }
  checkReach(E, caller, out, 'read');
  return out;
}
// A row a worker may not read is reported as not found, by id as by search: its existence is not the worker's to learn.
const visible = (reach, r) => !reach || reach.has(r.namespace);
// A read by explicit id also leaves out the lifecycle namespaces for a gated tool-channel caller (the orchestrator has no reach to stop it).
// ...and a row of the project that is not a note, for a gated caller in a notes run (`legacy`, from gate.legacyHidden).
const readable = (caller, reach, r, legacy = false) => visible(reach, r) && !gate.inLifecycle(caller, r.namespace) && !(legacy && gate.isLegacy(r));

const parseJson = s => { if (s == null) return null; try { return JSON.parse(s); } catch { return s; } };

// A row as a caller sees it: no vector, tags parsed, status and title always present (the title is derived
// at read time and never written back), the structured body and the redaction counts as objects.
function fullRow(r) {
  const { embedding, ...rest } = r;
  return {
    ...rest, written_by: r.written_by ?? null, tags: parseJson(rest.tags), has_embedding: !!embedding,
    status: r.status || 'unverified', title: r.title || deriveTitle(r.text),
    body: parseJson(r.body), redactions: parseJson(r.redactions),
  };
}
const viewRow = (r, view, score) => (view === 'index' ? indexRowOf(r, score) : fullRow(r));

function rowsByIds(E, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of E.store.db.prepare(`SELECT * FROM memory_entries WHERE id IN (${marks(chunk)})`).all(...chunk)) out.set(r.id, r);
  }
  return out;
}

// ---- the two stages ---------------------------------------------------------------------------------------

async function queryVector(E, caller, o) {
  if (o.queryEmbedding) return { vec: o.queryEmbedding, model: o.embeddingModel || null };
  // The shared embedding phase: loads on first use, raises E_NO_EMBEDDER, E_MODEL_ABSENT or E_MODEL_CHANGED, and
  // reports a failure to the ADR 0034 hook. A keyword stage never reaches this.
  const e = await withEmbedding(E, { query: o.query }, 'query_embedding', 'query', caller);
  return { vec: e.query_embedding, model: e.embedding_model };
}

// Exact cosine over the cached unit vectors of every stated namespace, restricted to the filter. Returns the
// best `depth` hits best first. The scan ceiling, the model binding and the dimension are enforced as before.
async function semanticStage(E, caller, o, depth) {
  const { vec, model: qModel } = await queryVector(E, caller, o);
  const db = E.store.db;
  const scored = [];
  let scanned = 0, model = null, dim = null;
  const t = Date.now();
  for (const ns of o.namespaces) {
    const m = E.store.p('SELECT embedding_model, dim FROM namespace_models WHERE namespace = ?').get(ns);
    if (!m) continue;
    if (qModel && qModel !== m.embedding_model) {
      throw err('E_MODEL', `the query was embedded with ${qModel} but namespace ${ns} is bound to ${m.embedding_model}`, { namespace: ns, bound: m.embedding_model });
    }
    model = model || m.embedding_model; dim = dim || m.dim;
    const q = toUnitF32(vec, m.dim);
    const c = E.store._loadNs(ns);
    const ceiling = scanCeiling(m.dim);
    if (c.rows.length > ceiling && !o.allowSlow) {
      throw err('E_NAMESPACE_TOO_LARGE', `namespace ${ns} holds ${c.rows.length} rows, above the ${ceiling}-row exact-scan ceiling; pass allow_slow to scan it anyway`, { namespace: ns, rows: c.rows.length, ceiling });
    }
    let allowed = null;
    if (o.filterSql.where) {
      allowed = new Set(db.prepare(`SELECT e.id FROM memory_entries e WHERE e.namespace = ? AND ${o.filterSql.where}`).all(ns, ...o.filterSql.params).map(r => r.id));
    }
    const hidden = o.hidden; // the notes the gate hides (a small set): one lookup per row
    const legacy = gate.legacyIds(E, caller, ns); // the project's rows that are not notes, hidden from a gated caller in a notes run
    for (const r of c.rows) {
      if (!r.vec || (r.ttl_at && r.ttl_at < t) || (!o.includeSuperseded && c.superseded.has(r.id)) || (allowed && !allowed.has(r.id)) || (hidden && hidden.has(r.id)) || (legacy && legacy.has(r.id))) continue;
      scanned++;
      let s = 0;
      for (let d = 0; d < m.dim; d++) s += r.vec[d] * q[d];
      if (s >= o.minScore) scored.push({ id: r.id, score: s });
    }
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return { hits: scored.slice(0, depth), scanned, model, dim, note: model ? undefined : 'namespace has no embedded rows' };
}

const fail = (code, message) => ({ failed: { code, message } });

// FTS5 over title and text (trigram), restricted to the stated namespaces and filter, expired and superseded
// rows excluded as the semantic scan excludes them. The terms come from the one extractor memory.index also uses
// (memory-relevance pickTerms): stopwords, too-short terms, terms in half the rows or more (zero IDF) and terms over
// the cap are left out, and each is named with its reason in `dropped`. A row that matches only left-out terms matches
// nothing. Never throws for a reason the caller can act on: the result names it, so a missing index is "keyword did not
// run", never an empty list. A query whose every term was left out for being uninformative did not run either; one whose
// informative terms sit in no row ran and found nothing.
function keywordStage(E, o, depth, base) {
  const db = E.store.db;
  if (!ftsReady(db)) return fail('E_NO_INDEX', 'this store has no keyword index (it was never opened by a current owner, or this SQLite has no FTS5); keyword search did not run');
  if (typeof o.query !== 'string') return fail('E_QUERY_SHORT', 'a keyword search needs query text; only a vector was supplied');
  try {
    const { terms, dropped } = pickTerms(db, o.query, o.namespaces, { rows: false });
    if (!terms.length && !dropped.some(d => d.reason === 'no-row')) {
      const why = dropped.length ? dropped.map(d => `${d.term}: ${d.reason}`).join(', ') : 'the query has no words';
      return fail('E_QUERY_SHORT', `the query has no term the keyword index can rank (${why}); keyword search did not run`);
    }
    if (!terms.length) return { hits: [], dropped };
    const rows = db.prepare(`SELECT e.id AS id, ${BM25} AS bm FROM memory_fts JOIN memory_entries e ON e.rowid = memory_fts.rowid
      WHERE memory_fts MATCH ? AND ${base.where} ORDER BY ${BM25}, e.created_at DESC, e.id LIMIT ?`).all(orMatch(terms.map(t => t.t)), ...base.params, depth);
    return { hits: rows.map(r => ({ id: r.id, score: -r.bm })), dropped };
  } catch (e) {
    return fail(/no such (table|column)|malformed/i.test(e.message) ? 'E_NO_INDEX' : 'E_INTERNAL', `the keyword index could not be read: ${e.message}`);
  }
}

// The WHERE clause every keyword hit and the rows_considered count share (alias e).
function baseWhere(o) {
  const where = [`e.namespace IN (${marks(o.namespaces)})`, '(e.ttl_at IS NULL OR e.ttl_at >= ?)'];
  const params = [...o.namespaces, Date.now()];
  // The unary + keeps SQLite on ix_entries_supersedes for the inner lookup: on (namespace, created_at) it scans the
  // whole namespace per outer row, which is quadratic (minutes, not milliseconds, at ten thousand rows).
  if (!o.includeSuperseded) where.push('NOT EXISTS (SELECT 1 FROM memory_entries s WHERE s.supersedes = e.id AND +s.namespace = e.namespace)');
  if (o.filterSql.where) { where.push(o.filterSql.where); params.push(...o.filterSql.params); }
  if (o.gate) { where.push(o.gate.where); params.push(...o.gate.params); }
  return { where: where.join(' AND '), params };
}

// ---- search ------------------------------------------------------------------------------------------------

// The default mode: hybrid when there is a query string, semantic for a call that supplies only a vector.
function defaultMode(args) {
  return typeof args.query === 'string' ? 'hybrid' : 'semantic';
}

function parseSearch(E, caller, args) {
  if (!args.query_embedding && typeof args.query !== 'string') throw bad('memory.search needs a query string or a query_embedding');
  const mode = enumArg('mode', args.mode, MODES, defaultMode(args));
  if (mode === 'keyword' && typeof args.query !== 'string') throw bad('mode keyword needs a query string', 'query');
  // No alpha in the call: the run's memory.alpha lever, else the built-in default (the fusion block reports the one used).
  const lever = args.alpha === undefined ? runAlpha(E, caller) : null;
  const alpha = args.alpha === undefined ? (lever === null ? DEFAULT_ALPHA : lever) : args.alpha;
  if (typeof alpha !== 'number' || !(alpha >= 0 && alpha <= 1)) throw bad('alpha must be a number from 0 to 1', 'alpha');
  const order = enumArg('order', args.order, ['score', 'newest', 'oldest'], 'score');
  // A run with the notes lever on searches its project's notes unless the call names a scope (memory-search-scope.cjs).
  const scoped = notesDefaults(E, caller, args, args.filter == null ? {} : args.filter);
  const filter = scoped.filter;
  // The notes gate (memory-note-gate.cjs) is kept apart from the caller's filter: the keyword stage and the count add it to their WHERE,
  // the semantic stage subtracts the few rows it hides. Superseded rows are handled below (baseWhere, the cache), so the gate leaves them.
  const fsql = filterSql(filter, 'e');
  const namespaces = namespacesOf(E, caller, scoped.args);
  // Without the body clauses: they would scan every body of the namespace (about 55 ms at 10,000 notes). They are tested on the rows the
  // route returns instead (bodyLive, below), so rows_considered still counts a promoted or pending note.
  const gateSql = gate.sql(E, caller, { includeSuperseded: true, namespaces });
  return {
    gate: gateSql, hidden: gateSql ? new Set(JSON.parse(gateSql.params[0])) : null,
    mode, view: enumArg('view', args.view, VIEWS, 'full'), order, alpha, filter, filterSql: fsql,
    k: intArg('k', args.k, DEFAULT_PAGE, 1, K_MAX), offset: intArg('offset', args.offset, 0, 0, OFFSET_MAX),
    namespaces,
    query: typeof args.query === 'string' ? args.query : null,
    queryEmbedding: args.query_embedding || null, embeddingModel: args.embedding_model || null,
    minScore: numArg('min_score', args.min_score, -1), dupThreshold: numArg('dup_threshold', args.dup_threshold, DUP_THRESHOLD),
    includeSuperseded: !!args.include_superseded, allowSlow: !!args.allow_slow,
  };
}

function warningFor(o, ran, failed, results, absence, unembedded) {
  if (failed.length) {
    const did = failed.map(f => `${f.mode} search did not run (${f.code})`).join('; ');
    const what = ran.length ? `these are ${ran.join(' and ')} matches only` : 'nothing was searched';
    return `${did}; ${what}; no match here does not mean no such memory`;
  }
  if (results.length) return null;
  if (o.mode !== 'hybrid') {
    return `${o.mode} search only; ${o.mode === 'semantic' ? 'keyword' : 'semantic'} search did not run; no match here does not mean no such memory`;
  }
  if (unembedded) return `${unembedded} in-scope row${unembedded === 1 ? ' has' : 's have'} no vector, so semantic search could not see ${unembedded === 1 ? 'it' : 'them'}; keyword search alone covers ${unembedded === 1 ? 'it' : 'them'}; no match here does not mean no such memory`;
  if (!absence) return 'both modes ran but offset or min_score narrowed the result; an empty page does not mean no such memory';
  return null;
}

// What a hybrid search does when its semantic half fails, by where it runs and what failed. In a run (a worker or the orchestrator of a
// LIVE run) under `required` it does not answer from keywords alone:
//   - the copy fallback (no owner, no embedder: the owner was unreachable, not listening, backed off or timed out, quietly or with an
//     error): refused E_SEMANTIC_REQUIRED naming the cause. This process has no guard, so nothing here can pause the run;
//   - the owner's embedder failed (not found, load error, timeout): the guard heard of it in withEmbedding and paused the run, and the
//     error it advised is rethrown;
//   - anything else (a model mismatch, a dimension mismatch, a namespace over the scan ceiling): refused E_SEMANTIC_REQUIRED naming the
//     cause, and the guard is NOT told, since a resume fixes none of them.
// Under `keyword` the keyword answer stands and modes_failed names the cause; under `off` an embedder failure turned memory off and the call
// is refused (E_LEVER_OFF). With no live run (the operator's CLI, a standalone owner) the keyword fallback stays.
function onSemanticFailure(E, caller, e) {
  const run = runEmbedderMode(E, caller);
  if (!run.live) return;
  const guarded = run.source === 'guard';
  const embedderFailure = !!(e && e.detail && e.detail.embedder === true);
  if (guarded && embedderFailure && E.memoryOff('memory.search') === 'refuse') {
    throw err('E_LEVER_OFF', 'memory.search: memory is off for this run (on_embedder_failure off, after an embedder failure), so nothing is read or written through it', { lever: 'on_embedder_failure' });
  }
  if (run.mode === 'keyword') return;
  if (run.mode === 'off') { // memory is off for a run in this mode once its semantic half fails, whatever failed: refused
    throw err('E_LEVER_OFF', 'memory.search: memory is off for this run (on_embedder_failure off) and its semantic half cannot run (' + (E.embedderFailure ? E.embedderFailure.code : e.code) + '), so nothing is read through it', { lever: 'on_embedder_failure', cause: E.embedderFailure ? E.embedderFailure.code : e.code });
  }
  // required
  if (guarded && embedderFailure) throw e; // already told to the guard and advised (withEmbedding)
  const cause = guarded ? e : (E.embedderFailure ? E.embedderFailure : e);
  const why = guarded && !embedderFailure ? 'the semantic half failed for a reason a resume does not fix'
    : !guarded && !E.embedderFailure && e.code === 'E_EMBED_BOUND' ? 'the embedder of the owner did not answer in time'
      : 'the store owner could not be asked for a vector (it was unreachable, not listening, backed off or too slow)';
  const next = caller.role === 'worker'
    ? 'Stop and wait: do not run belay commands; the operator will resume the run.'
    : 'Tell the operator (belay status shows the run); fix the cause or switch the run with belay resume ' + caller.run_id + ' --embedder keyword|off.';
  throw err('E_SEMANTIC_REQUIRED', 'memory.search hybrid could not run its semantic half: ' + why + ' (' + cause.code + ': ' + cause.message + '), and the run embedder mode is required, so no keyword-only answer is given. ' + next, { cause: cause.code, mode: run.mode, run_id: caller.run_id, guarded });
}

async function search(E, caller, args) {
  const o = parseSearch(E, caller, args);
  const depth = o.order === 'score' ? Math.min(Math.max((o.offset + o.k) * 3, 60), DEPTH_MAX) : DEPTH_MAX;
  const base = baseWhere(o);
  const db = E.store.db;
  const considered = db.prepare(`SELECT COUNT(*) AS n FROM memory_entries e WHERE ${base.where}`).get(...base.params).n;

  const ran = [], failed = [];
  let sem = null, kw = null;
  if (o.mode !== 'keyword') {
    try { sem = await semanticStage(E, caller, o, depth); ran.push('semantic'); }
    catch (e) {
      if (o.mode === 'semantic') throw e; // unchanged: a semantic search that cannot run is refused by name
      onSemanticFailure(E, caller, e);
      failed.push({ mode: 'semantic', code: asCode(e), message: e.message });
    }
  }
  if (o.mode !== 'semantic') {
    const r = keywordStage(E, o, depth, base);
    if (r.failed) failed.push({ mode: 'keyword', code: r.failed.code, message: r.failed.message });
    else { kw = r; ran.push('keyword'); }
  }

  // One ranked list of { id, score, cosine?, ranks? }.
  let ranked, fusion = null;
  const cosine = new Map(sem ? sem.hits.map(h => [h.id, h.score]) : []);
  if (sem && kw) {
    ranked = rrf(sem.hits, kw.hits, { alpha: o.alpha, k: RRF_K }).map(h => ({ id: h.id, score: h.score, ranks: h.ranks }));
    fusion = { method: 'rrf', alpha: o.alpha, k: RRF_K };
  } else if (sem) ranked = sem.hits.map(h => ({ id: h.id, score: h.score }));
  else if (kw) ranked = kw.hits.map(h => ({ id: h.id, score: h.score }));
  else ranked = [];

  let rows = null;
  if (o.gate) { // the gate's body clauses (a promoted note, a pending state) on the rows the page is built from
    rows = rowsByIds(E, ranked.map(h => h.id));
    ranked = ranked.filter(h => rows.has(h.id) && gate.bodyLive(rows.get(h.id))); // (the project's legacy rows never get here: the keyword WHERE and the semantic scan leave them out)
  }
  let pool = ranked;
  if (o.order !== 'score') {
    rows = rows || rowsByIds(E, ranked.map(h => h.id));
    const dir = o.order === 'newest' ? -1 : 1;
    pool = ranked.filter(h => rows.has(h.id)).sort((a, b) => dir * (rows.get(a.id).created_at - rows.get(b.id).created_at) || (a.id < b.id ? -1 : 1));
  }
  const page = pool.slice(o.offset, o.offset + o.k);
  rows = rows || rowsByIds(E, page.map(h => h.id));
  const results = [];
  for (const h of page) {
    const r = rows.get(h.id);
    if (!r) continue; // deleted between the two reads
    const out = viewRow(r, o.view, h.score);
    if (o.view === 'full') {
      out.score = h.score;
      if (h.ranks) out.ranks = h.ranks;
      if (cosine.has(h.id)) {
        const cos = cosine.get(h.id);
        out.near_duplicate = cos >= o.dupThreshold;
        const veto = out.near_duplicate && o.query !== null ? dupVeto(o.query, r.text) : null;
        if (veto) { out.near_duplicate = false; out.near_duplicate_veto = veto; }
        if (sem && kw) out.cosine = cos;
      }
    }
    results.push(out);
  }

  // Absence needs every in-scope row covered by BOTH modes. The keyword index sees every row; the semantic scan
  // sees only rows with a vector in a namespace bound to a model, so the rows it did not scan are named, and a
  // search that left any of them out establishes nothing (same ttl, superseded and filter predicates as `considered`).
  const unembedded = sem ? Math.max(0, considered - sem.scanned) : 0;
  const absence = ran.includes('semantic') && ran.includes('keyword') && unembedded === 0 && !results.length && !pool.length && o.offset === 0 && o.minScore <= -1;
  const searched = { namespaces: o.namespaces, filter: o.filter, rows_considered: considered, fts: ftsReady(db) };
  if (unembedded) searched.rows_without_vector = unembedded;
  if (kw && kw.dropped.length) searched.keyword_terms_dropped = kw.dropped;
  const out = {
    warning: warningFor(o, ran, failed, results, absence, unembedded),
    results,
    scanned: sem ? sem.scanned : 0, model: sem ? sem.model : null, dim: sem ? sem.dim : null,
  };
  if (sem && sem.note) out.note = sem.note;
  out.modes_run = ran; out.modes_failed = failed; out.absence_established = absence;
  out.searched = searched; out.fusion = fusion;
  return out;
}

// ---- timeline, get_many, get, list -------------------------------------------------------------------------

const SCOPE_COLUMN = { task: 'task_id', worker: 'worker_id', run: 'run_id', namespace: 'namespace' };

async function timeline(E, caller, args) {
  if (typeof args.anchor_id !== 'string' || !args.anchor_id) throw bad('memory.timeline needs an anchor_id', 'anchor_id');
  const before = intArg('before', args.before, 5, 0, SPAN_MAX), after = intArg('after', args.after, 5, 0, SPAN_MAX);
  const view = enumArg('view', args.view, VIEWS, 'index');
  const scope = enumArg('scope', args.scope, SCOPES, undefined);
  const reach = reachOf(E, caller);
  const anchor = E.store.db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(args.anchor_id);
  const a = anchor && visible(reach, anchor) && gate.visible(E, caller, anchor.id) ? anchor : null;
  if (!a) throw err('E_NOT_FOUND', `memory.timeline: there is no row ${args.anchor_id}`, { anchor_id: args.anchor_id });
  checkReach(E, caller, [a.namespace], 'read'); // a lifecycle namespace is not for a tool-channel caller
  const use = scope || (a.task_id ? 'task' : 'namespace');
  const col = SCOPE_COLUMN[use];
  if (a[col] == null || a[col] === '') {
    throw bad(`the anchor has no ${col}, so scope ${use} names no rows; use scope namespace or another scope`, 'scope');
  }
  const key = a[col];
  const within = reach ? ` AND namespace IN (${marks([...reach])})` : '';
  // The notes gate, for the rows of this scope; and no lifecycle namespace for a tool-channel caller.
  const g = gate.and({ where: '', params: [] }, E, caller, { scope: { col, val: key } });
  const lc = gate.lifecycleSql(caller, 'e');
  const extra = [g.where, lc].filter(Boolean).map(x => ` AND ${x}`).join('');
  const side = (cmp, dir, n) => (n === 0 ? [] : E.store.db.prepare(
    `SELECT e.* FROM memory_entries e WHERE e.${col} = ? AND (e.ttl_at IS NULL OR e.ttl_at >= ?)${within.replace('namespace', 'e.namespace')} AND (e.created_at ${cmp} ? OR (e.created_at = ? AND e.id ${cmp} ?))${extra} ORDER BY e.created_at ${dir}, e.id ${dir} LIMIT ?`,
  ).all(key, Date.now(), ...(reach ? [...reach] : []), a.created_at, a.created_at, a.id, ...g.params, n));
  return {
    anchor: viewRow(a, view),
    before: side('<', 'DESC', before).reverse().map(r => viewRow(r, view)),
    after: side('>', 'ASC', after).map(r => viewRow(r, view)),
    scope: use, scope_key: key,
  };
}

// The honest answer for a note that exists but is held on a report and withheld from this reader (ADR 0047 amendment, 2026-10-22).
const withheldAnswer = (id) => ({ id, found: false, withheld: true, note: 'this note exists but is held for review after a report that it is wrong, and is withheld from workers until the review settles it' });

async function getMany(E, caller, args) {
  const ids = args.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > ID_MAX || ids.some(x => typeof x !== 'string' || !x)) {
    throw bad(`ids must be an array of 1 to ${ID_MAX} non-empty strings`, 'ids');
  }
  const view = enumArg('view', args.view, VIEWS, 'full');
  const reach = reachOf(E, caller);
  const rows = rowsByIds(E, [...new Set(ids)]);
  const legacy = gate.legacyHidden(E, caller);
  const out = [], missing = [];
  const held = W.withheldAmong(E, caller, [...rows.values()].filter(r => readable(caller, reach, r)));
  for (const id of ids) {
    const r = rows.has(id) && readable(caller, reach, rows.get(id), legacy) ? rows.get(id) : null;
    if (r && held.has(id)) { out.push(withheldAnswer(id)); if (!missing.includes(id)) missing.push(id); }
    else if (r) out.push({ ...viewRow(r, view), found: true });
    else { out.push({ id, found: false }); if (!missing.includes(id)) missing.push(id); }
  }
  return { rows: out, found: out.filter(r => r.found).length, missing, ...(held.size ? { withheld: [...held] } : {}) };
}

async function get(E, caller, args) {
  if (args.ids !== undefined && args.ids !== null) return getMany(E, caller, args);
  if (!args.id) throw bad('memory.get needs an id', 'id');
  const view = enumArg('view', args.view, VIEWS, 'full');
  // A read: a plain SELECT, so invariant 6 holds (retrieve() would stamp accessed_at).
  const got = E.store.db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(args.id);
  const r = got && readable(caller, reachOf(E, caller), got, gate.legacyHidden(E, caller)) ? got : null;
  if (r && W.withheldAmong(E, caller, [r]).size) return withheldAnswer(args.id);
  return r ? { ...viewRow(r, view), found: true } : { id: args.id, found: false };
}

async function list(E, caller, args) {
  const namespaces = namespacesOf(E, caller, args);
  const view = enumArg('view', args.view, VIEWS, 'full');
  const order = enumArg('order', args.order, ['newest', 'oldest'], 'newest');
  const limit = Math.min(intArg('limit', args.limit, 50, 1, Number.MAX_SAFE_INTEGER), LIST_MAX);
  const offset = intArg('offset', args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const f = args.filter == null ? {} : args.filter;
  const fsql = gate.and(filterSql(f, 'e'), E, caller, { namespaces });
  const where = [`e.namespace IN (${marks(namespaces)})`, ...(fsql.where ? [fsql.where] : [])].join(' AND ');
  const params = [...namespaces, ...fsql.params];
  const dir = order === 'newest' ? 'DESC' : 'ASC';
  const db = E.store.db;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM memory_entries e WHERE ${where}`).get(...params).n;
  const found = db.prepare(`SELECT e.id, e.namespace, e.worker_id, e.last_writer_id, e.written_by, e.type, substr(e.text, 1, 200) AS text,
    substr(e.text, 1, 2000) AS title_src, e.tags, e.provenance, e.supersedes, e.created_at, e.updated_at, e.ttl_at, e.title, e.status,
    e.status_receipt, e.status_by, e.status_at, e.run_id, e.task_id, e.turn, e.source, e.redactions
    FROM memory_entries e WHERE ${where} ORDER BY e.created_at ${dir}, e.id ${dir} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const rows = found.map(r => {
    const { title_src: src, ...rest } = r;
    const title = r.title || deriveTitle(src);
    if (view === 'index') return indexRowOf({ ...rest, title });
    return { ...rest, tags: parseJson(r.tags), redactions: parseJson(r.redactions), status: r.status || 'unverified', title };
  });
  return { rows, total, searched: { namespaces, filter: f, rows_considered: total } };
}

// A hybrid search whose semantic half timed out in the owner's own process answers from its keyword half: this
// puts the named failure on a keyword-mode result (warning first, as a search result carries it).
function withSemanticFailure(result, failure) {
  const { warning, ...rest } = result;
  const failed = { mode: 'semantic', code: failure.code, message: failure.message };
  return {
    warning: `semantic search did not run (${failure.code}); these are keyword matches only; no match here does not mean no such memory`,
    ...rest, modes_failed: [failed, ...(rest.modes_failed || [])], absence_established: false,
  };
}

module.exports = { onSemanticFailure, search, timeline, getMany, get, list, withSemanticFailure };
