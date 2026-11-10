'use strict';
// gpu-probe-measure.test.cjs — how the probe measures (ADR 0049 decision 6 and 7): when it reads free memory, that
// a peak is a sampled maximum, how a rerank is cut, and the REAL gpu-worker.cjs driven through a stub runtime.
// A fake child and a fake table; no GPU, no runtime, no npm.

process.env.BELAY_TEST_MODE = '1';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, FIXTURES } = require('./helpers.cjs');
const { writeStubRuntime, writeCache } = require('./fixtures/gpu-stub-runtime.cjs');

const P = core('gpu-probe.cjs');
const C = core('gpu-chunk.cjs');
const { GpuClient } = core('gpu.cjs');
const G = core('gguf-models.cjs');
const REF = require('./fixtures/qwen3-query-ref.json');
const FAKE = path.join(FIXTURES, 'gpu-worker-fake.cjs');
const MIB = 1048576;
const SHA = 'a'.repeat(40), H = 'b'.repeat(64);
const entry = (id, kind, extra) => ({ id, sha: SHA, runtime: 'gguf', kind, label: id, files: [{ path: 'm.gguf', bytes: 10, sha256: H }], pooling: kind === 'embedder' ? 'last' : null, query_prompt: '', document_prompt: '', native_dims: kind === 'embedder' ? 8 : null, dims: kind === 'embedder' ? 8 : null, license: 'apache-2.0', context_size: 1024, vram_mb_ref: 500, ...extra });
const TABLE = { 'org/emb': entry('org/emb', 'embedder'), 'org/rr': entry('org/rr', 'reranker', { context_size: 2048 }) };
const row = (over) => ({ name: 'NVIDIA GeForce RTX 5060 Laptop GPU', driver: '617.42', total_mb: 8151, used_mb: 0, free_mb: 7899, ...over });

function rig(fake = {}) {
  const cache = sandbox();
  writeCache(cache, TABLE);
  return { cache, base: (o = {}) => ({ cacheDir: cache, table: TABLE, runtimeDir: 'unused', record: false, smi: async () => row(), clientOpts: { workerPath: FAKE, workerOpts: { fake } }, ...o }) };
}

test('free memory is read AFTER the child is up, so the child\'s own overhead is not counted as room', async () => {
  const { cache, base } = rig({ per_model: { 'org/emb': 700 * MIB } });
  const marker = path.join(cache, 'vulkan-initialised');
  try {
    // The meter reports 7899 MiB free until the child has initialised Vulkan, and 7400 once it holds its own overhead.
    const smi = async () => row({ free_mb: fs.existsSync(marker) ? 7400 : 7899 });
    const r = await P.probe(base({ models: ['org/emb'], smi, clientOpts: { workerPath: FAKE, workerOpts: { fake: { per_model: { 'org/emb': 700 * MIB }, marker } } } }));
    assert.strictEqual(r.ok, true, JSON.stringify(r.refusal));
    assert.strictEqual(r.free_mb, 7400, 'read before the child started it would be 7899');
    assert.strictEqual(r.dedicated.cross_check.smi_free_mb, 7400);
  } finally { cleanup(cache); }
});

test('a peak is the highest SAMPLED value while the load runs, above the steady level after it', async () => {
  // The fake holds the 900 MiB transient until it has answered 3 vram requests during the load, so the sampler sees it however slowly the runner runs.
  const { cache, base } = rig({ per_model: { 'org/emb': 700 * MIB }, transient_mb: 900 });
  try {
    const r = await P.probe(base({ models: ['org/emb'], smi: false, clientOpts: { workerPath: FAKE, workerOpts: { fake: { per_model: { 'org/emb': 700 * MIB }, transient_mb: 900 } } } }));
    assert.strictEqual(r.ok, true, JSON.stringify(r.refusal));
    const p = r.peaks['org/emb'];
    assert.strictEqual(p.steady_mb, 700, 'what is left after the load');
    assert.strictEqual(p.peak_mb, 1600, 'the transient 900 MiB the sampler caught while the load ran');
    assert.ok(p.samples.vulkan >= 3, `${p.samples.vulkan} samples`);
  } finally { cleanup(cache); }
});

test('the sampler keeps the maximum, drops a call that does not answer, and stops when told', async () => {
  const seq = [5, 9, 7];
  let i = 0, third;
  const thirdCall = new Promise(r => { third = r; }); // a gate on the sampler's 3rd call, not on elapsed time
  const s = P.sampler(async () => { const v = seq[Math.min(i++, seq.length - 1)]; if (i === 3) third(); return v; }, 5);
  await thirdCall;
  const out = await s.stop();
  assert.strictEqual(out.max, 9);
  assert.ok(out.n >= 3);
  let first;
  const firstCall = new Promise(r => { first = r; });
  const none = P.sampler(async () => { first(); throw new Error('meter gone'); }, 5);
  await firstCall;
  assert.deepStrictEqual(await none.stop(), { max: null, n: 0 });
});

