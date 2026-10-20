'use strict';
// retrieval-levers.test.cjs — the ADR 0050 levers: defaults, validation, the profile table and the pending-pin entries.

const { test } = require('node:test');
const assert = require('node:assert');
const ML = require('../../src/core/memory-levers.cjs');
const RP = require('../../src/core/retrieval-profiles.cjs');
const { MODELS } = require('../../src/core/models.cjs');
const { GGUF_MODELS } = require('../../src/core/gguf-models.cjs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const parse = (b) => ML.parseMemoryBlock(b);
const LEVERS = ['profile', 'profile_cpu', 'embedder', 'reranker', 'routing', 'rerank_depth', 'rerank_bound_ms', 'on_heavy_failure', 'on_heavy_behind', 'search_log_cap_mb', 'vram_headroom_gb'];

test('defaults: nano with no reranker everywhere, depth 50, bound 10 s, fallback, wait, 500 MB, 0.75 GB', () => {
  const v = parse(undefined).value;
  assert.deepStrictEqual(LEVERS.map((k) => v[k]), ['cpu-fast', 'cpu-fast', RP.NANO, 'none', null, 50, 10000, 'fallback', 'wait', 500, 0.75]);
  assert.strictEqual(RP.NANO, 'onnx-community/voyage-4-nano-ONNX');
  assert.ok(ML.isDefault(v), 'a default block is default');
  assert.ok(ML.isDefault(parse({ routing: null }).value));
  assert.ok(!ML.isDefault(parse({ routing: { reviewer: 'gpu-rerank' } }).value), 'a routing map is a change');
  for (const k of LEVERS) assert.ok(ML.TYPES[k], `${k} has a type`);
});

test('the profile table: seven profiles, every model is in a table, devices follow the model', () => {
  assert.deepStrictEqual(RP.PROFILE_NAMES, ['cpu-fast', 'cpu-rerank-light', 'cpu-rerank', 'gpu-rerank-fast', 'gpu-rerank', 'gpu-balanced', 'gpu-recall-max']);
  for (const [name, p] of Object.entries(RP.PROFILES)) {
    assert.strictEqual(RP.describeModel(p.embedder).kind, 'embedder', name);
    if (p.reranker) assert.strictEqual(RP.describeModel(p.reranker).kind, 'reranker', name);
    assert.strictEqual(RP.needsGpu(p), name.startsWith('gpu-'), name);
  }
  assert.ok(MODELS[RP.NANO] && GGUF_MODELS[RP.PROFILES['gpu-balanced'].embedder]);
  assert.strictEqual(RP.profileModels('gpu-recall-max').embedder, 'Qwen/Qwen3-Embedding-8B-GGUF');
  assert.throws(() => RP.profileModels('nope'), { code: 'E_ARGS' });
});

test('the CPU rerankers are listed, flagged pending_pin, carry no invented hashes, and stay out of the embedder table', () => {
  for (const e of Object.values(RP.ONNX_RERANKERS)) {
    assert.strictEqual(e.pending_pin, true);
    assert.ok(!('sha' in e) && !('files' in e), e.id);
    assert.throws(() => RP.assertUsable(e.id), (x) => x.code === 'E_MODEL' && x.detail.reason === 'pending_pin');
    assert.ok(!MODELS[e.id], 'not iterated as an embedder');
  }
  assert.doesNotThrow(() => RP.assertUsable(RP.NANO));
});

test('validation: each lever refuses a bad value and names the key', () => {
  const bad = [
    [{ profile: 'gpu-huge' }, /memory\.profile must be one of/],
    [{ profile_cpu: 'gpu-rerank' }, /memory\.profile_cpu gpu-rerank needs a GPU/],
    [{ profile_cpu: 'custom', embedder: 'Qwen/Qwen3-Embedding-4B-GGUF' }, /profile_cpu custom needs a CPU-only/],
    [{ embedder: 'Qwen/Qwen3-Reranker-4B' }, /memory\.embedder/],
    [{ embedder: 'giladgd/Qwen3-Reranker-4B-GGUF' }, /memory\.embedder/],
    [{ reranker: RP.NANO }, /memory\.reranker/],
    [{ rerank_depth: 0 }, /memory\.rerank_depth must be an integer from 1 to 200/],
    [{ rerank_depth: 201 }, /memory\.rerank_depth/],
    [{ rerank_depth: 1.5 }, /memory\.rerank_depth/],
    [{ rerank_bound_ms: 0 }, /memory\.rerank_bound_ms/],
    [{ on_heavy_failure: 'ignore' }, /memory\.on_heavy_failure must be one of fallback, pause/],
    [{ on_heavy_behind: 'pause' }, /memory\.on_heavy_behind must be one of wait, fallback/],
    [{ search_log_cap_mb: 0 }, /memory\.search_log_cap_mb/],
    [{ vram_headroom_gb: -1 }, /memory\.vram_headroom_gb/],
    [{ vram_headroom_gb: '1' }, /memory\.vram_headroom_gb/],
    [{ profile: 'toString' }, /memory.profile must be one of/],
    [{ profile_cpu: 'constructor' }, /memory.profile_cpu must be one of/],
    [{ routing: { reviewer: 'toString' } }, /memory.routing.reviewer must be one of/],
    [{ routing: { reviewer: 'constructor' } }, /memory.routing.reviewer must be one of/],
    [{ routing: { reviewer: '__proto__' } }, /memory.routing.reviewer must be one of/],
    [{ routing: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`t${i}`, 'cpu-fast'])) }, /more than 64 entries/],
    [{ routing: { reviewer: 'cpu-rerank' } }, /not yet available in this build/],
    [{ routing: { reviewer: { embedder: RP.NANO, reranker: 'jinaai/jina-reranker-v1-tiny-en' } } }, /not yet available in this build/],
    [{ profile: 'cpu-rerank-light' }, /not yet available in this build/],
    [{ profile_cpu: 'cpu-rerank' }, /not yet available in this build/],
    [{ reranker: 'Alibaba-NLP/gte-reranker-modernbert-base' }, /not yet available in this build/],
    [{ routing: [] }, /memory\.routing must be null or an object/],
    [{ routing: { Reviewer: 'cpu-fast' } }, /memory\.routing\.Reviewer/],
    [{ routing: { reviewer: 'custom' } }, /memory\.routing\.reviewer must be one of/],
    [{ routing: { reviewer: 'bogus' } }, /memory\.routing\.reviewer must be one of/],
    [{ routing: { reviewer: { embedder: RP.NANO, extra: 1 } } }, /extra is not a field/],
    [{ routing: { reviewer: { embedder: 'nope' } } }, /memory\.routing\.reviewer: "nope" is not an embedder/],
    [{ routing: { reviewer: { embedder: RP.NANO, reranker: 'nope' } } }, /memory\.routing\.reviewer: "nope" is not a reranker/],
  ];
  for (const [block, re] of bad) assert.match(parse(block).error || '', re, JSON.stringify(block));
});

