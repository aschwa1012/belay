'use strict';
// gpu-worker-fake.cjs — a GPU child with no GPU and no runtime, speaking gpu-worker.cjs's protocol, so CI
// exercises gpu.cjs and gpu-probe.cjs. argv[2] is the JSON of { runtimeDir, fake } where `fake` describes the
// machine: { total, unified, base_used, devices, gpu, per_model: { <id>: bytes }, rank_ms_per_pair, flat_scores,
// load_fail, vram_fail }. Memory is in bytes. Vectors are deterministic; rank scores count words in common with
// the query (so the probe's sanity check passes) unless `flat_scores` is set. A document costs ceil(chars / 4) tokens
// and a rank takes rank_ms_per_token per token when that is set, else rank_ms_per_pair per pair. Also: load_ms,
// call_ms (an array: the time, in ms, of the 1st, 2nd... rank call, whatever its size), transient_mb (extra memory held only while a load runs), load_fail_msg, and marker (a file written when vram is
// first asked, so a test can tell what happened before it). Test ops as in gpu-worker.cjs.

const fs = require('node:fs');
const path = require('node:path');
const { planChunks, docCap, RANK_TEMPLATE_TOKENS } = require(path.join(__dirname, '..', '..', '..', 'src', 'core', 'gpu-chunk.cjs'));
const opts = JSON.parse(process.argv[2] || '{}');
const F = { total: 25526403072, unified: 17243701248, base_used: 1667490816, devices: ['AMD Radeon(TM) Graphics', 'NVIDIA GeForce RTX 5060 Laptop GPU'], gpu: 'vulkan', per_model: {}, rank_ms_per_pair: 5, ...(opts.fake || {}) };
const models = new Map();
let used = F.base_used;
let rankCalls = 0;
let chain = Promise.resolve();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const serial = (fn) => { const r = chain.then(fn); chain = r.catch(() => {}); return r; };
const reply = (id, result) => process.send({ id, ok: true, result });
const fail = (id, e) => process.send({ id, ok: false, error: { code: e.code, message: e.message, detail: e.detail } });
const words = (s) => new Set(String(s).toLowerCase().match(/[a-z]{3,}/g) || []);

process.on('disconnect', () => process.exit(0));
process.on('message', async (m) => {
  try {
    if (m.op === 'close') return process.exit(0);
    if (m.op === 'ping') return reply(m.id, { pong: true, pid: process.pid, models: [...models.keys()] });
    if (m.op === 'env') return reply(m.id, { env: { ...process.env }, execArgv: process.execArgv });
    if (m.op === 'sleep') return serial(() => sleep(m.ms)).then(() => reply(m.id, { slept: m.ms }));
    if (m.op === 'hang') return;
    if (m.op === 'wedge') { setTimeout(() => process.send({ id: m.id, ok: true, result: {} }), 0); const end = Date.now() + m.ms; while (Date.now() < end); return; } // blocks the loop: no ping can be answered
    if (m.op === 'crash') return process.exit(m.code === undefined ? 3 : m.code);
    if (m.op === 'fail') throw Object.assign(new Error('injected child failure'), m.code === undefined ? {} : { code: m.code });
    if (m.op === 'vram') {
      if (F.vram_fail) throw new Error('Vulkan is not available');
      if (F.marker) fs.writeFileSync(F.marker, 'x');
      return reply(m.id, { gpu: F.gpu, devices: F.devices, total: F.total, used, free: Math.max(0, F.total - used), unified: F.unified });
    }
    if (m.op === 'load') {
      return reply(m.id, await serial(async () => {
        if (F.load_fail) throw new Error(F.load_fail_msg || 'failed to allocate device memory');
        if (models.has(m.model)) throw Object.assign(new Error(`${m.model} is already loaded`), { code: 'E_ARGS' });
        models.set(m.model, m);
        used += F.per_model[m.model] || 100 * 1048576;
        if (F.transient_mb) { used += F.transient_mb * 1048576; await sleep(F.load_ms || 400); used -= F.transient_mb * 1048576; }
        return { model: m.model, batch_size: m.batchSize || null, load_ms: 1, gpu_layers: 99, native_dims: m.kind === 'embedder' ? m.dims : null, size_mb: 1 };
      }));
    }
    if (m.op === 'embed') {
      const e = models.get(m.model);
      if (!e) throw Object.assign(new Error(`the GPU child has not loaded ${m.model}`), { code: 'E_MODEL_ABSENT' });
      const text = (m.as === 'query' ? e.queryPrompt || '' : '') + m.text;
      const v = Array.from({ length: e.dims }, (_, i) => Math.sin(i + text.length) + (i === 0 ? 2 : 0));
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      return reply(m.id, { embedding: v.map(x => x / n), dim: v.length, tokens: text.length, ms: 1 });
    }
    if (m.op === 'rank') {
      return reply(m.id, await serial(async () => {
        const e = models.get(m.model);
        if (!e) throw Object.assign(new Error(`the GPU child has not loaded ${m.model}`), { code: 'E_MODEL_ABSENT' });
        const q = words(m.query), scores = [], chunks = [];
        const qt = Math.ceil(m.query.length / 4), cap = docCap(e.contextSize || 2048, qt);
        let truncated = 0;
        const cost = m.docs.map((d) => { const t = Math.ceil(d.length / 4); if (t > cap) truncated += 1; return Math.min(t, cap) + qt + RANK_TEMPLATE_TOKENS; });
        const plan = planChunks(cost, { maxPairs: Math.max(1, Math.floor(m.chunk || m.docs.length)), maxTokens: m.chunkTokens || Infinity });
        const t0 = Date.now();
        const callNo = rankCalls++;
        for (const [from, to] of plan) {
          const part = m.docs.slice(from, to), tokens = cost.slice(from, to).reduce((x, y) => x + y, 0);
          const scripted = F.call_ms && plan.length === 1 ? F.call_ms[callNo] : undefined;
          const ms = scripted !== undefined ? scripted : F.rank_ms_per_token ? F.rank_ms_per_token * tokens : F.rank_ms_per_pair * part.length;
          await sleep(ms);
          for (const d of part) scores.push(F.flat_scores ? 0.5 : [...words(d)].filter(w => q.has(w)).length / 10);
          chunks.push({ n: part.length, tokens, ms });
          process.send({ id: m.id, progress: { done: scores.length, total: m.docs.length } });
        }
        return { scores, chunks, pair_tokens: cost, truncated, ms: Date.now() - t0 };
      }));
    }
    throw Object.assign(new Error(`unknown GPU op ${m.op}`), { code: 'E_INTERNAL' });
  } catch (e) { fail(m.id, e); }
});
