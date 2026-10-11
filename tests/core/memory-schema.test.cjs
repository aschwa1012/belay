'use strict';
// memory-schema.test.cjs — ADR 0040 decision 1 and ADR 0041/0043's tables: the additive columns, the
// owner-only FTS5 trigram index with its triggers and backfill, the meta marker, and the proof that a
// read copy never gets the index (invariant 6).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { core, sandbox, cleanup } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { migrateOwner, ftsReady, FTS_VERSION } = core('memory-schema.cjs');
const { SCHEMA_VERSION } = core('schema-stamp.cjs');
const { ensureSchema } = core('schema.cjs');
const { CoreError, CODES } = core('errors.cjs');

// The 0.1.0 core's schema module, kept as a fixture so the test needs no git history.
const BASE_DIR = path.resolve(__dirname, '..', 'fixtures', 'v0.1.0');

const NEW_ENTRY_COLUMNS = ['title', 'status', 'status_receipt', 'status_by', 'status_at', 'run_id', 'task_id', 'turn', 'source', 'redactions', 'body'];
const TRIGGER_NAMES = ['memory_fts_ad', 'memory_fts_ai', 'memory_fts_au'];

const cols = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
const objects = (db, type) => db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all(type).map(r => r.name);
const metaOf = (db, key) => { const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key); return r ? r.value : null; };
const ftsCount = db => db.prepare('SELECT COUNT(*) AS n FROM memory_fts_docsize').get().n;
const hits = (db, term) => db.prepare('SELECT m.id FROM memory_fts f JOIN memory_entries m ON m.rowid = f.rowid WHERE memory_fts MATCH ? ORDER BY m.id')
  .all(`"${term}"`).map(r => r.id);

// A store as 0.1.0 made it: the 0.1.0 ensureSchema SQL, none of the new columns, with rows.
function baseStore(dir, rows) {
  const src = fs.readFileSync(path.join(BASE_DIR, 'src', 'core', 'schema.cjs'), 'utf8');
  const modPath = path.join(dir, 'base-schema.cjs');
  fs.writeFileSync(modPath, src);
  const f = path.join(dir, 'memory.db');
  const db = new DatabaseSync(f);
  require(modPath).ensureSchema(db);
  for (const [id, text] of rows) {
    db.prepare('INSERT INTO memory_entries(id, namespace, worker_id, text, text_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)')
      .run(id, 'n', 'w', text, `h-${id}`);
  }
  assert.ok(!cols(db, 'memory_entries').includes('title'), 'the fixture really is a base store');
  db.close();
  return f;
}

const ownerOpen = f => new Store(f, { stamp: true });

test('a fresh owner store has the columns, the FTS table, the triggers, the indexes and the marker', () => {
  const dir = sandbox();
  try {
    const s = ownerOpen(path.join(dir, 'memory.db'));
    try {
      for (const c of NEW_ENTRY_COLUMNS) assert.ok(cols(s.db, 'memory_entries').includes(c), `memory_entries.${c}`);
      assert.ok(objects(s.db, 'table').includes('memory_fts'));
      assert.deepStrictEqual(objects(s.db, 'trigger'), TRIGGER_NAMES);
      for (const ix of ['ix_entries_run', 'ix_entries_task', 'ix_entries_status', 'ix_entries_ns_created']) {
        assert.ok(objects(s.db, 'index').includes(ix), ix);
      }
      assert.strictEqual(metaOf(s.db, 'memory_fts_version'), '1');
      assert.strictEqual(FTS_VERSION, '1');
      assert.strictEqual(ftsReady(s.db), true);
      const sql = s.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_fts'").get().sql;
      assert.match(sql, /tokenize\s*=\s*'trigram'/);
      assert.match(sql, /content\s*=\s*'memory_entries'/);
    } finally { s.close(); }
  } finally { cleanup(dir); }
});

