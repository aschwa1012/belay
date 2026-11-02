'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// retrieval-routing.test.cjs — resolveRouting: layering, every profile, per-role routing, the no-GPU notice once,
// a heavy embedder never on the CPU, the pending-pin refusal and the gpu_models dedupe.

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveRouting, gpuUsable } = require('../../src/core/retrieval-routing.cjs');
const RP = require('../../src/core/retrieval-profiles.cjs');
const { parseLevers } = require('../../src/cli/run-levers.cjs');

const TYPES = ['orchestrator', 'reviewer', 'coder', 'tester', 'researcher'];
// The caller's side of the contract: the config file's memory block and the run spec's, merged and parsed by the real
// parseLevers, then handed over as the run row's memory_levers (absent when the block is all defaults).
function lv(settings, spec) {
  const p = parseLevers({ ...(spec ? { memory: spec } : {}) }, { config: settings ? { path: 'belay.config.json', memory: settings } : null });
  if (p.error) throw new Error(p.error);
  return p.memory_levers || {};
}
// `settings` / `spec` go through the real merge; `raw` goes straight in (for models the lever parse refuses).
const run = ({ settings, spec, raw, ...o } = {}) => resolveRouting({ agentTypes: TYPES, gpu: true, levers: raw || lv(settings, spec), ...o });
// The pending mechanism is kept for a future model; no shipped entry is pending, so a test marks a pinned one and restores it.
const pend = (fn, ...ids) => { const es = ids.map((i) => RP.ONNX_RERANKERS[i]); es.forEach((e) => { e.pending_pin = true; }); try { return fn(); } finally { es.forEach((e) => { e.pending_pin = false; }); } };
const JINA = 'jinaai/jina-reranker-v1-tiny-en', GTE = 'Alibaba-NLP/gte-reranker-modernbert-base';
const Q = { e4: 'Qwen/Qwen3-Embedding-4B-GGUF', e8: 'Qwen/Qwen3-Embedding-8B-GGUF', r06: 'ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF', r4: 'giladgd/Qwen3-Reranker-4B-GGUF' };

test('defaults: nano with no reranker for every type, no GPU model, no notice, and the result is plain JSON', () => {
  const r = run({ gpu: false });
  for (const t of TYPES) assert.deepStrictEqual(r.tiers[t], { profile: 'cpu-fast', embedder: RP.NANO, reranker: null, device: 'cpu', depth: 0, source: 'run', fallback_from: null }, t);
  assert.deepStrictEqual([r.gpu_models, r.notices], [[], []]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), JSON.parse(JSON.stringify({ ...r, tiers: { ...r.tiers } })));
  assert.strictEqual(Object.getPrototypeOf(r.tiers), null, 'no inherited key answers for an agent type');
  assert.strictEqual(r.tiers.constructor, undefined);
  assert.deepStrictEqual(Object.keys(r), ['run', 'tiers', 'gpu', 'gpu_models', 'notices', 'levers']);
});

