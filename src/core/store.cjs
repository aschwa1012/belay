'use strict';
// store.cjs — the single connection to one database file (ADR 0002 §1). Lifted from
// prototypes/memstore/store-core.cjs with its measured behaviour intact: dedup by (namespace,
// text_hash) inside BEGIN IMMEDIATE, namespace bound to its first (embedding_model, dim), TTL sweep,
// heartbeat row, wal_checkpoint, VACUUM INTO backup, brute-force cosine over cached unit float32
// vectors. Changed on lift: StoreError became CoreError, prepared statements are memoised lazily so a
// copy of an older database still opens, and search enforces the ADR 0003 §2 scan ceiling.

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { err } = require('./errors.cjs');
const { ensureSchema, scanCeiling } = require('./schema.cjs');
const { checkSchema, putStamp } = require('./schema-stamp.cjs');
const { migrateOwner, ftsReady } = require('./memory-schema.cjs');
const { deriveTitle, validId } = require('./memory-rows.cjs');

const now = () => Date.now();
const hashText = t => crypto.createHash('sha256').update(String(t).trim()).digest('hex');

function toUnitF32(arr, dim) {
  if (!arr || arr.length !== dim) throw err('E_DIM', `embedding length ${arr && arr.length} does not match dim ${dim}`);
  const v = new Float32Array(dim); let s = 0;
  for (let i = 0; i < dim; i++) {
    const x = +arr[i];
    if (!Number.isFinite(x)) throw err('E_VEC', 'embedding has a non-finite component');
    v[i] = x; s += x * x;
  }
  if (s === 0) throw err('E_VEC', 'embedding is the zero vector, which has no direction');
  s = 1 / Math.sqrt(s);
  for (let i = 0; i < dim; i++) v[i] *= s;
  return v;
}

