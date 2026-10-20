'use strict';
// retrieval-routing.test.cjs — resolveRouting: layering, every profile, per-role routing, the no-GPU notice once,
// a heavy embedder never on the CPU, the pending-pin refusal and the gpu_models dedupe.

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveRouting, gpuUsable } = require('../../src/core/retrieval-routing.cjs');
const RP = require('../../src/core/retrieval-profiles.cjs');

const TYPES = ['orchestrator', 'reviewer', 'coder', 'tester', 'researcher'];
const run = (o) => resolveRouting({ agentTypes: TYPES, gpu: true, ...o });
const Q = { e4: 'Qwen/Qwen3-Embedding-4B-GGUF', e8: 'Qwen/Qwen3-Embedding-8B-GGUF', r06: 'ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF', r4: 'giladgd/Qwen3-Reranker-4B-GGUF' };

test('defaults: nano with no reranker for every type, no GPU model, no notice, and the result is plain JSON', () => {
  const r = run({ gpu: false });
  for (const t of TYPES) assert.deepStrictEqual(r.tiers[t], { profile: 'cpu-fast', embedder: RP.NANO, reranker: null, device: 'cpu', depth: 0, source: 'run', fallback_from: null }, t);
  assert.deepStrictEqual([r.gpu_models, r.notices], [[], []]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), r);
  assert.deepStrictEqual(Object.keys(r), ['run', 'tiers', 'gpu', 'gpu_models', 'notices', 'levers']);
});

test('every profile resolves with a GPU (CPU rerankers refused as pending), at depth 50', () => {
  for (const [name, p] of Object.entries(RP.PROFILES)) {
    const call = () => run({ settings: { profile: name } });
    if (name === 'cpu-rerank' || name === 'cpu-rerank-light') { assert.throws(call, (e) => e.code === 'E_MODEL' && e.detail.reason === 'pending_pin', name); continue; }
    const r = call();
    assert.deepStrictEqual([r.run.embedder, r.run.reranker, r.run.profile], [p.embedder, p.reranker, name], name);
    assert.strictEqual(r.run.device, name.startsWith('gpu-') ? 'gpu' : 'cpu', name);
    assert.strictEqual(r.run.depth, p.reranker ? 50 : 0, name);
    assert.strictEqual(r.tiers.coder.profile, name, 'an unset type uses the run profile');
  }
});

test('layering: the spec overrides the settings key by key, defaults fill the rest, a bad merged block is refused', () => {
  const r = run({ settings: { profile: 'gpu-rerank', rerank_depth: 80, routing: { reviewer: 'gpu-balanced' } }, spec: { profile: 'gpu-rerank-fast', routing: { coder: 'gpu-rerank' } } });
  assert.strictEqual(r.run.reranker, Q.r06);
  assert.strictEqual(r.run.depth, 80, 'a settings lever the spec leaves alone stands');
  assert.strictEqual(r.tiers.reviewer.profile, 'gpu-rerank-fast', 'the spec routing replaces the settings routing whole');
  assert.strictEqual(r.tiers.coder.profile, 'gpu-rerank');
  assert.strictEqual(r.levers.on_heavy_behind, 'wait');
  assert.throws(() => run({ settings: { rerank_depth: 5 }, spec: { rerank_depth: 500 } }), { code: 'E_ARGS' });
});

test('routing: main and advanced keys, a custom pair, and a routed type outside agentTypes', () => {
  const r = resolveRouting({
    gpu: true, agentTypes: ['orchestrator', 'reviewer', 'coder', 'tester'],
    settings: { routing: { orchestrator: 'gpu-balanced', reviewer: 'gpu-rerank', coder: { embedder: RP.NANO, reranker: Q.r06 }, tester: 'cpu-fast', 'note-review': 'gpu-recall-max' } },
  });
  assert.deepStrictEqual([r.tiers.orchestrator.embedder, r.tiers.orchestrator.reranker], [Q.e4, Q.r4]);
  assert.deepStrictEqual([r.tiers.reviewer.embedder, r.tiers.reviewer.reranker], [RP.NANO, Q.r4]);
  assert.deepStrictEqual([r.tiers.coder.profile, r.tiers.coder.reranker, r.tiers.coder.device], ['custom', Q.r06, 'gpu']);
  assert.strictEqual(r.tiers.tester.device, 'cpu');
  assert.strictEqual(r.tiers['note-review'].embedder, Q.e8, 'an advanced key resolves though no caller listed it');
  assert.strictEqual(r.tiers.reviewer.source, 'routing');
  assert.strictEqual(r.run.source, 'run');
  assert.strictEqual(r.tiers.researcher, undefined, 'only the listed and routed types appear');
});

