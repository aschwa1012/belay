'use strict';
// gpu-worker.cjs — the GPU child PROCESS (ADR 0049 decision 3). gpu.cjs forks this file with IPC and knows it
// by its exact handle. argv[2] is the JSON of { runtimeDir }, the installed runtime (gpu-runtime.cjs). The child
// imports node-llama-cpp from there, so a native crash or a Vulkan driver reset takes down this process and
// nothing else, and the VRAM goes back when it exits. Only gpu.cjs requires or forks this file.
//
// Messages in: { id, op, ... } with op one of
//   load   { model, kind: 'embedder'|'reranker', path, gpu: 'vulkan'|false, contextSize, batchSize?, dims?, queryPrompt?, chunk? }
//   embed  { model, text, as: 'query'|'document' }          -> { embedding, dim, tokens, ms }
//   rank   { model, query, docs, chunk?, chunkTokens? }     -> { scores, chunks: [{ n, tokens, ms }], pair_tokens, truncated, ms }
//   vram   { gpu? }                                         -> { gpu, devices, total, used, free, unified } in bytes
//   ping                                                    -> { pong, pid, models }
//   close
// Out: { id, ok: true, result }, { id, ok: false, error: { code, message, detail } }, and { id, progress } lines,
// which the owner counts as proof of life for that request and for those queued behind it: one per rank chunk, and
// a heartbeat every 5 s while a load runs (a cold load of a big model, with a shader build, sends nothing else). Work is served one op at a time.
//
// A rank goes out in chunks (ADR 0049 decision 7, gpu-chunk.cjs): at most `chunk` pairs and `chunkTokens` tokens
// each, one rankAll per chunk and one progress line after it. A chunk is many GPU submissions (decodes); what
// bounds one submission is the context's `batchSize` (tokens per decode), set at load from the probe.
//
// The child ends when the owner dies: the IPC channel is the only handle that keeps its event loop alive, and a
// 'disconnect' handler ends it at once even while a native context is loaded. `close` disposes the models
// (bounded) and exits. Test-only ops (BELAY_TEST_MODE=1): env, sleep, hang, fail, crash.

const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { RANK_TEMPLATE_TOKENS, docCap, planChunks } = require('./gpu-chunk.cjs');

const opts = JSON.parse(process.argv[2] || '{}');
const DISPOSE_BOUND_MS = 1500;
const HEARTBEAT_MS = opts.heartbeatMs || 5000;
const SLOW_CHUNK_MS = opts.slowChunkMs || 1500; // a rank chunk slower than this is reported in the rank result
let llama = null, gpuMode = null, getLlama = null;
const models = new Map();
let chain = Promise.resolve();
const serial = (fn) => { const r = chain.then(fn); chain = r.catch(() => {}); return r; };

const reply = (id, result) => process.send({ id, ok: true, result });
function fail(id, e) {
  process.send({ id, ok: false, error: { code: e && e.code, message: (e && e.message) || String(e), detail: e && e.detail } });
}
const bad = (message, code = 'E_ARGS') => Object.assign(new Error(message), { code });

async function runtime(gpu) {
  if (gpu !== 'vulkan' && gpu !== false) throw bad(`gpu must be 'vulkan' or false, not ${JSON.stringify(gpu)}`);
  if (!llama) {
    if (!opts.runtimeDir) throw bad('the GPU child was started without a runtime directory', 'E_MODEL_ABSENT');
    const entry = pathToFileURL(path.join(opts.runtimeDir, 'node_modules', 'node-llama-cpp', 'dist', 'index.js')).href;
    const mod = await import(entry);
    getLlama = mod.getLlama || (mod.default && mod.default.getLlama);
    // build: 'never' so a missing prebuilt binary is an error here and never a source build.
    llama = await getLlama({ gpu, build: 'never' });
    gpuMode = gpu;
    if (gpu === 'vulkan' && llama.gpu !== 'vulkan') throw bad(`Vulkan was requested and the runtime came up on ${JSON.stringify(llama.gpu)}`, 'E_MODEL_ABSENT');
  } else if (gpu !== gpuMode) throw bad(`this GPU child runs with gpu=${JSON.stringify(gpuMode)} and cannot also serve gpu=${JSON.stringify(gpu)}`);
  return llama;
}

async function vram(gpu) {
  const l = await runtime(gpu === undefined ? (gpuMode === null ? 'vulkan' : gpuMode) : gpu);
  const s = await l.getVramState();
  return { gpu: l.gpu, devices: await l.getGpuDeviceNames(), total: s.total, used: s.used, free: s.free, unified: s.unifiedSize };
}

const need = (id) => {
  const m = models.get(id);
  if (!m) throw bad(`the GPU child has not loaded ${JSON.stringify(id)}`, 'E_MODEL_ABSENT');
  return m;
};

