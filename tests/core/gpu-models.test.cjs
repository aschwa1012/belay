'use strict';
// gpu-models.test.cjs — the GGUF model table (ADR 0049 decision 5): sound entries, kept apart from the embedder table.

const { test } = require('node:test');
const assert = require('node:assert');
const { core } = require('./helpers.cjs');

const G = core('gguf-models.cjs');
const M = core('models.cjs');

test('every GPU entry is valid under models.cjs checks and the GPU table checks', () => {
  assert.strictEqual(Object.keys(G.GGUF_MODELS).length, 5);
  for (const [id, e] of Object.entries(G.GGUF_MODELS)) {
    assert.strictEqual(e.id, id);
    assert.deepStrictEqual(M.entryProblems(e), [], id);
    assert.deepStrictEqual(G.ggufProblems(e), [], id);
    assert.strictEqual(e.runtime, 'gguf');
    assert.strictEqual(e.files.length, 1);
    assert.match(e.files[0].path, /\.gguf$/);
    assert.ok(e.vram_mb_ref > 500 && e.vram_mb_ref < 8000, `${id} vram hint`);
    assert.strictEqual(e.license, 'apache-2.0');
  }
});

test('the GPU table is not the embedder table: MODELS holds none of them', () => {
  for (const id of Object.keys(G.GGUF_MODELS)) assert.ok(!(id in M.MODELS), id);
  for (const e of Object.values(M.MODELS)) assert.strictEqual(e.runtime, undefined, 'models.cjs entries are unchanged');
});

test('the embedders carry dims, last-token pooling and a query instruction; the rerankers score through the ranking head', () => {
  const emb = Object.values(G.GGUF_MODELS).filter(e => e.kind === 'embedder');
  assert.deepStrictEqual(emb.map(e => e.dims), [1024, 2560, 4096]);
  for (const e of emb) { assert.strictEqual(e.pooling, 'last'); assert.match(e.query_prompt, /^Instruct: .*\nQuery: $/); assert.strictEqual(e.document_prompt, ''); }
  const rr = Object.values(G.GGUF_MODELS).filter(e => e.kind === 'reranker');
  assert.deepStrictEqual(rr.map(e => e.id), ['ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF', 'giladgd/Qwen3-Reranker-4B-GGUF']);
  assert.ok(rr.every(e => e.dims === null));
});

test('a damaged GPU entry is refused with every problem named', () => {
  const e = { ...G.GGUF_MODELS['Qwen/Qwen3-Embedding-4B-GGUF'], sha: 'zz', kind: 'both', files: [{ path: '../x.gguf', bytes: 1, sha256: 'ab' }, { path: 'b.gguf', bytes: 1, sha256: 'c'.repeat(64) }], vram_mb_ref: 0 };
  const bad = G.ggufProblems(e);
  assert.ok(bad.length >= 5, bad.join(' | '));
  assert.throws(() => G.validateGguf(e), (x) => x.code === 'E_ARGS');
  assert.throws(() => G.ggufFor('Qwen/nope'), (x) => x.code === 'E_ARGS' && /known ids/.test(x.message));
});
