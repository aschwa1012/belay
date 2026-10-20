'use strict';
// memory-vectors-catchup.test.cjs — the owner's start (create and backfill once, then a catch-up that never rewrites), the
// write paths that change a row's templates, and the cache's refusals when its table is absent.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { core, sandbox, cleanup } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const MV = core('memory-vectors.cjs');
const NT = core('memory-notes.cjs');

const NANO = { model: 'nano', revision: 'r1', dims: 4 };
const HEAVY = { model: 'heavy', revision: 'r9', dims: 4 };
const blobOf = () => Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);
const emb = (template) => ({ embedding: [1, 0.5, 0, 0], embedding_model: 'nano', embedding_revision: 'r1', dim: 4, text_template: template });
const withDir = (fn) => { const dir = sandbox(); try { return fn(dir, path.join(dir, 'memory.db')); } finally { cleanup(dir); } };
const note = (s, title, when, extra = {}) => s.store({ namespace: 'project/a', worker_id: 'w', type: 'note', text: NT.keywordText({ title, when }), title, body: { when }, ...extra });
const rows = db => db.prepare('SELECT * FROM memory_vectors ORDER BY template, embed_hash').all();

test('a second owner start rewrites nothing, inserts only what is missing and sweeps only what is unreferenced', () => withDir((dir, f) => {
  let s = new Store(f, { stamp: true });
  note(s, 'one', 'when one', emb('v2'));
  note(s, 'two', 'when two', emb('v2'));
  s.store({ namespace: 'project/a', worker_id: 'w', text: 'a fact', ...emb('v1') });
  s.db.exec('UPDATE memory_vectors SET created_at = 7');
  s.close();
  s = new Store(f, { stamp: true });
  try {
    assert.deepStrictEqual(rows(s.db).map(r => r.created_at), [7, 7, 7], 'nothing was rewritten: created_at is the sentinel');
    assert.deepStrictEqual(MV.catchUp(s.db), { caught_up: 0, swept: 0 });
    // one vector lost and one stray added: the next start restores the first, removes the second, and touches no other
    const lost = rows(s.db)[0];
    s.db.prepare('DELETE FROM memory_vectors WHERE embed_hash = ?').run(lost.embed_hash);
    MV.putVector(s.db, { ...HEAVY, template: 'v2' }, 'e'.repeat(64), blobOf(), 7);
    s.close();
    s = new Store(f, { stamp: true });
    const after = rows(s.db);
    assert.strictEqual(after.length, 3);
    assert.ok(!after.some(r => r.model === 'heavy'));
    assert.strictEqual(after.filter(r => r.created_at === 7).length, 2, 'the two untouched vectors keep their created_at');
    assert.ok(after.some(r => r.embed_hash === lost.embed_hash && r.created_at !== 7), 'the lost one came back');
  } finally { s.close(); }
}));

test('the first start with the table absent backfills once under INSERT OR IGNORE', () => withDir((dir, f) => {
  let s = new Store(f, { stamp: true });
  note(s, 'one', 'when one', emb('v2'));
  s.db.exec('DROP TABLE memory_vectors');
  s.close();
  s = new Store(f, { stamp: true });
  try { assert.strictEqual(rows(s.db).length, 1); } finally { s.close(); }
}));

test('a same-writer dedup update that adds a vector records its model, revision and dim, so the vector is cached', () => withDir((dir, f) => {
  const s = new Store(f, { stamp: true });
  try {
    const bare = s.store({ namespace: 'project/a', worker_id: 'w', text: 'same text' });
    assert.strictEqual(rows(s.db).length, 0);
    const again = s.store({ namespace: 'project/a', worker_id: 'w', text: 'same text', ...emb('v1') });
    assert.strictEqual(again.id, bare.id);
    assert.strictEqual(again.action, 'updated');
    const r = s.p('SELECT embedding_model, embedding_revision, dim FROM memory_entries WHERE id = ?').get(bare.id);
    assert.deepStrictEqual({ ...r }, { embedding_model: 'nano', embedding_revision: 'r1', dim: 4 });
    assert.strictEqual(rows(s.db).length, 1);
  } finally { s.close(); }
}));

test('clearing a v2 note\'s inline vector keeps the vector its render template still references; a legacy v1 note with a when is found under its inline template', () => withDir((dir, f) => {
  const s = new Store(f, { stamp: true });
  try {
    const a = note(s, 'one', 'when one', emb('v2'));
    s.tx(() => s.clearEmbedding(a.id));
    assert.strictEqual(rows(s.db).length, 1, 'the v2 vector stays: the row still renders v2');
    const legacy = note(s, 'legacy', 'when legacy', { ...emb('v1'), text: 'legacy stored text' });
    assert.deepStrictEqual(MV.selectSearchable(s.db, NANO, { namespaces: ['project/a'] }).rows.map(r => r.id).sort(), [a.id, legacy.id].sort(), 'both are found: the cache is keyed by content');
    assert.deepStrictEqual(MV.backlog(s.db, NANO, { namespaces: ['project/a'] }), []);
  } finally { s.close(); }
}));

test('setEmbedding that changes the template sweeps the vector the old template held', () => withDir((dir, f) => {
  const s = new Store(f, { stamp: true });
  try {
    const a = note(s, 'one', 'when one', emb('v1'));
    s.tx(() => s.clearEmbedding(a.id));
    // a v1 vector cached under the old text is now an orphan only if nothing references it; setEmbedding to v2 must not strand it
    s.tx(() => s.setEmbedding(a.id, { embedding: [0, 1, 0, 0], embedding_model: 'nano', embedding_revision: 'r1', dim: 4, text_template: 'v2' }));
    assert.deepStrictEqual(rows(s.db).map(r => r.template), ['v2']);
    s.tx(() => s.replaceEmbedding(a.id, { embedding: [0, 0, 1, 0], embedding_model: 'nano', embedding_revision: 'r1', dim: 4, text_template: 'v1' }));
    assert.deepStrictEqual(rows(s.db).map(r => r.template).sort(), ['v1', 'v2'], 'v2 stays (render template), v1 is the inline one');
  } finally { s.close(); }
}));

test('sweepRows ignores partial rows', () => withDir((dir, f) => {
  const s = new Store(f, { stamp: true });
  try {
    note(s, 'one', 'when one', emb('v2'));
    assert.strictEqual(MV.sweepRows(s.db, [null, {}, { text: 5 }]), 0);
    assert.strictEqual(rows(s.db).length, 1);
  } finally { s.close(); }
}));

test('reads of the cache without its table are refused E_NO_INDEX, not "no such table"', () => withDir((dir, f) => {
  const s = new Store(f); // not the owner: the table is never made
  try {
    const code = x => x.code === 'E_NO_INDEX';
    assert.throws(() => MV.vectorsFor(s.db, NANO, ['x']), code);
    assert.throws(() => MV.selectSearchable(s.db, NANO, { namespaces: ['project/a'] }), code);
    assert.throws(() => MV.backlog(s.db, NANO, { namespaces: ['project/a'] }), code);
  } finally { s.close(); }
}));

test('a ttl_at of 0 is no expiry, as the semantic scan of search reads it', () => withDir((dir, f) => {
  const s = new Store(f, { stamp: true });
  try {
    const a = note(s, 'one', 'when one', emb('v2'));
    s.p('UPDATE memory_entries SET ttl_at = 0 WHERE id = ?').run(a.id);
    assert.deepStrictEqual(MV.selectSearchable(s.db, NANO, { namespaces: ['project/a'] }).rows.map(r => r.id), [a.id]);
  } finally { s.close(); }
}));
