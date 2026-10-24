'use strict';
// dedup-cache-vector.test.cjs — a dedup update that carries no vector (memory.store { embed: false }, or a keyword-mode write)
// keeps the row's stored embedding (COALESCE in storeIn), and the owner's vector cache keeps it too (audit 0.3.1 C2). Before
// the fix the cache entry was replaced with vec: null, so semantic search in that owner skipped the row until the cache dropped.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { core, sandbox, cleanup } = require('../core/helpers.cjs');
const { Store } = core('store.cjs');

const vec = (i) => { const v = new Array(8).fill(0.01); v[i] = 1; return v; };

test('a vectorless dedup update keeps the row findable by semantic search in the same store', () => {
  const dir = sandbox();
  const db = path.join(dir, 'memory.db');
  const s = new Store(db, { stamp: true });
  try {
    const base = { namespace: 'run/r1', worker_id: 'w1', text: 'the build needs node 22', embedding_model: 'm', dim: 8 };
    const first = s.store({ ...base, embedding: vec(0) });
    assert.strictEqual(first.action, 'inserted');
    const hit = (st) => st.search({ namespace: 'run/r1', query_embedding: vec(0), k: 5 }).results.map(r => r.id);
    assert.deepStrictEqual(hit(s), [first.id], 'found before the update');
    const again = s.store({ namespace: 'run/r1', worker_id: 'w1', text: 'the build needs node 22', tags: ['x'] }); // same writer, no vector
    assert.strictEqual(again.action, 'updated');
    assert.strictEqual(again.has_embedding, true, 'the stored row keeps its vector');
    const sameOwner = hit(s);
    const fresh = new Store(db, {});
    const reloaded = hit(fresh);
    fresh.close();
    console.log(JSON.stringify({ same_owner_after_update: sameOwner, fresh_connection: reloaded }));
    assert.deepStrictEqual(sameOwner, reloaded, 'the owner answers what its own table holds');
  } finally { s.close(); cleanup(dir); }
});

test('a dedup update that carries a new vector puts that vector in the cache', () => {
  const dir = sandbox();
  const db = path.join(dir, 'memory.db');
  const s = new Store(db, { stamp: true });
  try {
    const base = { namespace: 'run/r1', worker_id: 'w1', text: 'the build needs node 22', embedding_model: 'm', dim: 8 };
    const first = s.store({ ...base, embedding: vec(0) });
    s.search({ namespace: 'run/r1', query_embedding: vec(0), k: 5 }); // loads the cache
    assert.strictEqual(s.store({ ...base, embedding: vec(3) }).action, 'updated');
    const top = s.search({ namespace: 'run/r1', query_embedding: vec(3), k: 5 }).results[0];
    assert.strictEqual(top.id, first.id);
    assert.ok(top.score > 0.9, 'scored against the new vector: ' + top.score);
  } finally { s.close(); cleanup(dir); }
});
