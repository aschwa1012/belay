'use strict';
// embedder.test.cjs — owner-side embedding (ADR 0003 §3 as amended by ADR 0027). The embedder loads a
// pinned model from belay's cache; the store's meta records the whole identity and the canary is
// compared by cosine; over-length text (prompt included) is refused rather than truncated.
//
// The model tests need the fetched model (`belay embedder fetch`) and the installed package. Where they
// are absent each such test skips with the reason, because a machine without the model is a fact about
// the machine, not a failure of the core.

const nodeTest = require('node:test').test;
const test = (name, fn) => nodeTest(name, { timeout: 240000 }, fn); // model loads under a parallel phase can outrun 60 s
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor, optInModel } = require('./helpers.cjs');
optInModel();

const { openCore } = core('index.cjs');
const { Embedder } = core('embedder.cjs');
const { Store } = core('store.cjs');
const M = core('models.cjs');
const K = core('model-cache.cjs');
const I = core('embed-identity.cjs');

const VOYAGE = M.MODELS[M.DEFAULT_MODEL];
const MINILM = M.MODELS['Xenova/all-MiniLM-L6-v2'];

function absence(entry) {
  if (!K.packageDir()) return 'the transformers package is not installed (run npm install)';
  const c = K.checkPresent(entry);
  return c.present ? null : `the model ${entry.id} is not in the cache at ${c.dir} (run belay embedder fetch --model ${entry.id})`;
}
const noVoyage = absence(VOYAGE);
const noMiniLM = absence(MINILM);

const storeMeta = (dir, rows) => {
  const s = new Store(path.join(dir, 'memory.db'));
  const put = s.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)');
  for (const [k, v] of rows) put.run(k, v);
  s.close();
};
const metaOf = c => Object.fromEntries(c.owner.store.db.prepare('SELECT key, value FROM meta').all().map(r => [r.key, r.value]));
// An Embedder that is closed when its test ends, however the test ends: a loaded one holds a child process.
const mk = (t, ...args) => { const e = new Embedder(...args); t.after(() => Promise.resolve().then(() => e.close()).catch(() => {})); return e; };

test('embedder: voyage-4-nano loads at 1024 dims and the canary is unit length', async t => {
  if (noVoyage) return t.skip(noVoyage);
  const e = mk(t);
  const info = await e.load(null);
  assert.strictEqual(info.model, VOYAGE.id);
  assert.strictEqual(info.sha, VOYAGE.sha);
  assert.strictEqual(info.dim, 1024);
  assert.strictEqual(info.canary_vector.length, 1024);
  const norm = Math.sqrt(info.canary_vector.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-4, `the canary has norm ${norm}`);
  assert.match(info.library, /^\d+\.\d+\.\d+/);
  assert.ok(info.load_ms > 0);
  assert.strictEqual(info.canary_sha256.length, 64);
  const again = await mk(t).load({ embedding_model: info.model, embedding_sha: info.sha, embedding_dim: '1024', embedding_library: info.library, canary_vector: JSON.stringify(info.canary_vector) });
  assert.strictEqual(again.adopted_canary, false);
  assert.strictEqual(again.library_changed, null, 'the same library twice is not a change');
  const moved = await mk(t).load({ embedding_model: info.model, embedding_library: '0.0.1', canary_vector: JSON.stringify(info.canary_vector) });
  assert.deepStrictEqual(moved.library_changed, { from: '0.0.1', to: info.library }, 'a library change on a passing cosine is reported, not refused');
});

test('embedder: a query and a document embed differently (the prompts are applied)', async t => {
  if (noVoyage) return t.skip(noVoyage);
  const e = mk(t);
  await e.load(null);
  const text = 'which process opens the sqlite file?';
  const d = await e.embed(text);
  const d2 = await e.embed(text, { as: 'document' });
  const q = await e.embed(text, { as: 'query' });
  assert.strictEqual(q.dim, 1024);
  assert.ok(I.cosine(d.embedding, d2.embedding) > 0.99999, 'document is the default and deterministic');
  const c = I.cosine(d.embedding, q.embedding);
  assert.ok(c < 0.9999, `the query and document vectors of one text must differ, cosine ${c}`);
  assert.ok(q.tokens > (await e.embed(text, { as: 'document' })).tokens - 20 && q.tokens !== d.tokens, 'the two prompts have different lengths');
  await assert.rejects(e.embed(text, { as: 'passage' }), x => x.code === 'E_ARGS');
});

