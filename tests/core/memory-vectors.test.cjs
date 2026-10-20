'use strict';
// memory-vectors.test.cjs — the vector cache table (ADR 0050 decisions 1 and 2): the owner-only migration and its backfill,
// the mirror of every inline vector write, the row-first selection and the derived backlog, and the sweep on delete.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { core, sandbox, cleanup } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const MV = core('memory-vectors.cjs');
const NT = core('memory-notes.cjs');
const { retitle } = core('methods-memory-notes.cjs');

const NANO = { model: 'nano', revision: 'r1', dims: 4 };
const HEAVY = { model: 'heavy', revision: 'r9', dims: 4 };
const vec = (...a) => { const v = [...a]; while (v.length < 4) v.push(0); return v; };
const blobOf = (...a) => Buffer.from(new Float32Array(vec(...a)).buffer);
const withStore = (fn) => {
  const dir = sandbox();
  const s = new Store(path.join(dir, 'memory.db'), { stamp: true });
  try { return fn(s, dir); } finally { try { s.close(); } catch { /* closed */ } cleanup(dir); }
};
const note = (s, ns, title, when, extra = {}) => {
  const body = { when, state: 'live' };
  const text = NT.keywordText({ title, when });
  return s.store({ namespace: ns, worker_id: 'w', type: 'note', text, title, body, embedding: vec(1, 0.5), embedding_model: 'nano', embedding_revision: 'r1', dim: 4, text_template: 'v2', ...extra });
};
const fact = (s, ns, text, v = vec(1, 2)) => s.store({ namespace: ns, worker_id: 'w', text, embedding: v, embedding_model: 'nano', embedding_revision: 'r1', dim: 4 });
const count = db => Number(db.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get().n);
const rowOf = (s, id) => s.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const hashOfV2 = (title, when) => MV.embedHashOf({ title, body: { when }, text_template: 'v2', text: '' }, 'v2');
const hashOfV1 = (text) => MV.embedHashOf({ text }, 'v1');
const nanoRows = (db) => db.prepare("SELECT * FROM memory_vectors WHERE model = 'nano'").all();
const putHeavy = (s, id) => MV.putVector(s.db, { ...HEAVY, template: 'v2' }, MV.embedHashOf(rowOf(s, id), 'v2'), blobOf(1));

test('a fresh owner store has the table, and a store that is not the owner does not create it', () => {
  withStore((s) => { assert.ok(MV.hasTable(s.db)); });
  const dir = sandbox();
  try {
    const f = path.join(dir, 'memory.db');
    const db = new DatabaseSync(f);
    db.exec('PRAGMA journal_mode=WAL');
    db.close();
    const r = new Store(f); // not the owner: no stamp
    try {
      assert.strictEqual(MV.hasTable(r.db), false);
      // a writer that is not the owner skips the mirror and still writes the row
      assert.ok(fact(r, 'project/a', 'plain').id);
      assert.strictEqual(MV.hasTable(r.db), false);
    } finally { r.close(); }
  } finally { cleanup(dir); }
});

test('the migration backfills every inline vector, keeps every row and is idempotent', () => {
  const dir = sandbox();
  try {
    const f = path.join(dir, 'memory.db');
    let s = new Store(f, { stamp: true });
    note(s, 'project/a', 'first claim', 'when one');
    fact(s, 'project/a', 'a legacy fact');
    s.store({ namespace: 'project/a', worker_id: 'w', text: 'no vector at all' });
    const before = s.count();
    s.db.exec('DROP TABLE memory_vectors');
    s.close();
    s = new Store(f, { stamp: true }); // the owner opens the old shape again and migrates
    try {
      assert.strictEqual(s.count(), before);
      const rows = s.db.prepare('SELECT * FROM memory_vectors ORDER BY template').all();
      assert.deepStrictEqual(rows.map(r => [r.model, r.model_revision, r.dims, r.template]), [['nano', 'r1', 4, 'v1'], ['nano', 'r1', 4, 'v2']]);
      assert.strictEqual(rows[1].embed_hash, hashOfV2('first claim', 'when one'));
      assert.strictEqual(rows[0].embed_hash, hashOfV1('a legacy fact'));
      assert.strictEqual(MV.migrateVectors(s.db).table, 'ready');
      assert.strictEqual(count(s.db), 2);
      assert.strictEqual(s.count(), before);
    } finally { s.close(); }
  } finally { cleanup(dir); }
});

