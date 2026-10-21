'use strict';
// gpu-worker-fake.cjs — a GPU child with no GPU and no runtime, speaking gpu-worker.cjs's protocol, so CI
// exercises gpu.cjs and gpu-probe.cjs. argv[2] is the JSON of { runtimeDir, fake } where `fake` describes the
// machine: { total, unified, base_used, devices, gpu, per_model: { <id>: bytes }, rank_ms_per_pair, flat_scores,
// load_fail, vram_fail }. Memory is in bytes. Vectors are deterministic; rank scores count words in common with
// the query (so the probe's sanity check passes) unless `flat_scores` is set. A document costs ceil(chars / 4) tokens
// and a rank takes rank_ms_per_token per token when that is set, else rank_ms_per_pair per pair. Also: load_ms,
// call_ms (an array: the time, in ms, of the 1st, 2nd... rank call, whatever its size; REPORTED, never slept or measured), virtual_ms (report the computed rank time without sleeping it),
// transient_mb (extra memory held during a load until the child has answered transient_samples vram requests, 3 by default, never for a wall-clock time), load_fail_msg, and marker (a file written when vram is
// first asked, so a test can tell what happened before it). Test ops as in gpu-worker.cjs.
// Announcements: a message with an `event` and no `id` (the client ignores it; a test listens on the child handle) at each state change:
// load_started, transient_held, transient_released, sleep_started, wedge_started, wedge_done.
// gate_chunks: after each chunk's progress line the rank waits for one `release` message (a test paces the progress lines and advances an injected clock between them).

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
let releases = 0;
const gateWaiters = [];
const gate = () => (releases > 0 ? (releases -= 1, Promise.resolve()) : new Promise(r => gateWaiters.push(r)));
let vramAnswered = 0;
const vramWaiters = [];
const announce = (event, extra) => process.send({ event, ...(extra || {}) });
const reply = (id, result) => process.send({ id, ok: true, result });
const fail = (id, e) => process.send({ id, ok: false, error: { code: e.code, message: e.message, detail: e.detail } });
const words = (s) => new Set(String(s).toLowerCase().match(/[a-z]{3,}/g) || []);

process.on('disconnect', () => process.exit(0));
process.on('message', async (m) => {
  try {
    if (m.op === 'close') return process.exit(0);
    if (m.op === 'ping') return reply(m.id, { pong: true, pid: process.pid, models: [...models.keys()] });
    if (m.op === 'env') return reply(m.id, { env: { ...process.env }, execArgv: process.execArgv });
    if (m.op === 'sleep') return serial(() => { announce('sleep_started', { ref: m.id }); return sleep(m.ms); }).then(() => reply(m.id, { slept: m.ms }));
    if (m.op === 'hang') return;
    if (m.op === 'release') { const w = gateWaiters.shift(); if (w) w(); else releases += 1; return; }
    if (m.op === 'wedge') return process.send({ event: 'wedge_started', ref: m.id }, () => { const end = Date.now() + m.ms; while (Date.now() < end); announce('wedge_done', { ref: m.id }); process.send({ id: m.id, ok: true, result: {} }); }); // blocks the loop once the announcement is written: no ping can be answered
    if (m.op === 'crash') return process.exit(m.code === undefined ? 3 : m.code);
    if (m.op === 'fail') throw Object.assign(new Error('injected child failure'), m.code === undefined ? {} : { code: m.code });
    if (m.op === 'vram') {
      if (F.vram_fail) throw new Error('Vulkan is not available');
      if (F.marker) fs.writeFileSync(F.marker, 'x');
      reply(m.id, { gpu: F.gpu, devices: F.devices, total: F.total, used, free: Math.max(0, F.total - used), unified: F.unified });
      vramAnswered += 1;
      for (const w of vramWaiters.splice(0)) w();
      return;
    }
    if (m.op === 'load') {
      return reply(m.id, await serial(async () => {
        announce('load_started', { ref: m.id, model: m.model });
        if (F.load_fail) throw new Error(F.load_fail_msg || 'failed to allocate device memory');
        if (models.has(m.model)) throw Object.assign(new Error(`${m.model} is already loaded`), { code: 'E_ARGS' });
        models.set(m.model, m);
        used += F.per_model[m.model] || 100 * 1048576;
        if (F.transient_mb) {
          used += F.transient_mb * 1048576;
          announce('transient_held', { mb: F.transient_mb });
          const until = vramAnswered + (F.transient_samples || 3);
          while (vramAnswered < until) await new Promise(r => vramWaiters.push(r));
          used -= F.transient_mb * 1048576;
          announce('transient_released');
        }
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
          if (scripted === undefined && !F.virtual_ms) await sleep(ms); // a scripted or virtual time is reported, never slept or measured
          for (const d of part) scores.push(F.flat_scores ? 0.5 : [...words(d)].filter(w => q.has(w)).length / 10);
          chunks.push({ n: part.length, tokens, ms });
          process.send({ id: m.id, progress: { done: scores.length, total: m.docs.length } });
          if (F.gate_chunks) await gate();
        }
        const reported = chunks.length && (F.call_ms || F.virtual_ms) ? chunks.reduce((s, k) => s + k.ms, 0) : null;
        return { scores, chunks, pair_tokens: cost, truncated, ms: reported !== null && (F.virtual_ms || F.call_ms[callNo] !== undefined) ? reported : Date.now() - t0 };
      }));
    }
    throw Object.assign(new Error(`unknown GPU op ${m.op}`), { code: 'E_INTERNAL' });
  } catch (e) { fail(m.id, e); }
});