test('embedder: the owner finds a stored row by a text query', async t => {
  if (noVoyage) return t.skip(noVoyage);
  const dir = sandbox();
  let c = null;
  try {
    c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: true });
    const a = await c.memory.store({ namespace: 'sem', text: 'The store owner holds the only connection to the database file.' });
    await c.memory.store({ namespace: 'sem', text: 'Bananas ripen faster in a paper bag.' });
    assert.strictEqual(a.action, 'inserted');

    const s = await c.memory.search({ namespace: 'sem', query: 'which process opens the sqlite file?', k: 2, mode: 'semantic' });
    assert.strictEqual(s.model, VOYAGE.id);
    assert.strictEqual(s.dim, 1024);
    assert.strictEqual(s.results[0].id, a.id, 'the nearer row by meaning comes first');
    assert.ok(s.results[0].score > s.results[1].score);

    // ADR 0027 decision 5: the whole identity is recorded once, on the first load.
    const meta = metaOf(c);
    assert.strictEqual(meta.embedding_model, VOYAGE.id);
    assert.strictEqual(meta.embedding_sha, VOYAGE.sha);
    assert.strictEqual(meta.embedding_dtype, 'q4');
    assert.strictEqual(meta.embedding_pooling, 'mean');
    assert.strictEqual(meta.embedding_dim, '1024');
    assert.match(meta.embedding_library, /^\d+\.\d+\.\d+/);
    assert.strictEqual(JSON.parse(meta.canary_vector).length, 1024);
    assert.strictEqual(meta.canary_sha256.length, 64, 'the legacy hash is still written for older readers');
    const info = (await c.memory.stats({})).owner.embedder;
    assert.strictEqual(info.dim, 1024);
    assert.strictEqual(info.canary_vector, undefined, 'stats does not carry the 1024-float canary');
  } finally {
    if (c) { await c.shutdownOwner().catch(() => {}); await c.close().catch(() => {}); } // each step on its own; never masks the body's failure
    cleanup(dir);
  }
});

test('embedder: a canary vector with cosine below 0.9999 is E_MODEL_CHANGED naming the cosine', async t => {
  if (noVoyage) return t.skip(noVoyage);
  // A synthetic recorded canary: a unit vector no real embedding is near, so the cosine is far below the bound.
  const rotated = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 12.9898) / Math.sqrt(512));
  const stored = { embedding_model: VOYAGE.id, embedding_sha: VOYAGE.sha, embedding_dim: '1024', canary_vector: JSON.stringify(rotated) };
  await assert.rejects(mk(t).load(stored), x => {
    assert.strictEqual(x.code, 'E_MODEL_CHANGED');
    assert.match(x.message, /cosine -?\d\.\d+/);
    assert.ok(x.detail.cosine < 0.9999);
    return true;
  });

  // Through the owner: the orchestration tables still work, only vector calls are refused, stickily.
  const dir = sandbox();
  let c = null;
  try {
    storeMeta(dir, Object.entries({ ...stored, canary_sha256: '0'.repeat(64) }));
    c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: true });
    await c.run.attach({ adapter_pid: process.pid });
    const task = await c.task.create({ spec: 'a wrong canary must not stop the harness recording work' });
    assert.strictEqual(task.state, 'open');
    for (const call of [() => c.memory.store({ text: 'unembeddable' }), () => c.memory.search({ query: 'anything', mode: 'semantic' })]) {
      await assert.rejects(call(), e => {
        assert.strictEqual(e.code, 'E_MODEL_CHANGED');
        assert.ok(e.message.includes('model, dtype or dimension changed'));
        return true;
      });
    }
    await assert.rejects(c.memory.store({ text: 'again' }), e => e.code === 'E_MODEL_CHANGED');
    const row = await c.memory.store({ text: 'caller supplied', embedding: [1, 0], embedding_model: 'm', dim: 2 });
    assert.strictEqual(row.action, 'inserted', 'a caller-supplied vector needs no model');
    assert.strictEqual((await c.memory.stats({})).owner.embedder_error.code, 'E_MODEL_CHANGED', 'stats says why the store cannot embed');
  } finally {
    if (c) { await c.shutdownOwner().catch(() => {}); await c.close().catch(() => {}); } // each step on its own; never masks the body's failure
    cleanup(dir);
  }
});

