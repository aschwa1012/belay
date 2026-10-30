'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs)
// retrieval-levers.test.cjs — the ADR 0050 levers: defaults, validation, the profile table and the pending-pin entries.

const { test } = require('node:test');
const assert = require('node:assert');
const ML = require('../../src/core/memory-levers.cjs');
const RP = require('../../src/core/retrieval-profiles.cjs');
const { MODELS } = require('../../src/core/models.cjs');
const { GGUF_MODELS } = require('../../src/core/gguf-models.cjs');
const { ONNX_RERANKER_TABLE } = require('../../src/core/onnx-rerankers.cjs');
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

// The pending mechanism is kept for a model named before it is pinned. No shipped entry is pending, so a test marks a
// pinned one for the length of a call and restores it.
const withPending = (id, fn) => { const e = RP.ONNX_RERANKERS[id]; e.pending_pin = true; try { return fn(); } finally { e.pending_pin = false; } };

test('the CPU rerankers are listed with a pin in onnx-rerankers.cjs, usable, and stay out of the embedder table', () => {
  assert.deepStrictEqual(Object.keys(RP.ONNX_RERANKERS).sort(), Object.keys(ONNX_RERANKER_TABLE).sort());
  for (const e of Object.values(RP.ONNX_RERANKERS)) {
    assert.strictEqual(e.pending_pin, false);
    assert.strictEqual(e.pin, 'onnx-rerankers.cjs');
    assert.doesNotThrow(() => RP.assertUsable(e.id));
    assert.ok(!MODELS[e.id], 'not iterated as an embedder');
    assert.strictEqual(RP.describeModel(e.id).pending_pin, false);
  }
  assert.doesNotThrow(() => RP.assertUsable(RP.NANO));
});

test('the pending mechanism still refuses a model marked pending_pin, with E_MODEL and the reason', () => {
  for (const e of Object.values(RP.ONNX_RERANKERS)) {
    withPending(e.id, () => assert.throws(() => RP.assertUsable(e.id), (x) => x.code === 'E_MODEL' && x.detail.reason === 'pending_pin'));
    assert.doesNotThrow(() => RP.assertUsable(e.id), 'restored');
  }
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

test('validation: good values are accepted, including custom pairs, advanced agent types and a CPU reranker', () => {
  const ok = parse({
    profile: 'custom', embedder: 'Qwen/Qwen3-Embedding-8B-GGUF', reranker: 'ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF',
    routing: { orchestrator: 'gpu-balanced', coder: { embedder: RP.NANO }, researcher: { embedder: RP.NANO, reranker: 'none' }, 'scrubber': 'cpu-fast' },
    rerank_depth: 200, rerank_bound_ms: 600000, on_heavy_failure: 'pause', on_heavy_behind: 'fallback', search_log_cap_mb: 1, vram_headroom_gb: 0,
  });
  assert.strictEqual(ok.error, undefined);
  assert.strictEqual(parse({ routing: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`t${i}`, 'cpu-fast'])) }).error, undefined, '64 entries is the cap');
});

test('a pinned CPU reranker is accepted by the lever parse; a model marked pending is refused with E_MODEL (so settings and the run spec refuse it)', () => {
  const blocks = [{ reranker: 'jinaai/jina-reranker-v1-tiny-en' }, { reranker: 'Alibaba-NLP/gte-reranker-modernbert-base' }, { profile: 'cpu-rerank' }, { profile: 'cpu-rerank-light' }, { profile_cpu: 'cpu-rerank' }, { routing: { coder: 'cpu-rerank-light' } }, { routing: { reviewer: 'cpu-rerank' } }, { routing: { reviewer: { embedder: RP.NANO, reranker: 'jinaai/jina-reranker-v1-tiny-en' } } }];
  for (const block of blocks) assert.strictEqual(parse(block).error, undefined, JSON.stringify(block));
  withPending('jinaai/jina-reranker-v1-tiny-en', () => withPending('Alibaba-NLP/gte-reranker-modernbert-base', () => {
    for (const block of blocks) {
      const r = parse(block);
      assert.strictEqual(r.code, 'E_MODEL', JSON.stringify(block));
      assert.match(r.error, /not yet available in this build/);
    }
  }));
});

test('the GPU kinds copied into retrieval-profiles.cjs match the GGUF table exactly', () => {
  assert.deepStrictEqual(Object.fromEntries(Object.entries(GGUF_MODELS).map(([key, e]) => { assert.strictEqual(key, e.id, 'the table key is the id'); return [key, e.kind]; })), RP.GGUF_KINDS);
});

test('parsing a default block and resolving a CPU routing load no GPU module', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'retrieval-import-child.cjs')], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), { ok: true, loaded: [] });
});

test('routing_cpu: null by default, a map of CPU-only profiles, and a GPU profile, an unknown one or a bad type is refused', () => {
  assert.strictEqual(parse(undefined).value.routing_cpu, null);
  assert.ok(ML.TYPES.routing_cpu && ML.TYPES.routing_cpu.type === 'json');
  assert.ok(!ML.isDefault(parse({ routing_cpu: { reviewer: 'cpu-rerank' } }).value));
  assert.deepStrictEqual(parse({ routing_cpu: { reviewer: 'cpu-rerank', coder: 'cpu-fast' } }).value.routing_cpu, { reviewer: 'cpu-rerank', coder: 'cpu-fast' });
  for (const [b, re] of [[{ routing_cpu: { reviewer: 'gpu-rerank' } }, /needs a GPU/], [{ routing_cpu: { reviewer: 'bogus' } }, /must be one of/], [{ routing_cpu: { reviewer: 'custom' } }, /must be one of/], [{ routing_cpu: { Reviewer: 'cpu-fast' } }, /agent type is lower-case/], [{ routing_cpu: [] }, /must be null or an object/]]) {
    assert.match(parse(b).error || '', re, JSON.stringify(b));
  }
});
