'use strict';
// memory-vectors-purge.test.cjs — the operator's archive purge removes rows for good, so it sweeps their vectors in the same
// transaction (ADR 0050 decision 2); the archive move before it kept them. Per-model identity keys in meta are tested here too.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT } = require('./lifecycle-env.cjs');
const { core, sandbox, cleanup } = require('./helpers.cjs');
const ID = core('embed-identity.cjs');
const { Store } = core('store.cjs');

let T;
before(async () => { T = await setup(); });
after(() => T.close());

const vectorsOf = () => Number(T.store.db.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get().n);

test('archiving keeps a note\'s vector and the operator\'s purge sweeps it', async () => {
  const a = T.note('purge vector a', {}), b = T.note('purge vector b', {});
  const start = vectorsOf();
  assert.ok(start >= 2);
  T.store.tx(() => { T.store.moveRow(a, `project/${PROJECT}`, `archive/${PROJECT}`); T.store.moveRow(b, `project/${PROJECT}`, `archive/${PROJECT}`); });
  assert.strictEqual(vectorsOf(), start, 'an archive move keeps the vectors');
  const r = await T.call(T.who.operator('apply'), 'memory.archivePurge', { ids: [a, b], confirm: true });
  assert.strictEqual(r.count, 2);
  assert.strictEqual(vectorsOf(), start - 2, 'the purge swept the two orphans');
});

test('an identity is kept per model key beside the single nano identity', () => {
  const dir = sandbox();
  const s = new Store(`${dir}/memory.db`, { stamp: true });
  try {
    const key = ID.modelIdentityKey('heavy', 'r9', 1024);
    assert.strictEqual(key, 'embedding_identity:heavy@r9:1024');
    assert.strictEqual(ID.getModelIdentity(s.db, key), null);
    const info = { model: 'heavy', sha: 'abc', dtype: 'q8', pooling: 'last', dim: 1024, library: 'lib@1', canary_vector: [1, 0, 0] };
    ID.putModelIdentity(s.db, key, info);
    assert.deepStrictEqual(ID.getModelIdentity(s.db, key), info);
    assert.strictEqual(s.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'embedding_model'").get().n, 0, 'the single-identity keys are untouched');
    ID.checkModelIdentity({ id: 'heavy', sha: 'abc', dims: 1024 }, ID.getModelIdentity(s.db, key));
    assert.throws(() => ID.checkModelIdentity({ id: 'heavy', sha: 'zzz', dims: 1024 }, info), x => x.code === 'E_MODEL_CHANGED');
    ID.checkModelCanary([1, 0, 0], info, 'lib@1');
    assert.throws(() => ID.checkModelCanary([0, 1, 0], info, 'lib@1'), x => x.code === 'E_MODEL_CHANGED');
  } finally { s.close(); cleanup(dir); }
});