test('a reranker whose full batch takes longer than the target is refused, with the measured time', async () => {
  const { cache, base } = rig();
  try {
    const r = await P.probe(base({ models: ['org/rr'], clientOpts: { workerPath: FAKE, workerOpts: { fake: { rank_ms_per_token: 4, virtual_ms: true } } } }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.refusal.reason, 'submission_too_long');
    assert.match(r.refusal.message, /one full batch of \d+ tokens/);
  } finally { cleanup(cache); }
});

test('the chunk size follows document length: long notes make small chunks, short notes make big ones, capped at 50 pairs', () => {
  const costs = (n, tok) => Array.from({ length: n }, () => tok + 10 + C.RANK_TEMPLATE_TOKENS);
  const sizes = (plan) => plan.map(([a, b]) => b - a);
  assert.deepStrictEqual(sizes(C.planChunks(costs(120, 20), { maxPairs: 50, maxTokens: 1e9 })), [50, 50, 20], 'the depth cap');
  assert.deepStrictEqual(sizes(C.planChunks(costs(10, 20), { maxTokens: 500 })), [4, 4, 2], 'short notes: 110 tokens a pair');
  assert.deepStrictEqual(sizes(C.planChunks(costs(10, 400), { maxTokens: 1000 })), [2, 2, 2, 2, 2], 'long notes: 490 tokens a pair');
  assert.deepStrictEqual(sizes(C.planChunks([5000, 10, 10], { maxTokens: 1000 })), [1, 2], 'a pair over the bound goes alone');
  assert.deepStrictEqual(C.planChunks([], {}), []);
  assert.strictEqual(C.docCap(2048, 20), 2048 - 20 - C.RANK_TEMPLATE_TOKENS - 8, 'a document is capped by what the context holds');
});

test('the real GPU worker on a stub runtime: query format pinned by the reference, chunks by tokens, long documents capped', async () => {
  const rt = sandbox(), cache = sandbox();
  try {
    writeStubRuntime(rt);
    const table = { 'org/emb': entry('org/emb', 'embedder', { query_prompt: G.QUERY_INSTRUCTION, dims: 4, native_dims: 4 }), 'org/rr': entry('org/rr', 'reranker', { context_size: 2048 }) };
    writeCache(cache, table);
    const c = new GpuClient({ runtimeDir: rt, cacheDir: cache, table }).start();
    try {
      const v = await c.vram();
      assert.deepStrictEqual([v.gpu, v.devices, v.total, v.used, v.unified], ['vulkan', ['stub'], 100, 10, 0]);
      const li = await c.load('org/emb');
      assert.strictEqual(li.native_dims, 4);
      const rl = await c.load('org/rr', { batchSize: 512 });
      assert.strictEqual(rl.batch_size, 512);
      // N1: the text the worker gives the library is exactly the pinned query format plus the query, nothing appended.
      const q = await c.embed('org/emb', REF.query, { as: 'query' });
      assert.strictEqual(REF.formatted_text, G.QUERY_INSTRUCTION + REF.query, 'the table\'s prompt is the format the reference vector was made with');
      assert.strictEqual(q.tokens, Math.ceil(REF.formatted_text.length / 4), 'the stub tokenizes the formatted text, which has no end token written into it');
      const raw = [REF.formatted_text.length, [...REF.formatted_text].reduce((s, ch) => s + ch.charCodeAt(0), 0) % 997, 1, 1];
      const n = Math.hypot(...raw);
      raw.forEach((x, i) => assert.ok(Math.abs(q.embedding[i] - x / n) < 1e-6, `component ${i}: the library saw exactly the pinned text`));
      const d = await c.embed('org/emb', REF.query, { as: 'document' });
      assert.strictEqual(d.tokens, Math.ceil(REF.query.length / 4), 'a document gets no instruction');
      assert.strictEqual(REF.add_eos_token, true);
      assert.strictEqual(REF.token_count_with_eos, REF.tokens_without_eos + 1, 'the library appends the end token itself');
      assert.strictEqual(REF.dims, REF.vector.length);
      assert.ok(Math.abs(Math.hypot(...REF.vector) - 1) < 1e-4, 'the reference vector is unit length');
      // chunks by tokens: ten notes of ~100 tokens at a 600-token chunk bound go four-at-most
      const notes = Array.from({ length: 10 }, (_, i) => `${'word '.repeat(80)}${i}`);
      const r = await c.rank('org/rr', 'word', notes, { chunkTokens: 600 });
      assert.ok(r.chunks.length > 1 && r.chunks.every(k => k.tokens <= 600 || k.n === 1), JSON.stringify(r.chunks));
      assert.strictEqual(r.chunks.reduce((a, k) => a + k.n, 0), 10);
      assert.deepStrictEqual(r.scores, new Array(10).fill(1), 'scores come back in input order');
      assert.strictEqual(r.pair_tokens.length, 10);
      // a document longer than the context is cut to the cap, and the cut is reported
      const huge = 'z'.repeat(40000);
      const t = await c.rank('org/rr', 'word', ['short note', huge]);
      assert.strictEqual(t.truncated, 1);
      assert.strictEqual(t.pair_tokens[1], C.docCap(2048, Math.ceil('word'.length / 4)) + Math.ceil('word'.length / 4) + C.RANK_TEMPLATE_TOKENS);
      await assert.rejects(c.rank('org/emb', 'q', ['a']), (e) => e.code === 'E_ARGS');
      assert.strictEqual((await c.ping()).ok, true);
    } finally { await c.close(); }
  } finally { cleanup(rt); cleanup(cache); }
});
