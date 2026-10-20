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
// never gets it (invariant 6). A writer that opened the store without it (a test, a copy) skips the mirror.
//
// The tier key is { model, revision, dims }; the template is each row's own (`text_template`, null reads as v1), because a
// row's vector is made from the template it was embedded under. `tier.template` forces one template for every row.

const crypto = require('node:crypto');
const NT = require('./memory-notes.cjs');

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS memory_vectors (
  model TEXT NOT NULL, model_revision TEXT NOT NULL, dims INTEGER NOT NULL, template TEXT NOT NULL, embed_hash TEXT NOT NULL,
  vector BLOB NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (model, model_revision, dims, template, embed_hash))`;
// Namespaces that hold no searchable note: a hold, an archived note, and the other lifecycle states.
const LIFECYCLE_NS = ['archive/', 'held/', 'pending/', 'proposal/', 'draft/', 'nomination/'];

const sha256 = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const templateOf = r => r.text_template || 'v1';
const revisionOf = r => r.embedding_revision || r.revision || '';

function bodyOf(row) {
  if (row.body && typeof row.body === 'object') return row.body;
  try { return row.body ? JSON.parse(row.body) : {}; } catch { return {}; }
}

// The text a row is embedded from under `template` (default the row's own): v1 is the text as stored, v2 the title and the
// When: line, rendered by memory-notes.embedText. Null where the template cannot be rendered (v2 without a when).
function embedTextOf(row, template) {
  const t = template || templateOf(row);
  if (t !== 'v2') return String(row.text);
  const when = bodyOf(row).when;
  if (typeof when !== 'string' || !when || !row.title) return null;
  return NT.embedText({ title: row.title, when }, 'v2');
}
function embedHashOf(row, template) {
  const text = embedTextOf(row, template);
  return text === null ? null : sha256(text);
}

const hasTable = db => !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'memory_vectors'").get();

const keyOf = (tier) => ({ model: tier.model, revision: tier.revision || '', dims: tier.dims, template: tier.template || null });
const f32 = blob => new Float32Array(Uint8Array.from(blob).buffer);

// Upserts one vector under its key. `vector` is a Buffer/Uint8Array of the unit float32 components.
function putVector(db, key, embedHash, vector, at = Date.now()) {
  db.prepare(`INSERT OR REPLACE INTO memory_vectors(model, model_revision, dims, template, embed_hash, vector, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(key.model, key.revision || '', key.dims, key.template, embedHash, Buffer.from(vector), at);
}

// Mirrors one stored row's inline vector into the table under the row's own model, revision, dim and template.
// Returns { embed_hash } or null when the row has no vector or its template cannot be rendered.
function putRowVector(db, row) {
  if (!row || row.embedding == null || !row.embedding_model || !row.dim) return null;
  const hash = embedHashOf(row);
  if (hash === null) return null;
  putVector(db, { model: row.embedding_model, revision: revisionOf(row), dims: row.dim, template: templateOf(row) }, hash, row.embedding);
  return { embed_hash: hash };
}

// Owner-only and idempotent: creates the table and backfills it from every row's inline vector.
function migrateVectors(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(TABLE_SQL);
    let n = 0;
    for (const r of db.prepare('SELECT * FROM memory_entries WHERE embedding IS NOT NULL').all()) if (putRowVector(db, r)) n++;
    db.exec('COMMIT');
    return { table: 'ready', backfilled: n };
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already out */ } throw e; }
}

// ---- reads (these never write) ------------------------------------------------------------------------------------

