'use strict';
// schema-stamp.test.cjs — memory plan G3: meta.schema_version and meta.written_by, written only by the
// owner's open for write, and a core that refuses a store whose schema is newer than it knows.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const { Store } = core('store.cjs');
const { SCHEMA_VERSION, readCommit, writtenBy } = core('schema-stamp.cjs');

const vec = i => [Math.cos(i), Math.sin(i)];
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const metaOf = f => {
  const db = new DatabaseSync(f, { readOnly: true });
  try { return Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map(r => [r.key, r.value])); }
  finally { db.close(); }
};
const files = dir => fs.readdirSync(dir).sort().join(',');

// A store as a future core would leave it: this core's tables, plus a newer stamp.
function newerStore(dir, version = SCHEMA_VERSION + 1) {
  const f = path.join(dir, 'memory.db');
  const s = new Store(f);
  s.close();
  const db = new DatabaseSync(f);
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(version));
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('written_by', 'belay@9.9.9+future00000');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return f;
}

test('written_by is read from .git files, twelve hex characters', () => {
  const c = readCommit();
  assert.match(c, /^([0-9a-f]{12}|unknown)$/);
  assert.match(writtenBy(), /^belay@\d+\.\d+\.\d+\S*\+([0-9a-f]{12}|unknown)$/);
  assert.strictEqual(readCommit(path.join(sandbox(), 'nowhere')), 'unknown');
});

test('a plain Store open stamps nothing; the owner open stamps schema_version and written_by', () => {
  const dir = sandbox();
  try {
    const f = path.join(dir, 'memory.db');
    new Store(f).close();
    assert.deepStrictEqual(metaOf(f), {}, 'a store opened without stamp carries no stamp');
    const s = new Store(f, { stamp: true });
    s.close();
    const m = metaOf(f);
    assert.strictEqual(m.schema_version, String(SCHEMA_VERSION));
    assert.strictEqual(m.written_by, writtenBy());
  } finally { cleanup(dir); }
});

test('an owner start on a legacy store (no stamp) stamps it and keeps its rows', async () => {
  const dir = sandbox();
  try {
    const f = path.join(dir, 'memory.db');
    const s = new Store(f);
    s.store({ namespace: 'n', worker_id: 'w', text: 'legacy row', embedding: vec(1), embedding_model: 'm', dim: 2 });
    s.close();
    const c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    await c.memory.store({ namespace: 'n', text: 'new row', embedding: vec(2), embedding_model: 'm', dim: 2 });
    assert.strictEqual(metaOf(f).schema_version, String(SCHEMA_VERSION));
    await c.shutdownOwner();
    await c.close();
    const db = new DatabaseSync(f, { readOnly: true });
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM memory_entries').get().n, 2);
    db.close();
  } finally { cleanup(dir); }
});

test('a read of an unstamped store does not stamp it: the file and the directory are unchanged', async () => {
  const dir = sandbox();
  try {
    const f = path.join(dir, 'memory.db');
    new Store(f).close();
    const before = { sha: sha(f), ls: files(dir) };
    const c = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    await c.memory.get({ id: 'nothing' });
    await c.close();
    assert.deepStrictEqual({ sha: sha(f), ls: files(dir) }, before);
    assert.deepStrictEqual(metaOf(f), {});
  } finally { cleanup(dir); }
});

test('a read of a store with a newer schema is refused E_SCHEMA_NEWER and writes nothing', async () => {
  const dir = sandbox();
  try {
    const f = newerStore(dir);
    const before = { sha: sha(f), ls: files(dir) };
    const c = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    await assert.rejects(c.memory.get({ id: 'x' }), e => {
      assert.strictEqual(e.code, 'E_SCHEMA_NEWER');
      assert.strictEqual(e.detail.store_schema, String(SCHEMA_VERSION + 1));
      assert.strictEqual(e.detail.known_schema, SCHEMA_VERSION);
      assert.strictEqual(e.detail.reason, 'newer');
      assert.strictEqual(e.detail.written_by, 'belay@9.9.9+future00000');
      return true;
    });
    await c.close();
    assert.deepStrictEqual({ sha: sha(f), ls: files(dir) }, before, 'the live store is byte-identical and no sidecar appeared');
  } finally { cleanup(dir); }
});

test('an owner start on a newer store fails E_SCHEMA_NEWER, releases the lock and leaves the store untouched', async () => {
  const dir = sandbox();
  try {
    const f = newerStore(dir);
    const before = { sha: sha(f), ls: files(dir) };
    const c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    await assert.rejects(c.memory.store({ namespace: 'n', text: 'x', embedding: vec(1), embedding_model: 'm', dim: 2 }), e => e.code === 'E_SCHEMA_NEWER');
    await c.close();
    assert.deepStrictEqual({ sha: sha(f), ls: files(dir) }, before, 'no row, no stamp downgrade, no lock directory left');
    assert.strictEqual(metaOf(f).schema_version, String(SCHEMA_VERSION + 1));
  } finally { cleanup(dir); }
});

