'use strict';
// memory-schema.cjs — the keyword index over memory rows (ADR 0040 decision 1). `memory_fts` is an
// external-content FTS5 table over memory_entries(title, text) with the trigram tokenizer, kept in step
// by three triggers that live in the database file, so even an older core's insert or delete updates it.
//
// This runs ONLY on the owner's open for write (Store with `stamp: true`). `ensureSchema`, which also runs
// on every throwaway read copy, never creates the index. A copy of a store with no marker therefore has no
// index, `ftsReady` is false there, and a keyword search must fail E_NO_INDEX rather than return an empty
// result that looks like "no match" (invariant 6: reading never writes).
//
// The marker `meta.memory_fts_version` is '1' once the index, its triggers and its backfill are committed,
// and '0' when this SQLite was built without FTS5 and no index was made. Absent means never migrated.

const FTS_VERSION = '1';
const META_KEY = 'memory_fts_version';

const TRIGGERS = {
  memory_fts_ai: `CREATE TRIGGER memory_fts_ai AFTER INSERT ON memory_entries BEGIN
    INSERT INTO memory_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
  END`,
  memory_fts_ad: `CREATE TRIGGER memory_fts_ad AFTER DELETE ON memory_entries BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
  END`,
  memory_fts_au: `CREATE TRIGGER memory_fts_au AFTER UPDATE OF title, text ON memory_entries BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
    INSERT INTO memory_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
  END`,
};

const FTS_TABLE = `CREATE VIRTUAL TABLE memory_fts USING fts5(title, text, content='memory_entries', content_rowid='rowid', tokenize='trigram')`;

function getMeta(db, key) {
  if (!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()) return null;
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? r.value : null;
}

// Reads only; creates nothing. True when the store carries a committed keyword index.
function ftsReady(db) {
  try { return getMeta(db, META_KEY) === FTS_VERSION; } catch { return false; }
}

// SELECT sqlite_compileoption_used creates nothing and is the documented probe for a compiled-in feature.
function fts5Compiled(db) {
  try { return db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS ok").get().ok === 1; } catch { return false; }
}

function intact(db) {
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_fts' OR type = 'trigger'").all().map(r => r.name));
  return names.has('memory_fts') && Object.keys(TRIGGERS).every(n => names.has(n));
}

// A store built before the wrap-up index counted only successes holds the old definition (every wrap-up row,
// failed ones included, which blocked every retry of a failed wrap-up). The owner drops and recreates it; the
// rows are untouched. A store whose failed rows already collide cannot hold the old index, so none exist.
const WRAPUP_INDEX = "CREATE UNIQUE INDEX ux_memory_event_wrapup ON memory_event(run_id, key) WHERE kind = 'wrapup' AND ok = 1";
function migrateWrapupIndex(db) {
  const hasTable = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'memory_event'").get();
  if (!hasTable) return false;
  const cur = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ux_memory_event_wrapup'").get();
  if (cur && /ok\s*=\s*1/.test(cur.sql)) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DROP INDEX IF EXISTS ux_memory_event_wrapup');
    db.exec(WRAPUP_INDEX);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already out */ } throw e; }
  return true;
}

// Owner-only. Idempotent: a second call on a built store changes nothing and answers 'present'.
// `opts.hasFts5` replaces the compile-option probe (tests stub a SQLite without FTS5).
function migrateOwner(db, opts = {}) {
  migrateWrapupIndex(db);
  const hasFts5 = opts.hasFts5 ? opts.hasFts5(db) : fts5Compiled(db);
  const marker = getMeta(db, META_KEY);
  if (!hasFts5) {
    if (marker !== '0') db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(META_KEY, '0');
    return { fts: 'unsupported', rows: 0 };
  }
  if (marker === FTS_VERSION && intact(db)) {
    return { fts: 'present', rows: db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get().n };
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // A half-built index (a marker that lost its triggers, or the reverse) is rebuilt whole.
    for (const n of Object.keys(TRIGGERS)) db.exec(`DROP TRIGGER IF EXISTS ${n}`);
    db.exec('DROP TABLE IF EXISTS memory_fts');
    db.exec(FTS_TABLE);
    for (const sql of Object.values(TRIGGERS)) db.exec(sql);
    db.exec("INSERT INTO memory_fts(memory_fts) VALUES ('rebuild')");
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(META_KEY, FTS_VERSION);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get().n;
    db.exec('COMMIT');
    return { fts: 'built', rows };
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already out */ } throw e; }
}

module.exports = { migrateOwner, ftsReady, FTS_VERSION };
