'use strict';
require('../helpers/tmp.cjs');
// retrieval-routing-cpu.test.cjs — the routing_cpu lever's limits and its interplay with routing (ADR 0050 amendment 3): the entry cap, the pending
// refusal, `run` as no agent type, and a type that has both a GPU entry and a CPU one.

const { test } = require('node:test');
const assert = require('node:assert');
const ML = require('../../src/core/memory-levers.cjs');
const RP = require('../../src/core/retrieval-profiles.cjs');
const { resolveRouting } = require('../../src/core/retrieval-routing.cjs');

const parse = (b) => ML.parseMemoryBlock(b);
const JINA = 'jinaai/jina-reranker-v1-tiny-en', GTE = 'Alibaba-NLP/gte-reranker-modernbert-base';
const pend = (fn, ...ids) => { const es = ids.map((i) => RP.ONNX_RERANKERS[i]); es.forEach((e) => { e.pending_pin = true; }); try { return fn(); } finally { es.forEach((e) => { e.pending_pin = false; }); } };

test('routing_cpu holds at most ROUTING_MAX entries, like routing', () => {
  const ok = {};
  for (let i = 0; i < ML.ROUTING_MAX; i += 1) ok[`t${i}`] = 'cpu-fast';
  assert.strictEqual(parse({ routing_cpu: ok }).error, undefined);
  assert.match(parse({ routing_cpu: { ...ok, extra: 'cpu-fast' } }).error, /memory\.routing_cpu has more than 64 entries/);
});

test('a CPU pick whose model is pending its pin is refused with E_MODEL, as a routing entry is', () => {
  pend(() => {
    const r = parse({ routing_cpu: { reviewer: 'cpu-rerank-light' } });
    assert.strictEqual(r.code, 'E_MODEL');
    assert.match(r.error, /memory\.routing_cpu\.reviewer: .*not yet available/);
  }, JINA, GTE);
  assert.strictEqual(parse({ routing_cpu: { reviewer: 'cpu-rerank-light' } }).error, undefined, 'and accepted once pinned');
});

test('run is not an agent type: neither map takes it, so the run tier is never overwritten by a type of that name', () => {
  assert.match(parse({ routing: { run: 'cpu-fast' } }).error, /memory\.routing\.run: run is not an agent type/);
  assert.match(parse({ routing_cpu: { run: 'cpu-fast' } }).error, /memory\.routing_cpu\.run: run is not an agent type/);
});

test('a type with both entries takes the GPU entry with a GPU and its CPU pick without one; a type with only a CPU pick follows the run profile when a GPU is usable', () => {
  const levers = parse({ profile: 'gpu-balanced', profile_cpu: 'cpu-fast', routing: { reviewer: 'gpu-rerank' }, routing_cpu: { reviewer: 'cpu-rerank', coder: 'cpu-rerank-light' } }).value;
  const types = ['orchestrator', 'reviewer', 'coder'];
  const gpu = resolveRouting({ levers, agentTypes: types, gpu: true });
  assert.deepStrictEqual([gpu.tiers.reviewer.profile, gpu.tiers.coder.profile, gpu.tiers.orchestrator.profile], ['gpu-rerank', 'gpu-balanced', 'gpu-balanced']);
  const cpu = resolveRouting({ levers, agentTypes: types, gpu: false });
  assert.deepStrictEqual([cpu.tiers.reviewer.profile, cpu.tiers.coder.profile, cpu.tiers.orchestrator.profile], ['cpu-rerank', 'cpu-rerank-light', 'cpu-fast']);
  assert.strictEqual(cpu.tiers.reviewer.fallback_from, 'gpu-rerank');
  assert.deepStrictEqual(cpu.gpu_models, []);
  assert.strictEqual(cpu.run.profile, 'cpu-fast', 'the run tier is profile_cpu: a type named run cannot change it');
});