test('embedder: a store recorded with another model id is E_MODEL_CHANGED without embedding', async t => {
  // This one needs no model at all: the identity is refused before the package or the cache is touched.
  const e = mk(t, { model: M.DEFAULT_MODEL, cacheDir: path.join(os.tmpdir(), 'belay-no-such-cache') });
  await assert.rejects(e.load({ embedding_model: MINILM.id, embedding_dim: '384' }), x => {
    assert.strictEqual(x.code, 'E_MODEL_CHANGED');
    assert.ok(x.message.includes(MINILM.id) && x.message.includes(VOYAGE.id));
    return true;
  });
  assert.strictEqual(e.pipe, null, 'nothing was loaded, let alone embedded');
  await assert.rejects(mk(t).load({ embedding_model: VOYAGE.id, embedding_sha: 'a'.repeat(40) }), x => x.code === 'E_MODEL_CHANGED');
  await assert.rejects(mk(t).load({ embedding_model: VOYAGE.id, embedding_dim: '384' }), x => x.code === 'E_MODEL_CHANGED');
  // A store whose model this belay does not know is refused at the owner, with the same code.
  const dir = sandbox();
  let c = null;
  try {
    storeMeta(dir, [['embedding_model', 'someone/else-model'], ['embedding_dim', '768'], ['canary_sha256', '0'.repeat(64)]]);
    c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: true });
    await assert.rejects(c.memory.store({ text: 'x' }), x => x.code === 'E_MODEL_CHANGED' && x.message.includes('someone/else-model'));
  } finally {
    if (c) { await c.shutdownOwner().catch(() => {}); await c.close().catch(() => {}); } // each step on its own; never masks the body's failure
    cleanup(dir);
  }
});

test('embedder: an older MiniLM store with only canary_sha256 adopts the canary vector', async t => {
  if (noMiniLM) return t.skip(noMiniLM);
  const dir = sandbox();
  let c = null;
  try {
    storeMeta(dir, [['canary_sha256', '0b'.repeat(32)], ['embedding_model', MINILM.id], ['embedding_dim', '384']]);
    c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: true });
    // The store's own model wins over the default: no embedOpts here, and it still embeds with MiniLM.
    const a = await c.memory.store({ namespace: 'old', text: 'The store owner holds the only connection to the database file.' });
    const s = await c.memory.search({ namespace: 'old', query: 'which process opens the sqlite file?', k: 1 });
    assert.strictEqual(s.model, MINILM.id);
    assert.strictEqual(s.dim, 384);
    assert.strictEqual(s.results[0].id, a.id);
    const meta = metaOf(c);
    assert.strictEqual(JSON.parse(meta.canary_vector).length, 384, 'the current canary vector was adopted into meta');
    assert.strictEqual(meta.embedding_sha, MINILM.sha, 'the legacy shape adopts the full identity, in one transaction (review 1, M2)');
    assert.strictEqual(meta.embedding_library.length > 0, true);
  } finally {
    if (c) { await c.shutdownOwner().catch(() => {}); await c.close().catch(() => {}); } // each step on its own; never masks the body's failure
    cleanup(dir);
  }
  // The same store opened with a different model is refused.
  await assert.rejects(mk(t, { model: M.DEFAULT_MODEL }).load({ canary_sha256: '0'.repeat(64), embedding_model: MINILM.id, embedding_dim: '384' }), x => x.code === 'E_MODEL_CHANGED');
  const info = await mk(t, { model: MINILM.id }).load({ canary_sha256: '0'.repeat(64), embedding_model: MINILM.id, embedding_dim: '384' });
  assert.strictEqual(info.adopted_canary, true);
});

