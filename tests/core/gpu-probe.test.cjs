'use strict';
// gpu-probe.test.cjs — the probe's arithmetic and refusals (ADR 0049 decision 6), with a FAKE GPU child and a
// fake model table, and the real GPU worker driven through a stub node-llama-cpp. No GPU, no runtime, no npm.

process.env.BELAY_TEST_MODE = '1';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, FIXTURES } = require('./helpers.cjs');

const P = core('gpu-probe.cjs');
const { GpuClient } = core('gpu.cjs');
const { writeStubRuntime, writeCache } = require('./fixtures/gpu-stub-runtime.cjs');
const REF = require('./fixtures/qwen3-query-ref.json');
const GGUF = core('gguf-models.cjs');
const FAKE = path.join(FIXTURES, 'gpu-worker-fake.cjs');
const MIB = 1048576;
const SHA = 'a'.repeat(40), H = 'b'.repeat(64);

const entry = (id, kind, extra) => ({ id, sha: SHA, runtime: 'gguf', kind, label: id, files: [{ path: 'm.gguf', bytes: 10, sha256: H }], pooling: kind === 'embedder' ? 'last' : null, query_prompt: '', document_prompt: '', native_dims: kind === 'embedder' ? 8 : null, dims: kind === 'embedder' ? 8 : null, license: 'apache-2.0', context_size: 1024, vram_mb_ref: 500, ...extra });
const TABLE = { 'org/emb': entry('org/emb', 'embedder'), 'org/rr': entry('org/rr', 'reranker'), 'org/big': entry('org/big', 'embedder', { vram_mb_ref: 6000 }) };
const GB = 1024 * MIB;
// Reference laptop: Vulkan total 25,526,403,072, unified 17,243,701,248, dedicated 7,899 MiB, nvidia-smi 8,151 / 7,899 free.
const smi = (over) => () => ({ name: 'NVIDIA GeForce RTX 5060 Laptop GPU', driver: '617.42', total_mb: 8151, used_mb: 0, free_mb: 7899, ...over });

function rig(fake = {}) {
  const cache = sandbox();
  writeCache(cache, TABLE);
  return { cache, base: (o = {}) => ({ cacheDir: cache, table: TABLE, runtimeDir: 'unused', record: path.join(cache, 'peaks.json'), smi: smi(), clientOpts: { workerPath: FAKE, workerOpts: { fake } }, ...o }) };
}

test('dedicated memory is total minus the shared heap, and matches nvidia-smi on the reference laptop', () => {
  const ded = P.dedicatedFrom({ total: 25526403072, unified: 17243701248, used: 1667490816 });
  assert.strictEqual(ded.total_mb, 7899, 'total - unifiedSize = 8,282,701,824 bytes = 7,899 MiB');
  assert.strictEqual(ded.shared_mb, 16444.9);
  assert.strictEqual(ded.aggregate_total_mb, 24343.9, 'the figure that over-reports the card three times');
  const free = P.freeDedicated(ded, { total_mb: 8151, free_mb: 7899 });
  assert.strictEqual(free.source, 'nvidia-smi');
  assert.strictEqual(free.free_mb, 7899);
  assert.deepStrictEqual([free.cross_check.agree, free.cross_check.reserved_mb], [true, 252]);
  const est = P.freeDedicated(ded, null);
  assert.strictEqual(est.source, 'vulkan-estimate');
  assert.ok(est.free_mb < 7899, 'without nvidia-smi the aggregate used (the iGPU included) can only under-count');
  const odd = P.freeDedicated(ded, { total_mb: 24000, free_mb: 23000 });
  assert.strictEqual(odd.cross_check.agree, false);
  assert.ok(odd.free_mb <= 7899, 'a disagreeing meter never raises the figure');
  assert.strictEqual(P.dedicatedFrom({ total: 8 * GB, unified: 0, used: 0 }).total_mb, 8192, 'a discrete-only machine has no shared heap');
});