test('a schema_version that is not a positive integer is refused too', () => {
  for (const bad of ['0', 'abc', '-1', '1.5']) {
    const dir = sandbox();
    try {
      const f = newerStore(dir, bad);
      assert.throws(() => new Store(f, { stamp: true }), e => e.code === 'E_SCHEMA_NEWER' && e.detail.reason === 'malformed' && /not a positive integer/.test(e.message), `value ${bad}`);
    } finally { cleanup(dir); }
  }
});

// The 0.1.0 core (schema 1, before the memory columns), copied from its fixture into the sandbox: its store,
// its schema, its stamp and its errors are the whole of what its Store requires.
function baseCore(dir) {
  const root = path.join(dir, 'base');
  fs.mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
  for (const m of ['store', 'schema', 'schema-stamp', 'errors']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'v0.1.0', 'src', 'core', `${m}.cjs`), 'utf8');
    fs.writeFileSync(path.join(root, 'src', 'core', `${m}.cjs`), src);
  }
  return require(path.join(root, 'src', 'core', 'store.cjs')).Store;
}

test('a version-1 store written by the base core migrates to version 2, and the base core then refuses it', () => {
  const dir = sandbox();
  try {
    const BaseStore = baseCore(dir);
    const f = path.join(dir, 'data', 'memory.db');
    const b = new BaseStore(f, { stamp: true });
    b.store({ namespace: 'run/r1', worker_id: 'w1', text: 'base row one pidAlive' });
    b.store({ namespace: 'run/r1', worker_id: 'w1', text: 'base row two' });
    b.close();
    assert.strictEqual(metaOf(f).schema_version, '1', 'the base core stamps schema 1');

    const s = new Store(f, { stamp: true });
    try {
      assert.strictEqual(s.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version').value, '2');
      const rows = s.db.prepare('SELECT text, title, status, redactions FROM memory_entries ORDER BY text').all().map(r => ({ ...r }));
      assert.deepStrictEqual(rows, [
        { text: 'base row one pidAlive', title: null, status: null, redactions: null },
        { text: 'base row two', title: null, status: null, redactions: null },
      ]);
      const hit = s.db.prepare('SELECT COUNT(*) AS n FROM memory_fts WHERE memory_fts MATCH ?').get('"pidAlive"').n;
      assert.strictEqual(hit, 1, 'the keyword index is backfilled over the base rows');
      s.store({ namespace: 'run/r1', worker_id: 'w2', text: 'new row three', title: 'T3' });
    } finally { s.close(); }

    // The base core, as owner or as a reader, refuses the migrated store before writing anything to it.
    const before = { sha: sha(f), ls: files(path.dirname(f)) };
    for (const opts of [{ stamp: true }, {}]) {
      assert.throws(() => new BaseStore(f, opts), e => e.code === 'E_SCHEMA_NEWER' && e.detail.store_schema === '2' && e.detail.known_schema === 1);
    }
    assert.deepStrictEqual({ sha: sha(f), ls: files(path.dirname(f)) }, before);
    // This core still opens it, read and owner alike, and the rows are all there.
    const again = new Store(f);
    try { assert.strictEqual(again.db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get().n, 3); } finally { again.close(); }
  } finally { cleanup(dir); }
});

test('the owner open checks, migrates and stamps in one transaction: a failed migration leaves the old stamp', () => {
  const dir = sandbox();
  try {
    const f = path.join(dir, 'memory.db');
    const db = new DatabaseSync(f);
    // A version-1 store whose meta table exists but whose memory_entries is a view, so ensureSchema's index fails.
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('schema_version', '1'); CREATE VIEW memory_entries AS SELECT 1 AS id");
    db.close();
    assert.throws(() => new Store(f, { stamp: true }), /views may not be indexed/);
    assert.strictEqual(metaOf(f).schema_version, '1', 'no version-2 stamp on a store whose migration did not commit');
    const left = new DatabaseSync(f, { readOnly: true });
    try {
      const tables = left.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(r => r.name);
      assert.deepStrictEqual(tables, ['meta'], 'the half-run migration rolled back whole: no table it created is left');
    } finally { left.close(); }
  } finally { cleanup(dir); }
});

test('a store at this core\'s own schema opens, and an owner open leaves schema_version unchanged', () => {
  const dir = sandbox();
  try {
    const f = path.join(dir, 'memory.db');
    new Store(f, { stamp: true }).close();
    new Store(f, { stamp: true }).close();
    assert.strictEqual(metaOf(f).schema_version, String(SCHEMA_VERSION));
  } finally { cleanup(dir); }
});
