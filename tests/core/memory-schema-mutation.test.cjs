'use strict';
// memory-schema-mutation.test.cjs — claims of memory-schema.cjs that a mutation run showed no other test pins
// down: a failed wrap-up index migration is raised and rolled back, an unsupported store is not rewritten on
// every open, and the wrap-up index is migrated once (a second open changes nothing).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { core, sandbox, cleanup } = require('./helpers.cjs');

const { migrateOwner, ftsReady } = core('memory-schema.cjs');
const { ensureSchema } = core('schema.cjs');

const changes = (db) => db.prepare('SELECT total_changes() AS n').get().n;
const schemaVersion = (db) => db.prepare('PRAGMA schema_version').get().schema_version;
const indexSql = (db) => (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ux_memory_event_wrapup'").get() || {}).sql;

function withDb(fn) {
  const dir = sandbox();
  const db = new DatabaseSync(path.join(dir, 'memory.db'));
  try { ensureSchema(db); fn(db); } finally { db.close(); cleanup(dir); }
}

const noFts = { hasFts5: () => false };

test('with FTS5 unsupported the marker is written once and a second open writes nothing', () => {
  withDb((db) => {
    migrateOwner(db, noFts);
    const marker = db.prepare("SELECT value FROM meta WHERE key = 'memory_fts_version'").get().value;
    assert.strictEqual(marker, '0');
    const n = changes(db);
    assert.deepStrictEqual(migrateOwner(db, noFts), { fts: 'unsupported', rows: 0 });
    assert.strictEqual(changes(db), n, 'a store already marked 0 is not rewritten');
  });
});

test('ftsReady is false on a store with no meta table or no marker, and never creates one', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.strictEqual(ftsReady(db), false);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get().n, 0);
  } finally { db.close(); }
  withDb((db2) => assert.strictEqual(ftsReady(db2), false));
});

test('a wrap-up index that cannot be rebuilt raises and leaves the store as it was', () => {
  withDb((db) => {
    // the index as an old store held it is gone, and two successful wrap-ups collide
    db.exec('DROP INDEX ux_memory_event_wrapup');
    const cols = db.prepare('PRAGMA table_info(memory_event)').all().map((c) => c.name);
    const need = cols.filter((c) => !['seq'].includes(c));
    const notNull = db.prepare('PRAGMA table_info(memory_event)').all().filter((c) => c.notnull && !c.dflt_value && c.name !== 'seq').map((c) => c.name);
    const vals = { id: 'e', run_id: 'r', kind: 'wrapup', key: 'k', ok: 1, written_at: 1, written_by: 't', at: 1 };
    const use = need.filter((c) => notNull.includes(c) || ['id', 'run_id', 'kind', 'key', 'ok'].includes(c));
    const ins = (id) => db.prepare(`INSERT INTO memory_event(${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`).run(...use.map((c) => (c === 'id' ? id : (vals[c] ?? 1))));
    ins('e1'); ins('e2');
    assert.strictEqual(indexSql(db), undefined);
    assert.throws(() => migrateOwner(db, noFts), /UNIQUE|constraint/i);
    assert.strictEqual(indexSql(db), undefined, 'the failed migration rolled back');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM memory_event').get().n, 2, 'no row was touched');
    // and the store is usable afterwards: the transaction is closed
    db.exec('BEGIN IMMEDIATE'); db.exec('COMMIT');
  });
});

test('an old wrap-up index that counted every row is replaced by the successes-only one', () => {
  withDb((db) => {
    db.exec('DROP INDEX ux_memory_event_wrapup');
    db.exec("CREATE UNIQUE INDEX ux_memory_event_wrapup ON memory_event(run_id, key) WHERE kind = 'wrapup'");
    assert.ok(!/ok\s*=\s*1/.test(indexSql(db)));
    migrateOwner(db, noFts);
    assert.match(indexSql(db), /ok\s*=\s*1/);
  });
});

test('a store whose wrap-up index is current is left alone by a second open', () => {
  withDb((db) => {
    migrateOwner(db, noFts);
    const v = schemaVersion(db);
    migrateOwner(db, noFts);
    assert.strictEqual(schemaVersion(db), v, 'dropping and recreating the index bumps the schema version');
  });
});