test('the custom profile uses memory.embedder and memory.reranker', () => {
  const r = run({ settings: { profile: 'custom', embedder: Q.e8, reranker: Q.r4 } });
  assert.deepStrictEqual([r.run.profile, r.run.embedder, r.run.reranker], ['custom', Q.e8, Q.r4]);
  assert.deepStrictEqual(r.gpu_models, [Q.e8, Q.r4].sort());
});

test('no GPU: every GPU tier takes the fallback profile with exactly one notice', () => {
  const r = run({ gpu: false, settings: { profile: 'gpu-balanced', routing: { reviewer: 'gpu-rerank', coder: 'gpu-recall-max', orchestrator: 'cpu-fast', tester: { embedder: Q.e4 } } } });
  for (const t of ['reviewer', 'coder', 'tester']) {
    assert.deepStrictEqual([r.tiers[t].embedder, r.tiers[t].reranker, r.tiers[t].device, r.tiers[t].profile], [RP.NANO, null, 'cpu', 'cpu-fast'], t);
  }
  assert.deepStrictEqual([r.tiers.researcher.embedder, r.tiers.researcher.device], [RP.NANO, 'cpu'], 'an unset type follows the run, itself fallen back');
  assert.strictEqual(r.tiers.reviewer.fallback_from, 'gpu-rerank');
  assert.strictEqual(r.tiers.orchestrator.fallback_from, null, 'a CPU tier is not a fallback');
  assert.strictEqual(r.notices.length, 1);
  assert.strictEqual(r.notices[0].code, 'gpu_absent');
  assert.deepStrictEqual(r.notices[0].agent_types.slice().sort(), ['coder', 'reviewer', 'run', 'tester']);
  assert.deepStrictEqual(r.gpu_models, []);
  for (const gpu of [undefined, null, false, { ok: false }, { available: false }]) assert.strictEqual(run({ gpu, settings: { profile: 'gpu-rerank' } }).notices.length, 1, JSON.stringify(gpu));
  assert.strictEqual(run({ gpu: false }).notices.length, 0, 'nothing heavy asked, nothing said');
});

test('no GPU: a heavy embedder is never placed on the CPU, and the fallback is itself checked for a pending pin', () => {
  const r = run({ gpu: false, settings: { profile: 'custom', embedder: Q.e4, reranker: 'none' } });
  assert.strictEqual(r.run.embedder, RP.NANO);
  assert.strictEqual(r.run.device, 'cpu');
  for (const t of Object.values(r.tiers)) assert.strictEqual(RP.describeModel(t.embedder).device, 'cpu');
  const lone = run({ gpu: false, settings: { routing: { coder: { embedder: Q.e8, reranker: 'none' } } } });
  assert.strictEqual(lone.tiers.coder.embedder, RP.NANO);
  assert.throws(() => run({ gpu: false, settings: { profile: 'gpu-rerank', profile_cpu: 'cpu-rerank' } }), (e) => e.code === 'E_MODEL');
});

test('the pending pin is refused in a custom reranker and a routed pair, with a coded error naming the model', () => {
  const jina = 'jinaai/jina-reranker-v1-tiny-en';
  for (const settings of [{ profile: 'custom', reranker: jina }, { routing: { coder: { embedder: RP.NANO, reranker: jina } } }, { routing: { coder: 'cpu-rerank' } }]) {
    assert.throws(() => run({ settings }), (e) => e.code === 'E_MODEL' && e.detail.reason === 'pending_pin' && /pinned/.test(e.message), JSON.stringify(settings));
  }
});

test('gpu_models: the distinct GPU models over the run and every role, sorted, each once', () => {
  const r = run({ settings: { profile: 'gpu-rerank', routing: { orchestrator: 'gpu-balanced', reviewer: 'gpu-rerank', coder: 'gpu-rerank-fast', tester: 'gpu-balanced' } } });
  assert.deepStrictEqual(r.gpu_models, [Q.e4, Q.r06, Q.r4].sort());
  assert.deepStrictEqual(run({ settings: { profile: 'cpu-fast' } }).gpu_models, []);
});

test('gpuUsable reads true or a probe-shaped object; bad agent types are refused', () => {
  assert.deepStrictEqual([true, { ok: true, device: { name: 'x' } }, {}].map(gpuUsable), [true, true, true]);
  assert.deepStrictEqual([false, null, undefined, 'yes', { ok: false }].map(gpuUsable), [false, false, false, false, false]);
  assert.throws(() => resolveRouting({ agentTypes: [''] }), { code: 'E_ARGS' });
  assert.throws(() => resolveRouting({ agentTypes: 'coder' }), { code: 'E_ARGS' });
});