test('a store created at base is upgraded and backfilled; the FTS row count equals the entries count', () => {
  const dir = sandbox();
  try {
    const f = baseStore(dir, [['a', 'the quick brown fox'], ['b', 'jumps over the lazy dog'], ['c', 'error E_NO_OWNER raised']]);
    const s = ownerOpen(f);
    try {
      for (const c of NEW_ENTRY_COLUMNS) assert.ok(cols(s.db, 'memory_entries').includes(c), c);
      const n = s.db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get().n;
      assert.strictEqual(n, 3);
      assert.strictEqual(ftsCount(s.db), n);
      assert.deepStrictEqual(hits(s.db, 'brown fox'), ['a']);
      assert.deepStrictEqual(hits(s.db, 'E_NO_OWNER'), ['c']);
      // existing rows read back with the new columns null
      const row = s.db.prepare('SELECT title, status, run_id, body FROM memory_entries WHERE id = ?').get('a');
      assert.deepStrictEqual({ ...row }, { title: null, status: null, run_id: null, body: null });
    } finally { s.close(); }
  } finally { cleanup(dir); }
});

test('migrateOwner reports built, then present, and a second call changes nothing', () => {
  const dir = sandbox();
  try {
    const f = baseStore(dir, [['a', 'alpha beta gamma'], ['b', 'delta epsilon zeta']]);
    const db = new DatabaseSync(f);
    try {
      ensureSchema(db);
      assert.deepStrictEqual(migrateOwner(db), { fts: 'built', rows: 2 });
      const before = ftsCount(db);
      assert.deepStrictEqual(migrateOwner(db), { fts: 'present', rows: 2 });
      assert.strictEqual(ftsCount(db), before);
      // a marker that lost a trigger is rebuilt whole
      db.exec('DROP TRIGGER memory_fts_au');
      assert.deepStrictEqual(migrateOwner(db), { fts: 'built', rows: 2 });
      assert.deepStrictEqual(objects(db, 'trigger'), TRIGGER_NAMES);
    } finally { db.close(); }
  } finally { cleanup(dir); }
});

test('insert, delete and a dedup update through Store keep FTS in step', () => {
  const dir = sandbox();
  try {
    const s = ownerOpen(path.join(dir, 'memory.db'));
    try {
      const a = s.store({ namespace: 'n', worker_id: 'w1', text: 'persistent kiwi marker' });
      s.store({ namespace: 'n', worker_id: 'w1', text: 'unrelated banana row' });
      assert.strictEqual(a.action, 'inserted');
      assert.deepStrictEqual(hits(s.db, 'kiwi'), [a.id]);
      assert.strictEqual(ftsCount(s.db), 2);
      // the same text from another writer changes nothing; from its own writer it is a dedup update that changes no
      // indexed column and adds no FTS row
      assert.strictEqual(s.store({ namespace: 'n', worker_id: 'w2', text: 'persistent kiwi marker' }).action, 'unchanged');
      const again = s.store({ namespace: 'n', worker_id: 'w1', text: 'persistent kiwi marker' });
      assert.strictEqual(again.action, 'updated');
      assert.strictEqual(again.id, a.id);
      assert.strictEqual(ftsCount(s.db), 2);
      assert.deepStrictEqual(hits(s.db, 'kiwi'), [a.id]);
      // an update of title or text re-indexes the row: the old text stops matching, the new one matches
      s.db.prepare('UPDATE memory_entries SET text = ?, title = ? WHERE id = ?').run('replaced mango text', 'papaya title', a.id);
      assert.deepStrictEqual(hits(s.db, 'kiwi'), []);
      assert.deepStrictEqual(hits(s.db, 'mango'), [a.id]);
      assert.deepStrictEqual(hits(s.db, 'papaya'), [a.id]);
      // an update of an unindexed column leaves the index alone
      s.db.prepare('UPDATE memory_entries SET status = ? WHERE id = ?').run('verified', a.id);
      assert.deepStrictEqual(hits(s.db, 'mango'), [a.id]);
      // delete removes the row from the index
      s.db.prepare('DELETE FROM memory_entries WHERE id = ?').run(a.id);
      assert.deepStrictEqual(hits(s.db, 'mango'), []);
      assert.deepStrictEqual(hits(s.db, 'papaya'), []);
      assert.strictEqual(ftsCount(s.db), 1);
    } finally { s.close(); }
  } finally { cleanup(dir); }
});