test('embedder: text past max_tokens, prompt included, is E_TOO_LONG', async t => {
  if (noVoyage) return t.skip(noVoyage);
  const e = mk(t);
  await e.load(null);
  await assert.rejects(e.embed('word '.repeat(9000)), x => {
    assert.strictEqual(x.code, 'E_TOO_LONG');
    assert.ok(x.detail.tokens > x.detail.max);
    assert.strictEqual(x.detail.max, 8192);
    return true;
  });
  // The prompt counts: a text of exactly the window's size without it is over the window with it.
  const special = (await e.tokenCount('word '.repeat(1000))) - 1000;
  const exact = 'word '.repeat(8192 - special);
  assert.strictEqual(await e.tokenCount(exact), 8192, 'this text fills the window exactly without a prompt');
  await assert.rejects(e.embed(exact), x => x.code === 'E_TOO_LONG' && x.detail.tokens > 8192);
  const ok = await e.embed('word '.repeat(200));
  assert.ok(ok.tokens < 8192);
});

test('an absent package is E_MODEL_ABSENT, naming the path it looked in', async () => {
  const e = new Embedder({ pkg: 'C:/definitely/not/a/transformers/package' });
  await assert.rejects(e.load(null), err => {
    assert.strictEqual(err.code, 'E_MODEL_ABSENT');
    assert.ok(err.message.includes('C:/definitely/not/a/transformers/package'));
    return true;
  });
});

test('an absent model is E_MODEL_ABSENT, naming the fetch verb and the missing paths', async t => {
  if (!K.packageDir()) return t.skip('the transformers package is not installed');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-empty-cache-')).split('\\').join('/');
  try {
    const e = mk(t, { cacheDir: empty });
    await assert.rejects(e.load(null), err => {
      assert.strictEqual(err.code, 'E_MODEL_ABSENT');
      assert.ok(err.message.includes(`belay embedder fetch --model ${VOYAGE.id}`));
      assert.ok(err.message.includes('onnx/model_q4.onnx_data') && err.message.includes('manifest.json'));
      assert.ok(err.detail.missing.length === VOYAGE.files.length + 1);
      return true;
    });
  } finally { cleanup(empty); }
});

test('an absent model or package fails the calls that need a vector, and only those', async () => {
  // api.md §3 names an embedder on memory.store and memory.search alone, so nothing else may fail
  // because a model file is missing. Regression for review-core round 1 item 3.
  const dir = sandbox();
  let c = null;
  try {
    c = await openCore({
      dataDir: dir, caller: callerFor('orchestrator'), embed: true,
      ownerOpts: { embedOpts: { pkg: 'C:/definitely/not/a/transformers/package' } },
    });
    await c.run.attach({ adapter_pid: process.pid });
    await c.worker.write({ id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running' });
    const task = await c.task.create({ spec: 'no model on this machine', files_owned: ['x'] });
    await c.task.assign({ task_id: task.id, worker_id: 'w1' });
    await c.continuity.checkpoint({ task_id: task.id, worker_id: 'w1', turn: 1 });
    assert.ok((await c.continuity.resumeLine({ task_id: task.id })).bytes <= 400);
    assert.ok(['alive', 'degraded', 'stopped'].includes((await c.status.get({})).verdict));

    await assert.rejects(c.memory.store({ text: 'unembeddable' }), e => {
      assert.strictEqual(e.code, 'E_MODEL_ABSENT');
      assert.ok(e.message.includes('C:/definitely/not/a/transformers/package'), 'the refusal names the path it looked in');
      return true;
    });
    await assert.rejects(c.memory.search({ query: 'anything', mode: 'semantic' }), e => e.code === 'E_MODEL_ABSENT');
    const row = await c.memory.store({ text: 'caller supplied', embedding: [1, 0], embedding_model: 'm', dim: 2 });
    assert.strictEqual(row.action, 'inserted');
  } finally {
    if (c) { await c.shutdownOwner().catch(() => {}); await c.close().catch(() => {}); } // each step on its own; never masks the body's failure
    cleanup(dir);
  }
});
