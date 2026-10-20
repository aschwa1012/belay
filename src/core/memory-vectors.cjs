'use strict';
// memory-vectors.cjs — the vector cache (ADR 0050 decisions 1 and 2). `memory_vectors` holds embeddings keyed by
// content, never by row: (model, model_revision, dims, template, embed_hash), where embed_hash is the sha256 of the exact
// text the row's template rendered for embedding. A vector carries no state; several rows may share one (the same text in
// two namespaces, a copy into the project), and a row's state lives only on memory_entries.
//
// This release the inline `memory_entries.embedding` stays the source the current search reads, and every write of it is
// mirrored here (Store calls putRowVector). Search is not wired to this module yet.
//
// The table is made by the owner only (Store with `stamp: true`, via migrateVectors), like the keyword index: a read copy
// never gets it (invariant 6). A writer that opened the store without it (a test, a copy) skips the mirror, and a read of
// the cache without the table is refused E_NO_INDEX, as a keyword search without its index is.
//
// The tier key is { model, revision, dims }. A row has up to two templates: the one its inline vector was made under
// (`text_template`, null reads as v1) and the one it renders for embedding now (renderTemplateOf: a `when` means v2, as
// methods-memory-embed.cjs embedSource decides). A heavy embedder embeds under the render template; the inline vector keeps
// its own. A cached vector is referenced by a row when it matches either.