test('a raw SQL insert, as an older core would make (no new columns named), keeps FTS in step', () => {
  const dir = sandbox();
  try {
    const f = path.join(dir, 'memory.db');
    ownerOpen(f).close();
    // The old core's insert statement, verbatim from base, on a connection that never ran this core's code.
    const raw = new DatabaseSync(f);
    try {
      raw.prepare(`INSERT INTO memory_entries(id, namespace, worker_id, last_writer_id, type, text, text_hash, embedding,
        embedding_model, embedding_revision, dim, tags, provenance, supersedes, created_at, updated_at, ttl_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('old-1', 'n', 'w', 'w', 'fact', 'legacy writer lemon note', 'hx', null, null, null, null, null, null, null, 5, 5, null);
      assert.deepStrictEqual(hits(raw, 'lemon'), ['old-1']);
      raw.prepare('DELETE FROM memory_entries WHERE id = ?').run('old-1');
      assert.deepStrictEqual(hits(raw, 'lemon'), []);
    } finally { raw.close(); }
  } finally { cleanup(dir); }
});

test('a plain (read copy) open of a store with no marker creates no FTS table, and ftsReady is false', () => {
  const dir = sandbox();
  try {
    const f = baseStore(dir, [['a', 'copy read row']]);
    const s = new Store(f); // no stamp: the shape every read copy opens with
    try {
      assert.ok(!objects(s.db, 'table').includes('memory_fts'));
      assert.deepStrictEqual(objects(s.db, 'trigger'), []);
      assert.strictEqual(metaOf(s.db, 'memory_fts_version'), null);
      assert.strictEqual(ftsReady(s.db), false);
      // the additive columns are present on the copy, so a read can select them
      for (const c of NEW_ENTRY_COLUMNS) assert.ok(cols(s.db, 'memory_entries').includes(c), c);
    } finally { s.close(); }
    // ftsReady creates nothing: a database with no meta table at all is simply not ready
    const bare = new DatabaseSync(':memory:');
    assert.strictEqual(ftsReady(bare), false);
    assert.deepStrictEqual(objects(bare, 'table'), []);
    bare.close();
  } finally { cleanup(dir); }
});

test('a copy of an owner store keeps the index and ftsReady is true on it', () => {
  const dir = sandbox();
  try {
    const f = path.join(dir, 'memory.db');
    const s = ownerOpen(f);
    s.store({ namespace: 'n', worker_id: 'w', text: 'copied pomelo row' });
    s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    s.close();
    const copy = path.join(dir, 'copy.db');
    fs.copyFileSync(f, copy);
    const c = new Store(copy);
    try {
      assert.strictEqual(ftsReady(c.db), true);
      assert.strictEqual(hits(c.db, 'pomelo').length, 1);
    } finally { c.close(); }
  } finally { cleanup(dir); }
});

test('SCHEMA_VERSION is 2 (the memory columns and redaction) and the stamp says so', () => {
  assert.strictEqual(SCHEMA_VERSION, 2);
  const dir = sandbox();
  try {
    const s = ownerOpen(path.join(dir, 'memory.db'));
    try { assert.strictEqual(metaOf(s.db, 'schema_version'), '2'); } finally { s.close(); }
  } finally { cleanup(dir); }
});

test('a second owner open of a built store changes no schema object: PRAGMA schema_version does not move', () => {
  const dir = sandbox();
  try {
    const f = path.join(dir, 'memory.db');
    const pragma = s => s.db.prepare('PRAGMA schema_version').get().schema_version;
    const first = ownerOpen(f);
    const v1 = pragma(first);
    first.close();
    const second = ownerOpen(f);
    try {
      assert.strictEqual(pragma(second), v1, 'the wrap-up index, the FTS table and the triggers are left as they are');
      migrateOwner(second.db);
      assert.strictEqual(pragma(second), v1, 'migrateOwner on a built store is a no-op');
    } finally { second.close(); }
  } finally { cleanup(dir); }
});

test('the memory_event wrap-up unique index rejects a second (run_id, key) of kind wrapup only', () => {
  const dir = sandbox();
  try {
    const s = ownerOpen(path.join(dir, 'memory.db'));
    try {
      const ev = (id, run, kind, key) => s.db.prepare(
        'INSERT INTO memory_event(id, run_id, kind, key, ok, written_at, written_by) VALUES (?, ?, ?, ?, 1, 1, ?)').run(id, run, kind, key, 't');
      ev('e1', 'r1', 'wrapup', 'task:t1');
      assert.throws(() => ev('e2', 'r1', 'wrapup', 'task:t1'), /UNIQUE constraint failed/);
      ev('e3', 'r1', 'wrapup', 'run');     // a different key
      ev('e4', 'r2', 'wrapup', 'task:t1'); // a different run
      ev('e5', 'r1', 'observation', 'task:t1'); // other kinds may repeat the key
      ev('e6', 'r1', 'observation', 'task:t1');
      assert.strictEqual(s.db.prepare('SELECT COUNT(*) AS n FROM memory_event').get().n, 5);
      assert.deepStrictEqual(cols(s.db, 'memory_event'), [
        'seq', 'id', 'run_id', 'worker_id', 'task_id', 'kind', 'key', 'row_ids', 'newest_row_id', 'bytes', 'sha256',
        'ok', 'code', 'message', 'dropped', 'over_budget', 'written_at', 'written_by']);
    } finally { s.close(); }
  } finally { cleanup(dir); }
});

test('the usage table and the run columns project and memory_levers exist, on a base store too', () => {
  const dir = sandbox();
  try {
    const f = baseStore(dir, []);
    const s = ownerOpen(f);
    try {
      assert.deepStrictEqual(cols(s.db, 'usage'), [
        'seq', 'id', 'run_id', 'worker_id', 'task_id', 'turn', 'substrate', 'model', 'input_tokens', 'output_tokens',
        'cache_read_tokens', 'cache_creation_tokens', 'cost_usd', 'cost_basis', 'at', 'written_at', 'written_by']);
      assert.ok(cols(s.db, 'run').includes('project'));
      assert.ok(cols(s.db, 'run').includes('memory_levers'));
      s.db.prepare('INSERT INTO usage(id, run_id, written_at, written_by) VALUES (?, ?, 1, ?)').run('u1', 'r', 't');
      s.db.prepare("INSERT INTO run(id, epoch, written_at, written_by, project, memory_levers) VALUES ('r', 1, 1, 't', 'p', '{}')").run();
      assert.strictEqual(s.db.prepare("SELECT project FROM run WHERE id = 'r'").get().project, 'p');
    } finally { s.close(); }
  } finally { cleanup(dir); }
});

test('with FTS5 reported missing, nothing is built, the result is unsupported and the marker is 0', () => {
  const dir = sandbox();
  try {
    const f = baseStore(dir, [['a', 'some text']]);
    const db = new DatabaseSync(f);
    try {
      ensureSchema(db);
      assert.deepStrictEqual(migrateOwner(db, { hasFts5: () => false }), { fts: 'unsupported', rows: 0 });
      assert.strictEqual(metaOf(db, 'memory_fts_version'), '0');
      assert.ok(!objects(db, 'table').includes('memory_fts'));
      assert.deepStrictEqual(objects(db, 'trigger'), []);
      assert.strictEqual(ftsReady(db), false);
      // a later open on a SQLite that does have FTS5 builds it and flips the marker
      assert.deepStrictEqual(migrateOwner(db), { fts: 'built', rows: 1 });
      assert.strictEqual(metaOf(db, 'memory_fts_version'), '1');
    } finally { db.close(); }
  } finally { cleanup(dir); }
});

test('the real compile-option probe says this Node has FTS5 and creates nothing', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.strictEqual(db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS ok").get().ok, 1);
    assert.deepStrictEqual(objects(db, 'table'), []);
  } finally { db.close(); }
});

test('the ten new error codes are listed, and an unlisted code is still downgraded', () => {
  for (const c of ['E_NO_INDEX', 'E_QUERY_SHORT', 'E_RECEIPT', 'E_SUMMARISER_ABSENT', 'E_SUMMARY_EMPTY', 'E_SUMMARY_MALFORMED',
    'E_SUMMARY_REFUSED', 'E_SUMMARY_OVER_BUDGET', 'E_LEVER_OFF', 'E_EXISTS']) {
    assert.ok(CODES.has(c), c);
    assert.strictEqual(new CoreError(c, 'x').code, c);
  }
  assert.strictEqual(new CoreError('E_NOT_A_CODE', 'x').code, 'E_INTERNAL');
});

test('VACUUM INTO keeps rowids, so the external-content index of a backup still matches its rows', () => {
  const dir = sandbox();
  try {
    const s = ownerOpen(path.join(dir, 'memory.db'));
    try {
      for (let i = 0; i < 6; i++) s.store({ namespace: 'n', worker_id: 'w', text: `row number ${i} tangerine${i}` });
      s.db.prepare("DELETE FROM memory_entries WHERE text LIKE '%tangerine1%' OR text LIKE '%tangerine3%'").run();
      const out = path.join(dir, 'backup.db');
      s.db.exec(`VACUUM INTO '${out}'`);
      const b = new DatabaseSync(out);
      try {
        const ids = hits(b, 'tangerine4');
        assert.strictEqual(ids.length, 1);
        assert.strictEqual(b.prepare('SELECT text FROM memory_entries WHERE id = ?').get(ids[0]).text, 'row number 4 tangerine4');
        b.exec("INSERT INTO memory_fts(memory_fts) VALUES ('integrity-check')");
      } finally { b.close(); }
    } finally { s.close(); }
  } finally { cleanup(dir); }
});

test('a store with the old wrap-up index (failed rows included) is upgraded by the owner: dropped, recreated, rows kept', () => {
  const dir = sandbox();
  try {
    const f = path.join(dir, 'memory.db');
    const first = ownerOpen(f);
    first.db.exec('DROP INDEX ux_memory_event_wrapup');
    first.db.exec("CREATE UNIQUE INDEX ux_memory_event_wrapup ON memory_event(run_id, key) WHERE kind = 'wrapup'");
    const ev = (id, ok) => first.db.prepare("INSERT INTO memory_event(id, run_id, kind, key, ok, code, written_at, written_by) VALUES (?, 'r', 'wrapup', 'run', ?, ?, 1, 't')").run(id, ok, ok ? null : 'E_X');
    ev('f1', 0);
    assert.throws(() => ev('f2', 0), /UNIQUE constraint failed/, 'the old index blocks even a second failure');
    first.close();
    // A read copy's ensureSchema never rewrites the index (invariant 6): only the owner's open does.
    const reader = new Store(f);
    try { assert.doesNotMatch(reader.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ux_memory_event_wrapup'").get().sql, /ok\s*=\s*1/); } finally { reader.close(); }
    const owner = ownerOpen(f);
    try {
      assert.match(owner.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ux_memory_event_wrapup'").get().sql, /ok\s*=\s*1/);
      assert.strictEqual(owner.db.prepare("SELECT COUNT(*) AS n FROM memory_event WHERE id = 'f1'").get().n, 1, 'the existing row is kept');
      ev2(owner, 'f3', 0);
      ev2(owner, 's1', 1);
      assert.throws(() => ev2(owner, 's2', 1), /UNIQUE constraint failed/, 'a second success is still refused');
      migrateOwner(owner.db); // idempotent
      assert.strictEqual(owner.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'ux_memory_event_wrapup'").get().n, 1);
    } finally { owner.close(); }
  } finally { cleanup(dir); }
});
function ev2(s, id, ok) {
  s.db.prepare("INSERT INTO memory_event(id, run_id, kind, key, ok, code, written_at, written_by) VALUES (?, 'r', 'wrapup', 'run', ?, ?, 1, 't')").run(id, ok, ok ? null : 'E_X');
}