class Store {
  constructor(dbPath, opts = {}) {
    this.dbPath = dbPath;
    this.opts = { synchronous: 'NORMAL', busyTimeoutMs: 5000, ...opts };
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=${this.opts.synchronous}; PRAGMA busy_timeout=${this.opts.busyTimeoutMs}; PRAGMA temp_store=MEMORY;`);
    // G3: refuse a newer schema before ensureSchema can write anything to it. Only the owner passes
    // `stamp: true`; a read opens a throwaway copy and never stamps. The owner checks, migrates and stamps
    // in one transaction, so no crash can leave a migrated store still carrying the old version, which an
    // older core would then open and write into as if the layout were its own.
    try {
      if (this.opts.stamp) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          checkSchema(this.db, dbPath);
          ensureSchema(this.db);
          putStamp(this.db);
          this.db.exec('COMMIT');
        } catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* already out */ } throw e; }
        migrateOwner(this.db);
      } else {
        checkSchema(this.db, dbPath);
        ensureSchema(this.db);
      }
    } catch (e) { try { this.db.close(); } catch { /* already closed */ } throw e; }
    this._stmts = new Map();
    this.cache = new Map(); // namespace -> { rows: [{id, vec, ttl_at}], superseded: Set<id> }
  }

  p(sql) {
    let s = this._stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this._stmts.set(sql, s); }
    return s;
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
  }

  // ---- memory write path -------------------------------------------------
  // ADR 0040 §1-3. `title`, `body`, `redactions` (objects or text), and the harness provenance `run_id`,
  // `task_id`, `turn` and `source` are written as given: deriving them is the method's work (methods-memory.cjs),
  // and this layer trusts none of them to come from a caller. A dedup update (same namespace, same hash) refreshes
  // title, body and redactions only where the new write has them, and never touches status or provenance:
  // the row stays what it was first written as, verified or refuted included. Only the row's own writer, with the
  // same source, updates an unverified row this way; every other hit returns the row unchanged (action 'unchanged').
  store(a) {
    const ns = a.namespace, wid = a.worker_id;
    if (!ns || !wid || typeof a.text !== 'string' || !a.text.trim()) throw err('E_ARGS', 'memory.store needs a namespace, a worker id and non-empty text');
    if (a.embedding && !(a.embedding_model && a.dim)) throw err('E_ARGS', 'an embedding must arrive with its embedding_model and dim');
    const t = now(), th = hashText(a.text), ttl = a.ttl_seconds ? t + Math.round(a.ttl_seconds * 1000) : null;
    const createdAt = a.created_at != null ? Math.floor(a.created_at) : t;
    const asText = v => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));
    const title = a.title == null ? null : String(a.title);
    const body = asText(a.body);
    const redactions = a.redactions && typeof a.redactions === 'object' && !Object.keys(a.redactions).length ? null : asText(a.redactions);
    if (a.id != null && !validId(a.id)) throw err('E_ARGS', 'a row id must be 1 to 128 letters, digits, dot, colon, dash or underscore', { field: 'id' });
    return this.tx(() => {
      const dup = this.p('SELECT id, worker_id, source, text, status, title, run_id, task_id, redactions, embedding IS NOT NULL AS has_vec FROM memory_entries WHERE namespace = ? AND text_hash = ?').get(ns, th);
      // A dedup hit updates the row only for the writer that wrote it, with the same source, while it is still
      // unverified. Anyone else's row, and any verified or refuted row, is left exactly as it was and returned as
      // it stands: otherwise a writer that read a verified row could resend its text under a new title and type and
      // keep the verified status (ADR 0040 §1, dedup).
      if (dup && !(dup.worker_id === wid && (dup.source || 'model') === (a.source || 'model') && (dup.status || 'unverified') === 'unverified')) {
        return this._unchanged(dup, ns, th);
      }
      let vec = null;
      if (a.embedding) {
        const m = this.p('SELECT embedding_model, dim FROM namespace_models WHERE namespace = ?').get(ns);
        if (!m) this.p('INSERT INTO namespace_models(namespace, embedding_model, dim) VALUES (?, ?, ?)').run(ns, a.embedding_model, a.dim);
        else if (m.embedding_model !== a.embedding_model || m.dim !== a.dim) {
          throw err('E_MODEL', `namespace ${ns} is bound to ${m.embedding_model}/${m.dim} and this write carries ${a.embedding_model}/${a.dim}`, { namespace: ns, bound: m });
        }
        vec = toUnitF32(a.embedding, a.dim);
      }
      if (a.supersedes && !this.p('SELECT 1 FROM memory_entries WHERE id = ?').get(a.supersedes)) {
        throw err('E_SUPERSEDES', `the row this write supersedes (${a.supersedes}) is not in the store`, { supersedes: a.supersedes });
      }
      const tags = a.tags ? JSON.stringify(a.tags) : null;
      const prov = a.provenance || null;
      const blob = vec ? Buffer.from(vec.buffer) : null;
      let id, action;
      if (dup) {
        id = dup.id; action = 'updated';
        this.p(`UPDATE memory_entries SET last_writer_id = ?, embedding = COALESCE(?, embedding),
                tags = COALESCE(?, tags), provenance = COALESCE(?, provenance), supersedes = COALESCE(?, supersedes),
                title = COALESCE(title, ?), body = COALESCE(?, body), redactions = COALESCE(?, redactions),
                updated_at = ?, ttl_at = ? WHERE id = ?`)
          .run(wid, blob, tags, prov, a.supersedes || null, title, body, redactions, t, ttl, id);
      } else {
        id = a.id || crypto.randomUUID(); action = 'inserted';
        this.p(`INSERT INTO memory_entries(id, namespace, worker_id, last_writer_id, type, text, text_hash, embedding,
                embedding_model, embedding_revision, dim, tags, provenance, supersedes, created_at, updated_at, ttl_at,
                title, body, redactions, run_id, task_id, turn, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, ns, wid, wid, a.type || 'fact', a.text, th, blob, a.embedding_model || null,
            a.embedding_revision || null, a.dim || null, tags, prov, a.supersedes || null, createdAt, createdAt, ttl,
            title, body, redactions, a.run_id ?? null, a.task_id ?? null, a.turn ?? null, a.source ?? null);
      }
      const c = this.cache.get(ns);
      if (c) {
        const i = c.rows.findIndex(r => r.id === id);
        const row = { id, vec, ttl_at: ttl };
        if (i >= 0) c.rows[i] = row; else c.rows.push(row);
        if (a.supersedes) c.superseded.add(a.supersedes);
      }
      const stored = this.p('SELECT status, title, run_id, task_id, turn, source, redactions, embedding IS NOT NULL AS has_vec FROM memory_entries WHERE id = ?').get(id);
      return {
        id, action, namespace: ns, text_hash: th, worker_id: dup ? dup.worker_id : wid,
        last_writer_id: wid, created_at: dup ? undefined : createdAt, updated_at: t, ttl_at: ttl,
        status: stored.status || 'unverified', title: stored.title || deriveTitle(dup ? dup.text : a.text),
        run_id: stored.run_id, task_id: stored.task_id, turn: stored.turn, source: stored.source,
        redactions: stored.redactions ? JSON.parse(stored.redactions) : null, has_embedding: !!stored.has_vec,
      };
    });
  }

  // The answer to a dedup hit that changed nothing: the row as it stands, named, so the caller has its id as proof.
  _unchanged(dup, ns, th) {
    const cur = this.p('SELECT * FROM memory_entries WHERE id = ?').get(dup.id);
    const status = cur.status || 'unverified';
    return {
      id: cur.id, action: 'unchanged', unchanged_reason: status !== 'unverified' ? `the row is ${status}` : 'the row has another writer or source',
      namespace: ns, text_hash: th, worker_id: cur.worker_id, last_writer_id: cur.last_writer_id, updated_at: cur.updated_at, ttl_at: cur.ttl_at,
      status, title: cur.title || deriveTitle(cur.text), run_id: cur.run_id, task_id: cur.task_id, turn: cur.turn, source: cur.source,
      redactions: cur.redactions ? JSON.parse(cur.redactions) : null, has_embedding: !!cur.embedding,
    };
  }

  // ADR 0040 §2 memory.setStatus. One row, one transaction; the FTS trigger fires on title and text only,
  // so a status change leaves the keyword index alone.
  setStatus(id, f) {
    return this.tx(() => {
      const row = this.p('SELECT status FROM memory_entries WHERE id = ?').get(id);
      if (!row) throw err('E_NOT_FOUND', `no memory row ${id}`, { id });
      this.p('UPDATE memory_entries SET status = ?, status_receipt = ?, status_by = ?, status_at = ? WHERE id = ?')
        .run(f.status, f.receipt, f.by, f.at, id);
      return { id, status: f.status, previous_status: row.status || 'unverified', status_receipt: f.receipt, status_by: f.by, status_at: f.at };
    });
  }

  delete(id) {
    return this.tx(() => {
      const row = this.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
      if (!row) return { id, deleted: false };
      this.p('DELETE FROM memory_entries WHERE id = ?').run(id);
      const c = this.cache.get(row.namespace);
      if (c) c.rows = c.rows.filter(r => r.id !== id);
      return { id, deleted: true, namespace: row.namespace };
    });
  }

  sweep() {
    const t = now();
    return this.tx(() => {
      const nss = this.p('SELECT DISTINCT namespace FROM memory_entries WHERE ttl_at IS NOT NULL AND ttl_at < ?').all(t).map(r => r.namespace);
      const r = this.p('DELETE FROM memory_entries WHERE ttl_at IS NOT NULL AND ttl_at < ?').run(t);
      for (const n of nss) this.cache.delete(n);
      return { expired_deleted: Number(r.changes), namespaces: nss };
    });
  }

  // ---- memory read path --------------------------------------------------
  retrieve(id, touch = true) {
    const r = this.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
    if (!r) return null;
    if (touch) { try { this.p('UPDATE memory_entries SET accessed_at = ? WHERE id = ?').run(now(), id); } catch { /* read-only copy */ } }
    return this._rowOut(r);
  }

  list(a) {
    return this.p(`SELECT id, namespace, worker_id, last_writer_id, type, substr(text, 1, 200) AS text, tags,
                   provenance, supersedes, created_at, updated_at, ttl_at FROM memory_entries
                   WHERE namespace = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(a.namespace, Math.min(a.limit || 50, 500), a.offset || 0)
      .map(r => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : null }));
  }

  // Rows whose tags array contains this exact string. LIKE narrows the scan; the JSON parse decides.
  taggedWith(namespace, tag, limit = 10) {
    const rows = this.p(`SELECT id, namespace, worker_id, type, substr(text, 1, 400) AS text, tags, provenance,
                         created_at, updated_at FROM memory_entries WHERE namespace = ? AND tags LIKE ?
                         ORDER BY created_at DESC LIMIT ?`).all(namespace, `%${tag}%`, Math.max(limit * 4, limit));
    const out = [];
    for (const r of rows) {
      let tags = null;
      try { tags = r.tags ? JSON.parse(r.tags) : null; } catch { tags = null; }
      if (Array.isArray(tags) && tags.includes(tag)) out.push({ ...r, tags });
      if (out.length >= limit) break;
    }
    return out;
  }

  _loadNs(ns) {
    let c = this.cache.get(ns);
    if (c) return c;
    c = { rows: [], superseded: new Set() };
    for (const r of this.p('SELECT id, embedding, ttl_at, supersedes FROM memory_entries WHERE namespace = ?').all(ns)) {
      const vec = r.embedding ? new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4) : null;
      c.rows.push({ id: r.id, vec, ttl_at: r.ttl_at });
      if (r.supersedes) c.superseded.add(r.supersedes);
    }
    this.cache.set(ns, c);
    return c;
  }

  search(a) {
    const ns = a.namespace, k = Math.min(a.k || 10, 100);
    if (!ns || !a.query_embedding) throw err('E_ARGS', 'memory.search needs a namespace and a query embedding');
    const m = this.p('SELECT embedding_model, dim FROM namespace_models WHERE namespace = ?').get(ns);
    if (!m) return { results: [], scanned: 0, model: null, dim: null, note: 'namespace has no embedded rows' };
    if (a.embedding_model && a.embedding_model !== m.embedding_model) {
      throw err('E_MODEL', `the query was embedded with ${a.embedding_model} but namespace ${ns} is bound to ${m.embedding_model}`, { namespace: ns, bound: m.embedding_model });
    }
    const q = toUnitF32(a.query_embedding, m.dim), c = this._loadNs(ns), t = now(), D = m.dim;
    const ceiling = scanCeiling(D);
    if (c.rows.length > ceiling && !a.allow_slow) {
      throw err('E_NAMESPACE_TOO_LARGE', `namespace ${ns} holds ${c.rows.length} rows, above the ${ceiling}-row exact-scan ceiling; pass allow_slow to scan it anyway`, { namespace: ns, rows: c.rows.length, ceiling });
    }
    const top = []; let scanned = 0;
    for (const r of c.rows) {
      if (!r.vec || (r.ttl_at && r.ttl_at < t) || (!a.include_superseded && c.superseded.has(r.id))) continue;
      scanned++;
      let s = 0; const v = r.vec;
      for (let d = 0; d < D; d++) s += v[d] * q[d];
      if (top.length < k) { top.push({ id: r.id, score: s }); if (top.length === k) top.sort((x, y) => y.score - x.score); }
      else if (s > top[k - 1].score) {
        let j = k - 1;
        while (j > 0 && top[j - 1].score < s) { top[j] = top[j - 1]; j--; }
        top[j] = { id: r.id, score: s };
      }
    }
    if (top.length < k) top.sort((x, y) => y.score - x.score);
    const results = top.filter(r => r.score >= (a.min_score ?? -1)).map(r => {
      const row = this.p('SELECT * FROM memory_entries WHERE id = ?').get(r.id);
      return { ...this._rowOut(row), score: r.score, near_duplicate: r.score >= (a.dup_threshold ?? 0.95) };
    });
    return { results, scanned, model: m.embedding_model, dim: m.dim };
  }

  _rowOut(r) {
    if (!r) return null;
    const { embedding, ...rest } = r;
    return { ...rest, tags: rest.tags ? JSON.parse(rest.tags) : null, has_embedding: !!embedding };
  }

  // ---- maintenance --------------------------------------------------------
  stats() {
    const t = now();
    const tot = this.p(`SELECT COUNT(*) AS n, COUNT(DISTINCT namespace) AS namespaces, COUNT(DISTINCT worker_id) AS workers,
                        SUM(CASE WHEN ttl_at IS NOT NULL AND ttl_at < ? THEN 1 ELSE 0 END) AS expired,
                        MIN(created_at) AS oldest, MAX(created_at) AS newest FROM memory_entries`).get(t);
    const sz = f => { try { return fs.statSync(f).size; } catch { return 0; } };
    const ready = ftsReady(this.db);
    const marker = this.db.prepare("SELECT value FROM meta WHERE key = 'memory_fts_version'").get();
    return {
      ...tot,
      by_type: this._countBy("COALESCE(type, 'fact')"),
      by_status: this._countBy("COALESCE(status, 'unverified')"),
      unembedded: Number(this.p('SELECT COUNT(*) AS n FROM memory_entries WHERE embedding IS NULL').get().n),
      // ADR 0040 §5: the keyword index as a fact. `version` is the marker as stored ('0' = this SQLite has no
      // FTS5, null = no owner has migrated this store); rows is read only when the marker says the index exists.
      fts: { present: ready, version: marker ? marker.value : null, rows: ready ? Number(this.db.prepare('SELECT COUNT(*) AS n FROM memory_fts').get().n) : null },
      by_namespace: this.p('SELECT namespace, COUNT(*) AS n FROM memory_entries GROUP BY namespace ORDER BY n DESC LIMIT 50').all(),
      heartbeat: this.p('SELECT * FROM owner_heartbeat WHERE id = 1').get() || null,
      db_bytes: sz(this.dbPath), wal_bytes: sz(this.dbPath + '-wal'),
      sqlite_version: this.p('SELECT sqlite_version() AS v').get().v,
      cached_namespaces: this.cache.size,
    };
  }

  _countBy(expr) {
    const out = {};
    for (const r of this.db.prepare(`SELECT ${expr} AS k, COUNT(*) AS n FROM memory_entries GROUP BY k`).all()) out[r.k] = Number(r.n);
    return out;
  }

  heartbeat(pid, pipe, startedAt) {
    this.p(`INSERT INTO owner_heartbeat(id, pid, pipe, started_at, beat_at) VALUES (1, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, pipe = excluded.pipe,
            started_at = excluded.started_at, beat_at = excluded.beat_at`).run(pid, pipe, startedAt, now());
  }

  checkpointWal(mode = 'PASSIVE') { return this.db.prepare(`PRAGMA wal_checkpoint(${mode})`).get(); }
  backup(dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    this.p('VACUUM INTO ?').run(dest);
    return { dest, bytes: fs.statSync(dest).size };
  }
  integrity() { return this.p('PRAGMA integrity_check').all().map(r => r.integrity_check); }
  count() { return Number(this.p('SELECT COUNT(*) AS n FROM memory_entries').get().n); }
  close() {
    try { this.checkpointWal('TRUNCATE'); } catch { /* nothing to reclaim */ }
    this._stmts.clear();
    this.db.close();
  }
}

module.exports = { Store, hashText, toUnitF32 };