const crypto = require('node:crypto');
const NT = require('./memory-notes.cjs');
const gate = require('./memory-note-gate.cjs');
const { err } = require('./errors.cjs');

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS memory_vectors (
  model TEXT NOT NULL, model_revision TEXT NOT NULL, dims INTEGER NOT NULL, template TEXT NOT NULL, embed_hash TEXT NOT NULL,
  vector BLOB NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (model, model_revision, dims, template, embed_hash))`;
// Everything hashing and visibility need from a row; never the vector blob.
const COLS = 'id, namespace, type, text, title, body, text_template, embedding_model, embedding_revision, dim, ttl_at, created_at, status';
const VEC_BY_KEY = 'SELECT vector FROM memory_vectors WHERE model = ? AND model_revision = ? AND dims = ? AND template = ? AND embed_hash = ?';
const INSERT_IGNORE = `INSERT OR IGNORE INTO memory_vectors(model, model_revision, dims, template, embed_hash, vector, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

const sha256 = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const inlineTemplateOf = r => r.text_template || 'v1';
const revisionOf = r => r.embedding_revision || '';
const hasInline = r => r.embedding_model != null && r.dim != null;

function bodyOf(row) {
  if (row.body && typeof row.body === 'object') return row.body;
  try { return row.body ? JSON.parse(row.body) : {}; } catch { return {}; }
}

// The template a row renders for embedding: v2 when it has a `when`, else v1 (the rule of embedSource in
// methods-memory-embed.cjs, which embeds a note with a when as v2 and an older one from its stored text).
function renderTemplateOf(row) {
  const when = bodyOf(row).when;
  return typeof when === 'string' && when ? 'v2' : 'v1';
}

// Every template a row's vectors may sit under, the render template first.
function templatesOf(row) {
  const out = [renderTemplateOf(row)];
  if (hasInline(row) && !out.includes(inlineTemplateOf(row))) out.push(inlineTemplateOf(row));
  return out;
}

// The text a row is embedded from under `template` (default its inline template): v1 is the text as stored, v2 the title and
// the When: line, rendered by memory-notes.embedText. Null where it cannot be rendered (v2 without a when, no text).
function embedTextOf(row, template) {
  const t = template || inlineTemplateOf(row);
  if (typeof row.text !== 'string') return null;
  if (t !== 'v2') return row.text;
  const when = bodyOf(row).when;
  if (typeof when !== 'string' || !when) return null;
  return NT.embedText({ title: row.title, when }, 'v2');
}
function embedHashOf(row, template) {
  const text = embedTextOf(row, template);
  return text === null ? null : sha256(text);
}

const hasTable = db => !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'memory_vectors'").get();
function needTable(db) {
  if (!hasTable(db)) throw err('E_NO_INDEX', 'this store has no vector cache (memory_vectors); it was never opened by a current owner');
}

const keyOf = (tier) => ({ model: tier.model, revision: tier.revision || '', dims: tier.dims });
const f32 = blob => new Float32Array(Uint8Array.from(blob).buffer);

// Upserts one vector under its key. `vector` is a Buffer/Uint8Array of the unit float32 components.
function putVector(db, key, embedHash, vector, at = Date.now()) {
  db.prepare(`INSERT OR REPLACE INTO memory_vectors(model, model_revision, dims, template, embed_hash, vector, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(key.model, key.revision || '', key.dims, key.template, embedHash, Buffer.from(vector), at);
}

// The key and hash a row's inline vector is cached under, or null when it has none or its template cannot be rendered.
function inlineKeyOf(row) {
  if (!hasInline(row)) return null;
  const template = inlineTemplateOf(row), hash = embedHashOf(row, template);
  return hash === null ? null : { key: { model: row.embedding_model, revision: revisionOf(row), dims: row.dim, template }, hash };
}

// Mirrors one stored row's inline vector (the full row, blob included) under the row's own model, revision, dim and template.
// Returns { embed_hash } or null when the row has no vector or its template cannot be rendered.
function putRowVector(db, row) {
  if (!row || row.embedding == null) return null;
  const k = inlineKeyOf(row);
  if (!k) return null;
  putVector(db, k.key, k.hash, row.embedding);
  return { embed_hash: k.hash };
}

// ---- the owner's start ---------------------------------------------------------------------------------------------

// Owner-only. Creates the table and backfills it from every inline vector only when the table is new; then, on every start,
// catches up without rewriting anything that is already there (catchUp).
function migrateVectors(db) {
  let backfilled = 0;
  if (!hasTable(db)) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(TABLE_SQL);
      const put = db.prepare(INSERT_IGNORE);
      for (const r of db.prepare(`SELECT ${COLS}, embedding FROM memory_entries WHERE embedding IS NOT NULL`).iterate()) {
        const k = inlineKeyOf(r);
        if (k) { put.run(k.key.model, k.key.revision, k.key.dims, k.key.template, k.hash, Buffer.from(r.embedding), Date.now()); backfilled++; }
      }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already out */ } throw e; }
  }
  return { table: 'ready', backfilled, ...catchUp(db) };
}

// One pass over the rows without their blobs: the cached vector of each inline vector is looked up by its primary key, and only a
// missing one has its blob fetched and inserted (INSERT OR IGNORE; nothing present is rewritten). The same pass builds the set of
// referenced (template, hash) pairs, and every cached vector outside it is deleted. A pass that finds nothing to do writes nothing.
function catchUp(db) {
  const exists = db.prepare(VEC_BY_KEY);
  const live = new Map(); // template -> Set(hash)
  const missing = [];
  for (const r of db.prepare(`SELECT ${COLS} FROM memory_entries`).iterate()) {
    for (const t of templatesOf(r)) {
      const h = embedHashOf(r, t);
      if (h === null) continue;
      if (!live.has(t)) live.set(t, new Set());
      live.get(t).add(h);
    }
    const k = inlineKeyOf(r);
    if (k && !exists.get(k.key.model, k.key.revision, k.key.dims, k.key.template, k.hash)) missing.push({ id: r.id, k });
  }
  const stale = [];
  for (const v of db.prepare('SELECT DISTINCT template, embed_hash FROM memory_vectors').iterate()) {
    if (!(live.has(v.template) && live.get(v.template).has(v.embed_hash))) stale.push([v.template, v.embed_hash]);
  }
  if (!missing.length && !stale.length) return { caught_up: 0, swept: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    const blob = db.prepare('SELECT embedding FROM memory_entries WHERE id = ?'), put = db.prepare(INSERT_IGNORE);
    for (const m of missing) {
      const b = blob.get(m.id);
      if (b && b.embedding) put.run(m.k.key.model, m.k.key.revision, m.k.key.dims, m.k.key.template, m.k.hash, Buffer.from(b.embedding), Date.now());
    }
    const del = db.prepare('DELETE FROM memory_vectors WHERE template = ? AND embed_hash = ?');
    let swept = 0;
    for (const [t, h] of stale) swept += Number(del.run(t, h).changes);
    db.exec('COMMIT');
    return { caught_up: missing.length, swept };
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already out */ } throw e; }
}

// ---- reads (these never write) ------------------------------------------------------------------------------------

// The cached vector of a row under the tier, trying each template the row may sit under, or null.
function lookup(get, k, row) {
  for (const template of templatesOf(row)) {
    const hash = embedHashOf(row, template);
    if (hash === null) continue;
    const v = get.get(k.model, k.revision, k.dims, template, hash);
    if (v) return { embed_hash: hash, template, vector: f32(v.vector) };
  }
  return null;
}

// { id -> { embed_hash, template, vector: Float32Array } } for the stated rows that have a vector under the tier.
function vectorsFor(db, tier, rowIds) {
  needTable(db);
  const k = keyOf(tier), out = new Map();
  if (!rowIds.length) return out;
  const get = db.prepare(VEC_BY_KEY);
  for (const r of db.prepare(`SELECT ${COLS} FROM memory_entries WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(rowIds))) {
    const found = lookup(get, k, r);
    if (found) out.set(r.id, found);
  }
  return out;
}