test('the needed memory is the SUM of peaks plus headroom, and a peak is the larger growth of the two meters', () => {
  const n = P.needed({ a: { peak_mb: 2782 }, b: { peak_mb: 2629 } }, P.HEADROOM_MB);
  assert.deepStrictEqual(n, { sum_mb: 5411, headroom_mb: 768, needed_mb: 6179 });
  assert.deepStrictEqual(P.peakFrom({ vulkanDelta: 752, smiDelta: 764, hint: 1 }), { peak_mb: 764, source: 'nvidia-smi' });
  assert.deepStrictEqual(P.peakFrom({ vulkanDelta: 752, smiDelta: NaN, hint: 1 }), { peak_mb: 752, source: 'vulkan' });
  assert.deepStrictEqual(P.peakFrom({ vulkanDelta: 0, smiDelta: NaN, hint: 879 }), { peak_mb: 879, source: 'hint' });
  assert.strictEqual(P.peakKey('m', { gpu: 'vulkan', context: 1024 }, '617.42'), 'm|context=1024,gpu=vulkan|driver=617.42');
});

test('the rerank chunk is sized in tokens from the measured cost per token', () => {
  assert.strictEqual(P.deriveChunkTokens(0.1), 6666, '0.1 ms a token, 1000 ms target, margin 1.5');
  assert.strictEqual(P.deriveChunkTokens(0.4, { targetMs: 2000 }), 3333);
  assert.strictEqual(P.deriveChunkTokens(5000), 1, 'never below one token');
  assert.strictEqual(P.deriveChunkTokens(0), Infinity, 'no measurable cost, no token bound');
  for (const ms of [0.05, 0.1, 0.4, 2]) assert.ok(P.deriveChunkTokens(ms) * ms * 1.5 <= 1000 + 1e-6, `${ms} ms a token`);
});

test('probe: a set that fits returns the peaks, the sum against free, the chunk, and records the peaks by driver', async () => {
  const { cache, base } = rig({ per_model: { 'org/emb': 760 * MIB, 'org/rr': 880 * MIB } });
  try {
    const r = await P.probe(base({ models: ['org/emb', 'org/rr'] }));
    assert.strictEqual(r.ok, true, JSON.stringify(r.refusal));
    assert.strictEqual(r.device.name, 'NVIDIA GeForce RTX 5060 Laptop GPU');
    assert.deepStrictEqual([r.dedicated.total_mb, r.dedicated.free_mb, r.dedicated.source], [7899, 7899, 'nvidia-smi']);
    assert.strictEqual(r.peaks['org/emb'].peak_mb, 760);
    assert.strictEqual(r.peaks['org/rr'].peak_mb, 880);
    assert.strictEqual(r.sum_mb, 1640);
    assert.strictEqual(r.needed_mb, 1640 + 768);
    assert.ok(r.needed_mb <= r.free_mb);
    assert.strictEqual(r.measured_set_mb, 1640, 'the set grew by what the sum says');
    const rr = r.rerank['org/rr'];
    assert.strictEqual(rr.chunk_tokens, P.deriveChunkTokens(rr.ms_per_token));
    assert.strictEqual(rr.batch_size, 512);
    assert.ok(rr.ubatch_tokens > 100 && rr.ubatch_ms >= 0, 'the full-batch submission was timed');
    assert.ok(r.peaks['org/emb'].samples.vulkan > 0, 'the peak came from samples taken while the load ran');
    assert.strictEqual(r.driver, '617.42');
    const rec = P.recordedPeak('org/emb', { gpu: 'vulkan', context: 1024 }, '617.42', path.join(cache, 'peaks.json'));
    assert.strictEqual(rec.peak_mb, 760);
    assert.strictEqual(P.recordedPeak('org/emb', { gpu: 'vulkan', context: 1024 }, '999.0', path.join(cache, 'peaks.json')), null, 'another driver is another key');
  } finally { cleanup(cache); }
});