test('dual write: insert, set, re-embed and retitle each keep the table in step with the inline vector', () => {
  withStore((s) => {
    const a = note(s, 'project/a', 'old title', 'in a case');
    assert.strictEqual(count(s.db), 1);
    assert.strictEqual(nanoRows(s.db)[0].embed_hash, hashOfV2('old title', 'in a case'));
    // a vector-less row gets one (belay memory embed)
    const bare = s.store({ namespace: 'project/a', worker_id: 'w', text: 'bare text' });
    s.tx(() => s.setEmbedding(bare.id, { embedding: vec(0, 1), embedding_model: 'nano', embedding_revision: 'r1', dim: 4, text_template: 'v1' }));
    assert.strictEqual(count(s.db), 2);
    // a re-embed under another template replaces the vector, and the old template's vector is swept
    const plain = s.store({ namespace: 'project/a', worker_id: 'w', type: 'note', text: 'plain note', title: 'plain note', body: { when: 'a trigger' }, embedding: vec(1), embedding_model: 'nano', embedding_revision: 'r1', dim: 4 });
    assert.strictEqual(count(s.db), 3);
    s.tx(() => s.replaceEmbedding(plain.id, { embedding: vec(0, 0, 1), embedding_model: 'nano', embedding_revision: 'r1', dim: 4, text_template: 'v2' }));
    assert.strictEqual(count(s.db), 3);
    assert.ok(nanoRows(s.db).some(r => r.template === 'v2' && r.embed_hash === hashOfV2('plain note', 'a trigger')));
    assert.ok(!nanoRows(s.db).some(r => r.template === 'v1' && r.embed_hash === hashOfV1('plain note')));
    // a retitle re-embeds: the new title's vector exists, the old one is gone
    s.tx(() => retitle({ store: s }, rowOf(s, a.id), 'new title', { embedding: vec(0.2, 1), embedding_model: 'nano', embedding_revision: 'r1', dim: 4, text_template: 'v2' }));
    const hashes = nanoRows(s.db).map(r => r.embed_hash);
    assert.ok(hashes.includes(hashOfV2('new title', 'in a case')));
    assert.ok(!hashes.includes(hashOfV2('old title', 'in a case')));
    assert.strictEqual(count(s.db), 3);
    // a retitle under keyword mode drops the row's vector with the row's
    s.tx(() => retitle({ store: s }, rowOf(s, a.id), 'third title', { unembedded: { code: 'x', message: 'y' } }));
    assert.ok(!nanoRows(s.db).some(r => r.embed_hash === hashOfV2('new title', 'in a case')));
    assert.strictEqual(count(s.db), 2);
  });
});

test('row-first selection excludes held, archived and superseded notes for any tier key, including a note with no heavy vector', () => {
  withStore((s) => {
    const live = note(s, 'project/a', 'live note', 'when live');
    const sup = note(s, 'project/a', 'old note', 'when old');
    const fresh = note(s, 'project/a', 'new note', 'when new', { supersedes: sup.id });
    const held = note(s, 'project/a', 'held note', 'when held');
    s.patchBody(held.id, b => { b.held = { id: 'h1' }; return b; });
    note(s, 'archive/a', 'archived note', 'when archived');
    note(s, 'held/a', 'a hold row', 'when hold');
    // the heavy tier has vectors for the live and the superseded note only
    putHeavy(s, live.id);
    putHeavy(s, sup.id);
    const ns = ['project/a', 'archive/a', 'held/a'];
    const heavy = MV.selectSearchable(s.db, HEAVY, { namespaces: ns });
    assert.deepStrictEqual(heavy.rows.map(r => r.id), [live.id]);
    assert.deepStrictEqual(heavy.missing, [fresh.id], 'the new note has no heavy vector yet and is reported, not dropped');
    const nano = MV.selectSearchable(s.db, NANO, { namespaces: ns });
    assert.deepStrictEqual(nano.rows.map(r => r.id).sort(), [live.id, fresh.id].sort(), 'never held, archived or superseded');
    assert.strictEqual(nano.missing.length, 0);
    assert.ok(nano.rows.every(r => r.vector instanceof Float32Array && r.vector.length === 4));
    assert.deepStrictEqual([...MV.vectorsFor(s.db, HEAVY, [live.id, sup.id, held.id]).keys()].sort(), [live.id, sup.id].sort());
  });
});