async function load(m) {
  if (models.has(m.model)) throw bad(`${m.model} is already loaded`);
  const l = await runtime(m.gpu);
  const t0 = Date.now();
  const model = await l.loadModel({ modelPath: m.path, gpuLayers: m.gpu ? 'max' : 0 });
  const ctx = m.kind === 'reranker' ? await model.createRankingContext({ contextSize: m.contextSize, ...(m.batchSize ? { batchSize: m.batchSize } : {}) }) : await model.createEmbeddingContext({ contextSize: m.contextSize });
  models.set(m.model, { ...m, model, ctx });
  return { model: m.model, load_ms: Date.now() - t0, batch_size: m.batchSize || null, gpu_layers: model.gpuLayers, native_dims: m.kind === 'embedder' ? model.embeddingVectorSize : null, size_mb: Math.round(model.size / 1048576) };
}

function unit(v, dims) {
  const cut = Float32Array.from(v.slice(0, dims || v.length)); // Matryoshka: the first `dims` values, renormalised
  let n = 0;
  for (const x of cut) n += x * x;
  n = Math.sqrt(n) || 1;
  return Array.from(cut, x => x / n);
}

async function embed(m) {
  const e = need(m.model);
  if (e.kind !== 'embedder') throw bad(`${m.model} is a reranker`);
  if (m.as !== 'query' && m.as !== 'document') throw bad(`embed: as must be 'document' or 'query', not ${JSON.stringify(m.as)}`);
  const text = (m.as === 'query' ? e.queryPrompt || '' : '') + m.text;
  const t0 = Date.now();
  const out = await e.ctx.getEmbeddingFor(text);
  const vec = unit(out.vector, e.dims);
  return { embedding: vec, dim: vec.length, tokens: e.ctx.calculateInputLength(text), ms: Date.now() - t0 };
}

async function rank(m, id) {
  const e = need(m.model);
  if (e.kind !== 'reranker') throw bad(`${m.model} is an embedder`);
  if (!Array.isArray(m.docs) || !m.docs.length) throw bad('rank needs a non-empty list of docs');
  const queryTokens = e.model.tokenize(m.query).length, cap = docCap(e.contextSize, queryTokens);
  let truncated = 0;
  const docs = m.docs.map((d) => { // a document the context cannot hold is cut: rankAll throws on one
    const t = e.model.tokenize(d);
    if (t.length <= cap) return { text: d, tokens: t.length };
    truncated += 1;
    return { text: e.model.detokenize(t.slice(0, cap)), tokens: cap };
  });
  const cost = docs.map(d => d.tokens + queryTokens + RANK_TEMPLATE_TOKENS);
  const plan = planChunks(cost, { maxPairs: Math.max(1, Math.floor(m.chunk || e.chunk || docs.length)), maxTokens: m.chunkTokens || e.chunkTokens || Infinity });
  const scores = [], chunks = [];
  const t0 = Date.now();
  for (const [from, to] of plan) {
    const c0 = Date.now();
    scores.push(...await e.ctx.rankAll(m.query, docs.slice(from, to).map(d => d.text)));
    chunks.push({ n: to - from, tokens: cost.slice(from, to).reduce((x, y) => x + y, 0), ms: Date.now() - c0 });
    process.send({ id, progress: { done: scores.length, total: docs.length } });
  }
  const slow = chunks.map((c, index) => ({ index, ms: c.ms })).filter(c => c.ms > SLOW_CHUNK_MS);
  return { scores, chunks, pair_tokens: cost, truncated, slow_chunks: slow, slow_chunk_ms: SLOW_CHUNK_MS, ms: Date.now() - t0 };
}

async function close() {
  const dispose = (async () => { for (const e of models.values()) { await e.ctx.dispose(); await e.model.dispose(); } if (llama) await llama.dispose(); })().catch(() => {});
  await Promise.race([dispose, new Promise(r => setTimeout(r, DISPOSE_BOUND_MS))]);
  process.exit(0);
}

process.on('disconnect', () => process.exit(0));
process.on('message', async (m) => {
  const test = process.env.BELAY_TEST_MODE === '1';
  try {
    if (m.op === 'close') return await close();
    if (m.op === 'ping') return reply(m.id, { pong: true, pid: process.pid, models: [...models.keys()] });
    if (test && m.op === 'env') return reply(m.id, { env: { ...process.env }, execArgv: process.execArgv });
    if (test && m.op === 'sleep') return serial(() => { process.send({ event: 'sleep_started', ref: m.id }); return new Promise(r => setTimeout(r, m.ms)); }).then(() => reply(m.id, { slept: m.ms })); // announces its start, so a test waits for the event and not a time
    if (test && m.op === 'hang') return; // never answers
    if (test && m.op === 'crash') return process.exit(m.code === undefined ? 3 : m.code);
    if (test && m.op === 'fail') throw Object.assign(new Error('injected child failure'), m.code === undefined ? {} : { code: m.code });
    if (m.op === 'vram') return reply(m.id, await vram(m.gpu));
    if (m.op === 'load') {
      const hb = setInterval(() => process.send({ id: m.id, progress: { heartbeat: true } }), HEARTBEAT_MS);
      try { return reply(m.id, await serial(() => load(m))); } finally { clearInterval(hb); }
    }
    if (m.op === 'embed') return reply(m.id, await serial(() => embed(m)));
    if (m.op === 'rank') return reply(m.id, await serial(() => rank(m, m.id)));
    throw bad(`unknown GPU op ${m.op}`, 'E_INTERNAL');
  } catch (e) { fail(m.id, e); }
});