// { id -> { embed_hash, template, vector: Float32Array } } for the stated rows that have a vector under the tier.
function vectorsFor(db, tier, rowIds) {
  const k = keyOf(tier), out = new Map();
  if (!rowIds.length) return out;
  const get = db.prepare('SELECT vector FROM memory_vectors WHERE model = ? AND model_revision = ? AND dims = ? AND template = ? AND embed_hash = ?');
  const rows = db.prepare('SELECT * FROM memory_entries WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(rowIds));
  for (const r of rows) {
    const template = k.template || templateOf(r), hash = embedHashOf(r, template);
    if (hash === null) continue;
    const v = get.get(k.model, k.revision, k.dims, template, hash);
    if (v) out.set(r.id, { embed_hash: hash, template, vector: f32(v.vector) });
  }
  return out;
}

// The rows memory.search considers, as one predicate over alias e: the terms of baseWhere in memory-search.cjs and the semantic
// scan's own skips (_loadNs, semanticStage). memory-search should adopt this function when it is wired to this module, so the
// visibility rules cannot drift between tiers:
//   - the row is in one of the stated namespaces (the caller's choice; a held note stays in project/<p> and stays visible);
//   - it has not expired (ttl_at null or not before `at`);
//   - it is not superseded by a row of the same namespace, unless includeSuperseded.
// What a caller's gate hides (refuted, another open run's, promoted or pending notes: memory-note-gate.cjs) depends on the caller,
// so it is passed to selectSearchable as `hidden` ids. A refuted or held note is visible to an ungated caller.
function visibleRowFilter({ namespaces, includeSuperseded = false, at = Date.now() }) {
  const where = ['+e.namespace IN (SELECT value FROM json_each(?))', '(e.ttl_at IS NULL OR e.ttl_at >= ?)'];
  if (!includeSuperseded) where.push('NOT EXISTS (SELECT 1 FROM memory_entries s WHERE s.supersedes = e.id AND +s.namespace = e.namespace)');
  return { where: where.join(' AND '), params: [JSON.stringify(namespaces), at] };
}

function visibleRows(db, opts) {
  const v = visibleRowFilter(opts);
  return db.prepare(`SELECT e.* FROM memory_entries e WHERE ${v.where} ORDER BY e.created_at, e.id`).all(...v.params);
}

// The visible rows of the stated namespaces, chosen BEFORE any vector is looked up, then joined to the tier's vectors on
// (key, embed_hash). Returns { rows: [{ id, namespace, embed_hash, template, vector }], missing: [id] }, `missing` being the visible
// rows that have no vector under the tier. `hidden` is a caller's gate: ids to leave out.
function selectSearchable(db, tier, { namespaces, includeSuperseded = false, at = Date.now(), hidden = null } = {}) {
  const out = { rows: [], missing: [] };
  if (!namespaces || !namespaces.length) return out;
  const skip = hidden ? new Set(hidden) : null;
  const k = keyOf(tier);
  const get = db.prepare('SELECT vector FROM memory_vectors WHERE model = ? AND model_revision = ? AND dims = ? AND template = ? AND embed_hash = ?');
  for (const r of visibleRows(db, { namespaces, includeSuperseded, at })) {
    if (skip && skip.has(r.id)) continue;
    const template = k.template || templateOf(r), hash = embedHashOf(r, template);
    const v = hash === null ? null : get.get(k.model, k.revision, k.dims, template, hash);
    if (v) out.rows.push({ id: r.id, namespace: r.namespace, embed_hash: hash, template, vector: f32(v.vector) });
    else out.missing.push(r.id);
  }
  return out;
}

// The notes search shows (the visible set above, held notes included) with no vector under the tier. Derived by this query; nothing is stored. `namespaces` defaults to every
// project namespace; a lifecycle namespace is never a backlog.
function backlog(db, tier, { namespaces, at = Date.now() } = {}) {
  const ns = namespaces
    ? namespaces.filter(n => !LIFECYCLE_NS.some(p => String(n).startsWith(p)))
    : db.prepare("SELECT DISTINCT namespace FROM memory_entries WHERE type = 'note' AND namespace LIKE 'project/%'").all().map(r => r.namespace);
  if (!ns.length) return [];
  const k = keyOf(tier);
  const get = db.prepare('SELECT 1 AS x FROM memory_vectors WHERE model = ? AND model_revision = ? AND dims = ? AND template = ? AND embed_hash = ?');
  const out = [];
  for (const r of visibleRows(db, { namespaces: ns, at })) {
    if (r.type !== 'note') continue;
    const template = k.template || templateOf(r), hash = embedHashOf(r, template);
    if (hash !== null && get.get(k.model, k.revision, k.dims, template, hash)) continue;
    out.push({ id: r.id, namespace: r.namespace, title: r.title, created_at: Number(r.created_at) });
  }
  return out;
}

// ---- deletes (inside the caller's transaction) --------------------------------------------------------------------

// Deletes every vector that no row references, by (template, embed_hash) and whatever the model. A row references the
// vector its own template renders. Returns the number removed.
function sweep(db) {
  if (!hasTable(db)) return 0;
  const live = new Map(); // template -> Set(hash)
  for (const r of db.prepare('SELECT id, text, title, body, text_template FROM memory_entries').all()) {
    const t = templateOf(r), h = embedHashOf(r, t);
    if (h === null) continue;
    if (!live.has(t)) live.set(t, new Set());
    live.get(t).add(h);
  }
  const del = db.prepare('DELETE FROM memory_vectors WHERE template = ? AND embed_hash = ?');
  let n = 0;
  for (const v of db.prepare('SELECT DISTINCT template, embed_hash FROM memory_vectors').all()) {
    if (live.has(v.template) && live.get(v.template).has(v.embed_hash)) continue;
    n += Number(del.run(v.template, v.embed_hash).changes);
  }
  return n;
}

// The same, for the content of rows that have just been deleted or changed: only their keys are checked, against the rows
// that still carry the same text (v1) or title (v2), so a delete does not rehash the store. `gone` are the row snapshots
// as they were before the change (the full row). A vector another row still references stays.
function sweepRows(db, gone) {
  if (!gone.length || !hasTable(db)) return 0;
  const seen = new Set(), del = db.prepare('DELETE FROM memory_vectors WHERE template = ? AND embed_hash = ?');
  let n = 0;
  for (const r of gone) {
    const t = templateOf(r), h = embedHashOf(r, t);
    if (h === null || seen.has(`${t}:${h}`)) continue;
    seen.add(`${t}:${h}`);
    const near = t === 'v2'
      ? db.prepare("SELECT text, title, body, text_template FROM memory_entries WHERE title = ? AND text_template = 'v2'").all(r.title)
      : db.prepare("SELECT text, title, body, text_template FROM memory_entries WHERE text = ? AND COALESCE(text_template, 'v1') = ?").all(r.text, t);
    if (near.some(o => embedHashOf(o, t) === h)) continue;
    n += Number(del.run(t, h).changes);
  }
  return n;
}

module.exports = {
  TABLE_SQL, embedTextOf, embedHashOf, hasTable, migrateVectors, putVector, putRowVector, vectorsFor, visibleRowFilter, selectSearchable, backlog, sweep, sweepRows,
};