// The rows memory.search considers, as one predicate over alias e: the terms of baseWhere in memory-search.cjs and the semantic
// scan's own skips (_loadNs, semanticStage). memory-search should adopt this function when it is wired to this module, so the
// visibility rules cannot drift between tiers:
//   - the row is in one of the stated namespaces (the caller's choice; a held note stays in project/<p> and stays visible);
//   - it has not expired (ttl_at null or 0, which search reads as no expiry, or not before `at`);
//   - it is not superseded by a row of the same namespace, unless includeSuperseded.
// What a caller's gate hides (refuted, another open run's notes: memory-note-gate.cjs) depends on the caller, so it is passed to
// selectSearchable as `hidden` ids; the gate's body test (promoted or pending notes) is its `bodyLive` option.
function visibleRowFilter({ namespaces, includeSuperseded = false, at = Date.now() }) {
  const where = ['e.namespace IN (SELECT value FROM json_each(?))', '(e.ttl_at IS NULL OR e.ttl_at = 0 OR e.ttl_at >= ?)'];
  if (!includeSuperseded) where.push('NOT EXISTS (SELECT 1 FROM memory_entries s WHERE s.supersedes = e.id AND +s.namespace = e.namespace)');
  return { where: where.join(' AND '), params: [JSON.stringify(namespaces), at] };
}

function visibleRows(db, opts) {
  const v = visibleRowFilter(opts);
  const cols = COLS.split(', ').map(c => `e.${c}`).join(', ');
  return db.prepare(`SELECT ${cols} FROM memory_entries e WHERE ${v.where} ORDER BY e.created_at, e.id`).all(...v.params);
}

function scan(db, tier, { namespaces, includeSuperseded = false, at = Date.now(), hidden = null, bodyLive = false } = {}) {
  needTable(db);
  const out = { rows: [], missing: [] };
  if (!namespaces || !namespaces.length) return out;
  const skip = hidden ? new Set(hidden) : null;
  const k = keyOf(tier), get = db.prepare(VEC_BY_KEY);
  for (const r of visibleRows(db, { namespaces, includeSuperseded, at })) {
    if (skip && skip.has(r.id)) continue;
    if (bodyLive && !gate.bodyLive(r)) continue; // as search does after ranking, for a gated caller
    const found = lookup(get, k, r);
    if (found) out.rows.push({ id: r.id, namespace: r.namespace, ...found });
    else out.missing.push(r);
  }
  return out;
}