test('probe: the sum plus headroom against free is what refuses, naming needed against free and the options', async () => {
  const { cache, base } = rig({ per_model: { 'org/emb': 3800 * MIB, 'org/rr': 3700 * MIB } });
  try {
    const r = await P.probe(base({ models: ['org/emb', 'org/rr'] }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.refusal.reason, 'insufficient_vram');
    assert.strictEqual(r.needed_mb, 3800 + 3700 + 768);
    assert.strictEqual(r.free_mb, 7899);
    assert.match(r.refusal.message, /needs 8268 MiB/);
    assert.ok(r.refusal.options.length >= 2);
    const rec = JSON.parse(fs.readFileSync(path.join(cache, 'peaks.json'), 'utf8'));
    assert.deepStrictEqual(rec.entries, {}, 'a refusal records no peaks');
    assert.deepStrictEqual([rec.last.ok, rec.last.reason, rec.last.free_mb, rec.last.total_mb], [false, 'insufficient_vram', 7899, 7899], 'it records the device reading the menu shows, with the refusal');
    // each alone would have fit: it is the sum that refuses
    const alone = await P.probe(base({ models: ['org/emb'] }));
    assert.strictEqual(alone.ok, true);
    // a bigger headroom lever turns a fit into a refusal
    const tight = await P.probe(base({ models: ['org/emb'], headroomMb: 5000 }));
    assert.strictEqual(tight.refusal.reason, 'insufficient_vram');
  } finally { cleanup(cache); }
});

test('probe: loading stops as soon as the running sum cannot fit', async () => {
  const { cache, base } = rig({ per_model: { 'org/big': 7500 * MIB } });
  try {
    const r = await P.probe(base({ models: ['org/big', 'org/rr'] }));
    assert.strictEqual(r.refusal.reason, 'insufficient_vram');
    assert.deepStrictEqual(Object.keys(r.peaks), ['org/big'], 'the second model was never loaded');
    assert.match(r.refusal.message, /and more not loaded/);
  } finally { cleanup(cache); }
});

test('probe: refusals for no runtime, a model not fetched, no GPU, no discrete GPU, a failed sanity check, a load failure, a dead child', async () => {
  const { cache, base } = rig();
  try {
    const env = { BELAY_GPU_RUNTIME: path.join(cache, 'none') };
    const noRuntime = await P.probe({ ...base({ models: ['org/emb'], env }), runtimeDir: null, clientOpts: {} });
    assert.strictEqual(noRuntime.refusal.reason, 'no_runtime');
    assert.match(noRuntime.refusal.options.join(' '), /belay embedder fetch --gpu/);
    fs.rmSync(path.join(cache, 'org', 'emb@' + SHA), { recursive: true, force: true });
    const absent = await P.probe(base({ models: ['org/emb'] }));
    assert.strictEqual(absent.refusal.reason, 'model_absent');
    assert.match(absent.refusal.options[0], /belay embedder fetch --gpu --model org\/emb/);
    assert.strictEqual((await P.probe(base({ models: ['nope/x'] }))).refusal.reason, 'unknown_model');
    assert.strictEqual((await P.probe(base({ models: [] }))).refusal.reason, 'no_models');

    const noGpu = await P.probe(base({ models: ['org/rr'], clientOpts: { workerPath: FAKE, workerOpts: { fake: { vram_fail: true } } } }));
    assert.strictEqual(noGpu.refusal.reason, 'no_gpu');
    const igpu = await P.probe(base({ models: ['org/rr'], clientOpts: { workerPath: FAKE, workerOpts: { fake: { total: 17243701248, unified: 17243701248, devices: ['AMD Radeon(TM) Graphics'] } } } }));
    assert.strictEqual(igpu.refusal.reason, 'no_discrete_gpu');
    assert.match(igpu.refusal.message, /0 MiB dedicated/);
    const flat = await P.probe(base({ models: ['org/rr'], clientOpts: { workerPath: FAKE, workerOpts: { fake: { flat_scores: true } } } }));
    assert.strictEqual(flat.refusal.reason, 'sanity_failed');
    assert.match(flat.refusal.message, /did not outrank filler/);
    const loadFail = await P.probe(base({ models: ['org/rr'], clientOpts: { workerPath: FAKE, workerOpts: { fake: { load_fail: true } } } }));
    assert.strictEqual(loadFail.refusal.reason, 'insufficient_vram', 'an allocation failure is a memory refusal, not a probe failure');
    assert.match(loadFail.refusal.message, /ran out of memory loading org\/rr/);
    const other = await P.probe(base({ models: ['org/rr'], clientOpts: { workerPath: FAKE, workerOpts: { fake: { load_fail: true, load_fail_msg: 'the GGUF file is corrupt' } } } }));
    assert.strictEqual(other.refusal.reason, 'probe_failed');
  } finally { cleanup(cache); }
});

test('probe: without nvidia-smi the Vulkan estimate is used and said so', async () => {
  const { cache, base } = rig({ per_model: { 'org/rr': 880 * MIB } });
  try {
    const r = await P.probe(base({ models: ['org/rr'], smi: false }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.dedicated.source, 'vulkan-estimate');
    assert.strictEqual(r.driver, null);
    assert.strictEqual(r.peaks['org/rr'].peak_mb, 880);
  } finally { cleanup(cache); }
});