test('validation: good values are accepted, including custom pairs, advanced agent types and the pending reranker (the resolver refuses it)', () => {
  const ok = parse({
    profile: 'custom', embedder: 'Qwen/Qwen3-Embedding-8B-GGUF', reranker: 'ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF',
    routing: { orchestrator: 'gpu-balanced', coder: { embedder: RP.NANO }, researcher: { embedder: RP.NANO, reranker: 'none' }, 'note-review': 'cpu-fast' },
    rerank_depth: 200, rerank_bound_ms: 600000, on_heavy_failure: 'pause', on_heavy_behind: 'fallback', search_log_cap_mb: 1, vram_headroom_gb: 0,
  });
  assert.strictEqual(ok.error, undefined);
  assert.strictEqual(parse({ routing: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`t${i}`, 'cpu-fast'])) }).error, undefined, '64 entries is the cap');
});

test('a pending model is refused with the coded error E_MODEL, by the lever parse (so settings and the run spec refuse it)', () => {
  for (const block of [{ reranker: 'jinaai/jina-reranker-v1-tiny-en' }, { profile: 'cpu-rerank' }, { routing: { coder: 'cpu-rerank-light' } }]) {
    const r = parse(block);
    assert.strictEqual(r.code, 'E_MODEL', JSON.stringify(block));
    assert.match(r.error, /not yet available in this build/);
  }
});

test('the GPU kinds copied into retrieval-profiles.cjs match the GGUF table exactly', () => {
  assert.deepStrictEqual(Object.fromEntries(Object.values(GGUF_MODELS).map((e) => [e.id, e.kind])), RP.GGUF_KINDS);
});

test('parsing a default block and resolving a CPU routing load no GPU module', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'retrieval-import-child.cjs')], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), { ok: true, loaded: [] });
});