test('every profile resolves with a GPU, at depth 50; the CPU rerankers are refused only while marked pending', () => {
  for (const name of ['cpu-rerank', 'cpu-rerank-light']) pend(() => assert.throws(() => run({ raw: { profile: name } }), (e) => e.code === 'E_MODEL' && /not yet available/.test(e.message), name), JINA, GTE);
  for (const [name, p] of Object.entries(RP.PROFILES)) {
    const call = () => run({ raw: { profile: name } });
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
  assert.throws(() => run({ settings: { rerank_depth: 5 }, spec: { rerank_depth: 500 } }), /rerank_depth/, 'the real merge refuses it before the resolver');
  assert.throws(() => run({ raw: 7 }), { code: 'E_ARGS' });
});

test('routing: main and advanced keys, a custom pair, and a routed type outside agentTypes', () => {
  const r = resolveRouting({
    gpu: true, agentTypes: ['orchestrator', 'reviewer', 'coder', 'tester'],
    levers: lv({ routing: { orchestrator: 'gpu-balanced', reviewer: 'gpu-rerank', coder: { embedder: RP.NANO, reranker: Q.r06 }, tester: 'cpu-fast', 'scrubber': 'gpu-recall-max' } }),
  });
  assert.deepStrictEqual([r.tiers.orchestrator.embedder, r.tiers.orchestrator.reranker], [Q.e4, Q.r4]);
  assert.deepStrictEqual([r.tiers.reviewer.embedder, r.tiers.reviewer.reranker], [RP.NANO, Q.r4]);
  assert.deepStrictEqual([r.tiers.coder.profile, r.tiers.coder.reranker, r.tiers.coder.device], ['custom', Q.r06, 'gpu']);
  assert.strictEqual(r.tiers.tester.device, 'cpu');
  assert.strictEqual(r.tiers['scrubber'].embedder, Q.e8, 'an advanced key resolves though no caller listed it');
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
  assert.deepStrictEqual(r.notices[0].agent_types.slice().sort(), ['coder', 'reviewer', 'tester']);
  assert.strictEqual(r.notices[0].run_fell_back, true);
  assert.deepStrictEqual(r.gpu_models, []);
  for (const gpu of [undefined, null, false, {}, { gpus: [] }, { ok: false }, { available: false }, { refusal: { code: 'x' } }]) assert.strictEqual(run({ gpu, settings: { profile: 'gpu-rerank' } }).notices.length, 1, JSON.stringify(gpu));
  assert.strictEqual(run({ gpu: false }).notices.length, 0, 'nothing heavy asked, nothing said');
});

test('no GPU: a heavy embedder is never placed on the CPU, and the fallback is itself checked for a pending pin', () => {
  const r = run({ gpu: false, settings: { profile: 'custom', embedder: Q.e4, reranker: 'none' } });
  assert.strictEqual(r.run.embedder, RP.NANO);
  assert.strictEqual(r.run.device, 'cpu');
  for (const t of Object.values(r.tiers)) assert.strictEqual(RP.describeModel(t.embedder).device, 'cpu');
  const lone = run({ gpu: false, settings: { routing: { coder: { embedder: Q.e8, reranker: 'none' } } } });
  assert.strictEqual(lone.tiers.coder.embedder, RP.NANO);
  pend(() => assert.throws(() => run({ gpu: false, raw: { profile: 'gpu-rerank', profile_cpu: 'cpu-rerank' } }), (e) => e.code === 'E_MODEL'), GTE);
  assert.strictEqual(run({ gpu: false, raw: { profile: 'gpu-rerank', profile_cpu: 'cpu-rerank' } }).run.reranker, GTE, 'a pinned CPU reranker is the fallback');
});

test('a pending pin is refused in a custom reranker and a routed pair, with a coded error naming the model', () => {
  for (const raw of [{ profile: 'custom', reranker: JINA }, { routing: { coder: { embedder: RP.NANO, reranker: JINA } } }, { routing: { coder: 'cpu-rerank' } }]) {
    assert.doesNotThrow(() => run({ raw }), 'pinned: ' + JSON.stringify(raw));
    pend(() => {
      assert.throws(() => run({ raw }), (e) => e.code === 'E_MODEL' && /not yet available/.test(e.message), JSON.stringify(raw));
      assert.strictEqual(require('../../src/core/memory-levers.cjs').parseMemoryBlock(raw).code, 'E_MODEL', 'and the lever parse refuses it first');
    }, JINA, GTE);
  }
});

test('gpu_models: the distinct GPU models over the run and every role, sorted, each once', () => {
  const r = run({ settings: { profile: 'gpu-rerank', routing: { orchestrator: 'gpu-balanced', reviewer: 'gpu-rerank', coder: 'gpu-rerank-fast', tester: 'gpu-balanced' } } });
  assert.deepStrictEqual(r.gpu_models, [Q.e4, Q.r06, Q.r4].sort());
  assert.deepStrictEqual(run({ settings: { profile: 'cpu-fast' } }).gpu_models, []);
});

test('gpuUsable fails closed: true, or a probe result saying ok or available; bad agent types are refused', () => {
  assert.deepStrictEqual([true, { ok: true, device: { name: 'x' } }, { available: true }].map(gpuUsable), [true, true, true]);
  assert.deepStrictEqual([false, null, undefined, 'yes', {}, { gpus: [] }, { refusal: { code: 'x' } }, { ok: false }].map(gpuUsable), Array(8).fill(false));
  assert.throws(() => resolveRouting({ agentTypes: [''] }), { code: 'E_ARGS' });
  for (const bad of ['__proto__', 'Coder', 'constructor!', 'a'.repeat(33)]) assert.throws(() => resolveRouting({ agentTypes: [bad] }), { code: 'E_ARGS' }, bad);
  assert.throws(() => resolveRouting({ agentTypes: 'coder' }), { code: 'E_ARGS' });
});

test('a raw block is re-validated: the four unsafe blocks are refused with a coded error, never resolved or crashed on', () => {
  const E8 = 'Qwen/Qwen3-Embedding-8B-GGUF';
  const cases = [
    ['a GPU embedder as the CPU fallback', { profile: 'gpu-balanced', profile_cpu: 'custom', embedder: E8 }, /CPU-only/],
    ['a reranker as the embedder', { profile: 'custom', embedder: Q.r4 }, /memory.embedder/],
    ['a depth that is not a number', { rerank_depth: 'lots' }, /rerank_depth/],
    ['an unknown pair', { routing: { coder: { embedder: 'nope/none', reranker: 'nope/none' } } }, /memory.routing.coder/],
  ];
  for (const [what, raw, re] of cases) {
    for (const gpu of [false, true]) assert.throws(() => run({ raw, gpu }), (e) => e.code === 'E_ARGS' && re.test(e.message) && e.name === 'CoreError', what);
  }
});

test('routing_cpu: with no GPU a type takes its own CPU profile, with a GPU it is ignored, and an unset type still takes profile_cpu', () => {
  const settings = { profile: 'gpu-balanced', profile_cpu: 'cpu-fast', routing: { reviewer: 'gpu-rerank' }, routing_cpu: { reviewer: 'cpu-rerank', coder: 'cpu-rerank-light' } };
  const none = run({ settings, gpu: false });
  assert.strictEqual(none.tiers.reviewer.profile, 'cpu-rerank');
  assert.strictEqual(none.tiers.reviewer.fallback_from, 'gpu-rerank');
  assert.strictEqual(none.tiers.coder.profile, 'cpu-rerank-light', 'a type with no routing entry takes its CPU pick when the run profile fell back');
  assert.strictEqual(none.tiers.coder.fallback_from, 'gpu-balanced');
  assert.strictEqual(none.tiers.tester.profile, 'cpu-fast', 'an unset type takes profile_cpu');
  assert.deepStrictEqual(none.gpu_models, []);
  const some = run({ settings, gpu: true });
  assert.strictEqual(some.tiers.reviewer.profile, 'gpu-rerank');
  assert.strictEqual(some.tiers.coder.profile, 'gpu-balanced', 'the CPU pick is not used while a GPU is usable');
  assert.deepStrictEqual(some.gpu_models, [Q.e4, Q.r4].sort());
  assert.ok(run({ settings: { profile: 'cpu-fast', routing_cpu: { coder: 'cpu-rerank' } }, gpu: false }).tiers.coder.source === 'run', 'a CPU-only run profile never fell back, so the CPU pick is not consulted');
});