test('the backlog is derived, and holds neither held nor archived notes', () => {
  withStore((s) => {
    const a = note(s, 'project/a', 'one', 'when one');
    const b = note(s, 'project/a', 'two', 'when two');
    const held = note(s, 'project/a', 'three', 'when three');
    s.patchBody(held.id, x => { x.held = { id: 'h' }; return x; });
    note(s, 'archive/a', 'four', 'when four');
    fact(s, 'project/a', 'not a note');
    assert.deepStrictEqual(MV.backlog(s.db, HEAVY).map(r => r.id).sort(), [a.id, b.id].sort());
    assert.deepStrictEqual(MV.backlog(s.db, HEAVY, { namespaces: ['archive/a'] }), []);
    assert.deepStrictEqual(MV.backlog(s.db, NANO), []);
    putHeavy(s, a.id);
    assert.deepStrictEqual(MV.backlog(s.db, HEAVY).map(r => r.id), [b.id]);
  });
});

test('a delete sweeps its orphan vector, an archive move keeps it, and sweep() removes strays', () => {
  withStore((s) => {
    const a = note(s, 'project/a', 'one', 'when one');
    const b = note(s, 'project/a', 'two', 'when two');
    assert.strictEqual(count(s.db), 2);
    s.tx(() => s.moveRow(a.id, 'project/a', 'archive/a'));
    assert.strictEqual(count(s.db), 2, 'an archived row keeps its vectors');
    s.delete(b.id);
    assert.strictEqual(count(s.db), 1);
    s.delete(a.id);
    assert.strictEqual(count(s.db), 0);
    // a heavy stray (no row carries its text) is removed by sweep; the one a row still renders is kept
    const c = note(s, 'project/a', 'three', 'when three');
    putHeavy(s, c.id);
    MV.putVector(s.db, { ...HEAVY, template: 'v2' }, 'f'.repeat(64), blobOf(1));
    assert.strictEqual(count(s.db), 3);
    s.db.exec('BEGIN IMMEDIATE');
    assert.strictEqual(MV.sweep(s.db), 1);
    s.db.exec('COMMIT');
    assert.strictEqual(count(s.db), 2);
  });
});

test('ttl expiry sweeps the expired row\'s vector', () => {
  withStore((s) => {
    note(s, 'project/a', 'short lived', 'when it ends', { ttl_seconds: 0.001 });
    const keep = note(s, 'project/a', 'kept', 'when kept');
    assert.strictEqual(count(s.db), 2);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    assert.strictEqual(s.sweep().expired_deleted, 1);
    assert.strictEqual(count(s.db), 1);
    assert.strictEqual(MV.vectorsFor(s.db, NANO, [keep.id]).size, 1);
  });
});

test('two rows with the same text in two namespaces share one vector, and deleting one keeps it for the other', () => {
  withStore((s) => {
    const a = fact(s, 'project/a', 'shared words');
    const b = fact(s, 'project/b', 'shared words');
    assert.strictEqual(count(s.db), 1);
    s.delete(a.id);
    assert.strictEqual(count(s.db), 1, 'project/b still carries the text');
    assert.strictEqual(MV.vectorsFor(s.db, NANO, [b.id]).size, 1);
    s.delete(b.id);
    assert.strictEqual(count(s.db), 0);
  });
});