// The visible rows of the stated namespaces, chosen BEFORE any vector is looked up, then joined to the tier's vectors on
// (key, embed_hash). Returns { rows: [{ id, namespace, embed_hash, template, vector }], missing: [id] }, `missing` being the visible
// rows that have no vector under the tier. `hidden` is a caller's gate (ids to leave out); `bodyLive` applies the gate's body test.
function selectSearchable(db, tier, opts = {}) {
  const s = scan(db, tier, opts);
  return { rows: s.rows, missing: s.missing.map(r => r.id) };
}

// The visible rows (every type, superseded ones included unless includeSuperseded is false) of the stated namespaces with no
// vector under the tier: selectSearchable's `missing`, in detail. Derived by this query; nothing is stored. The namespaces are
// stated by the caller; an archived row is in the backlog only when its namespace is asked for.
function backlog(db, tier, { namespaces, includeSuperseded = true, ...rest } = {}) {
  if (!Array.isArray(namespaces) || !namespaces.length) throw err('E_ARGS', 'backlog needs the namespaces to look in', { field: 'namespaces' });
  return scan(db, tier, { namespaces, includeSuperseded, ...rest }).missing
    .map(r => ({ id: r.id, namespace: r.namespace, type: r.type, title: r.title, created_at: Number(r.created_at) }));
}

// ---- deletes (inside the caller's transaction) --------------------------------------------------------------------

// Deletes every vector that no row references, by (template, embed_hash) and whatever the model. A row references the vectors
// of both its templates. Returns the number removed. (The owner's start runs the same sweep inside catchUp.)
function sweep(db) {
  needTable(db);
  const live = new Map();
  for (const r of db.prepare(`SELECT ${COLS} FROM memory_entries`).iterate()) {
    for (const t of templatesOf(r)) {
      const h = embedHashOf(r, t);
      if (h === null) continue;
      if (!live.has(t)) live.set(t, new Set());
      live.get(t).add(h);
    }
  }
  const del = db.prepare('DELETE FROM memory_vectors WHERE template = ? AND embed_hash = ?');
  let n = 0;
  for (const v of db.prepare('SELECT DISTINCT template, embed_hash FROM memory_vectors').all()) {
    if (live.has(v.template) && live.get(v.template).has(v.embed_hash)) continue;
    n += Number(del.run(v.template, v.embed_hash).changes);
  }
  return n;
}

// The same, for the content of rows that have just been deleted or changed. `gone` are the row snapshots as they were before the
// change. The candidate (template, hash) pairs of all of them are gathered first; one query then finds the rows that still carry
// any of their texts or titles (a v1 hash needs the same text, a v2 hash the same title), and a pair no such row renders is deleted.
function sweepRows(db, gone) {
  if (!hasTable(db)) return 0;
  const cand = new Map(), texts = new Set(), titles = new Set();
  for (const r of gone) {
    if (!r || typeof r.text !== 'string') continue;
    for (const t of templatesOf(r)) {
      const h = embedHashOf(r, t);
      if (h !== null) cand.set(`${t}:${h}`, [t, h]);
    }
    texts.add(r.text);
    if (r.title != null) titles.add(r.title);
  }
  if (!cand.size) return 0;
  const near = db.prepare(`SELECT ${COLS} FROM memory_entries WHERE text IN (SELECT value FROM json_each(?)) OR title IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify([...texts]), JSON.stringify([...titles]));
  for (const o of near) {
    for (const t of templatesOf(o)) {
      const h = embedHashOf(o, t);
      if (h !== null) cand.delete(`${t}:${h}`);
    }
  }
  const del = db.prepare('DELETE FROM memory_vectors WHERE template = ? AND embed_hash = ?');
  let n = 0;
  for (const [t, h] of cand.values()) n += Number(del.run(t, h).changes);
  return n;
}

module.exports = {
  TABLE_SQL, embedTextOf, embedHashOf, renderTemplateOf, templatesOf, hasTable, migrateVectors, catchUp, putVector, putRowVector,
  vectorsFor, visibleRowFilter, selectSearchable, backlog, sweep, sweepRows,
};
