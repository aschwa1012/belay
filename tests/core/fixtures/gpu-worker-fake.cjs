'use strict';
// gpu-worker-fake.cjs — a GPU child with no GPU and no runtime, speaking gpu-worker.cjs's protocol, so CI
// exercises gpu.cjs and gpu-probe.cjs. argv[2] is the JSON of { runtimeDir, fake } where `fake` describes the
// machine: { total, unified, base_used, devices, gpu, per_model: { <id>: bytes }, rank_ms_per_pair, flat_scores,
// load_fail, vram_fail }. Memory is in bytes. Vectors are deterministic; rank scores count words in common with
// the query (so the probe's sanity check passes) unless `flat_scores` is set. Test ops as in gpu-worker.cjs.

const opts = JSON.parse(process.argv[2] || '{}');
const F = { total: 25526403072, unified: 17243701248, base_used: 1667490816, devices: ['AMD Radeon(TM) Graphics', 'NVIDIA GeForce RTX 5060 Laptop GPU'], gpu: 'vulkan', per_model: {}, rank_ms_per_pair: 5, ...(opts.fake || {}) };
const models = new Map();
let used = F.base_used;
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
      return reply(m.id, { gpu: F.gpu, devices: F.devices, total: F.total, used, free: Math.max(0, F.total - used), unified: F.unified });
    }
    if (m.op === 'load') {
      return reply(m.id, await serial(async () => {
        if (F.load_fail) throw new Error('failed to allocate device memory');
        if (models.has(m.model)) throw Object.assign(new Error(`${m.model} is already loaded`), { code: 'E_ARGS' });
        models.set(m.model, m);
        used += F.per_model[m.model] || 100 * 1048576;
        return { model: m.model, load_ms: 1, gpu_layers: 99, native_dims: m.kind === 'embedder' ? m.dims : null, size_mb: 1 };
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
        const chunk = Math.max(1, Math.floor(m.chunk || e.chunk || m.docs.length));
        const q = words(m.query), scores = [], chunks = [];
        const t0 = Date.now();
        for (let i = 0; i < m.docs.length; i += chunk) {
          const part = m.docs.slice(i, i + chunk);
          await sleep(F.rank_ms_per_pair * part.length);
          for (const d of part) scores.push(F.flat_scores ? 0.5 : [...words(d)].filter(w => q.has(w)).length / 10);
          chunks.push({ n: part.length, ms: F.rank_ms_per_pair * part.length });
          process.send({ id: m.id, progress: { done: scores.length, total: m.docs.length } });
        }
        return { scores, chunks, chunk, ms: Date.now() - t0 };
      }));
    }
    throw Object.assign(new Error(`unknown GPU op ${m.op}`), { code: 'E_INTERNAL' });
  } catch (e) { fail(m.id, e); }
});
