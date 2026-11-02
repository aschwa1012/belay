'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// gpu-smoke.cjs — a real run of the GPU tier on this machine. NOT part of npm test: it installs the runtime with
// npm, loads real models on the GPU and needs the bench GGUF files.
// Usage: node tests/smoke/gpu-smoke.cjs <bench models dir> <receipt dir> <notes.json>
// <notes.json> is a JSON file of notes; it is required.
// The cache is a sandbox directory (BELAY_MODEL_CACHE); the bench files are hard-linked (or copied) into it and
// must pass the sha256 verify of `belay embedder verify --gpu --model` before anything loads. The receipt holds no
// absolute path of this machine: the sandbox, the repository, the bench, the temp and home directories are replaced
// by placeholders.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const [BENCH, OUT, NOTES] = [process.argv[2], process.argv[3], process.argv[4]];
if (!BENCH || !OUT || !NOTES) { console.error('usage: node tests/smoke/gpu-smoke.cjs <bench models dir> <receipt dir> <notes.json>'); process.exit(2); }
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-gpu-smoke-')).split(path.sep).join('/');
process.env.BELAY_MODEL_CACHE = `${SANDBOX}/models`;
delete process.env.BELAY_GPU_RUNTIME;
const { GGUF_MODELS } = require(path.join(ROOT, 'src/core/gguf-models.cjs'));
const embedderCmd = require(path.join(ROOT, 'src/cli/cmd-embedder.cjs'));
const K = require(path.join(ROOT, 'src/core/model-cache.cjs'));
const R = require(path.join(ROOT, 'src/core/gpu-runtime.cjs'));
const P = require(path.join(ROOT, 'src/core/gpu-probe.cjs'));
const { GpuClient } = require(path.join(ROOT, 'src/core/gpu.cjs'));
const REF = require(path.join(ROOT, 'tests/core/fixtures/qwen3-query-ref.json'));

const LOCAL = { // bench file name per table id
  'Qwen/Qwen3-Embedding-0.6B-GGUF': 'Qwen3-Embedding-0.6B-Q8_0.gguf',
  'Qwen/Qwen3-Embedding-4B-GGUF': 'Qwen3-Embedding-4B-Q4_K_M.gguf',
  'ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF': 'qwen3-reranker-0.6b-q8_0.gguf',
  'giladgd/Qwen3-Reranker-4B-GGUF': 'Qwen3-Reranker-4B-giladgd-Q4_K_M.gguf',
};
const receipt = { invocation: `node ${process.argv.slice(1).join(' ')}`, started: new Date().toISOString(), node: process.version, observations: [], steps: [] };
const step = async (name, fn) => { const t0 = Date.now(); try { const r = await fn(); receipt.steps.push({ name, ok: true, ms: Date.now() - t0, ...r }); return r; } catch (e) { receipt.steps.push({ name, ok: false, ms: Date.now() - t0, error: e.message }); throw e; } };
const cosine = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));

// Every absolute path of this machine becomes a placeholder, in both slash styles and as escaped in JSON.
function scrub(text) {
  const subs = [[SANDBOX, '<sandbox>'], [ROOT, '<repo>'], [path.resolve(BENCH), '<bench>'], [os.tmpdir(), '<tmp>'], [os.homedir(), '<home>']];
  let out = text;
  for (const [from, to] of subs.sort((a, b) => b[0].length - a[0].length)) {
    const fwd = from.split('\\').join('/');
    for (const v of new Set([from, fwd, from.split('\\').join('\\\\')])) out = out.split(v).join(to);
  }
  return out;
}

(async () => {
  for (const [id, file] of Object.entries(LOCAL)) {
    await step(`place ${id}`, async () => {
      const e = GGUF_MODELS[id], dir = K.modelDir(e), dest = path.join(dir, e.files[0].path);
      fs.mkdirSync(dir, { recursive: true });
      try { fs.linkSync(path.join(BENCH, file), dest); } catch { fs.copyFileSync(path.join(BENCH, file), dest); }
      fs.writeFileSync(path.join(dir, K.MANIFEST), JSON.stringify({ id, sha: e.sha }));
      return { file, bytes: fs.statSync(dest).size };
    });
    await step(`belay embedder verify --gpu --model ${id}`, async () => {
      const r = await embedderCmd.run({ argv: ['verify', '--gpu', '--model', id] });
      if (r.code !== 0) throw new Error(r.text);
      return { exit: r.code, files: r.json.files.map(f => ({ path: f.path, bytes: f.bytes, sha256: f.sha256, ok: f.ok })) };
    });
  }
  await step('belay embedder fetch --gpu', async () => {
    const r = await embedderCmd.run({ argv: ['fetch', '--gpu'], emit: s => process.stdout.write(scrub(s)) });
    if (r.code !== 0) throw new Error(r.text);
    return { exit: r.code, versions: r.json.versions, installed_mib: r.json.mb, files: r.json.files, bytes: r.json.bytes, npm_ms: r.json.npm_ms, total_ms: r.json.total_ms };
  });
  await step('belay embedder verify --gpu (deep: every file hashed)', async () => {
    const t0 = Date.now(); const r = await embedderCmd.run({ argv: ['verify', '--gpu'] });
    if (r.code !== 0) throw new Error(r.text);
    return { exit: r.code, deep_check_ms: Date.now() - t0 };
  });
  await step('light check (file set and sizes, run at every use of the runtime)', async () => {
    const times = [];
    for (let i = 0; i < 5; i += 1) { const t = process.hrtime.bigint(); const c = R.check(); times.push(Number(process.hrtime.bigint() - t) / 1e6); if (!c.ok) throw new Error(c.problems.join('; ')); }
    return { light_check_ms: times.map(x => Math.round(x * 10) / 10), light_check_min_ms: Math.round(Math.min(...times) * 10) / 10 };
  });
  let notes = [];
  try { notes = Object.values(JSON.parse(fs.readFileSync(NOTES, 'utf8'))).map(n => n.text); } catch { /* synthetic below */ }
  while (notes.length < 50) notes.push(`synthetic note ${notes.length}: the owner holds the store and the worker adapter holds its workers`);
  notes = notes.slice(0, 50).map(t => String(t).slice(0, 600));
  const sets = { 'sets 0.6B + 0.6B': ['Qwen/Qwen3-Embedding-0.6B-GGUF', 'ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF'], 'sets 4B + 4B': ['Qwen/Qwen3-Embedding-4B-GGUF', 'giladgd/Qwen3-Reranker-4B-GGUF'] };
  for (const [name, models] of Object.entries(sets)) {
    const smiBefore = await P.defaultSmi(); // before any GPU child exists
    const probe = await step(`probe ${name}`, async () => { const r = await P.probe({ models }); return { result: r }; });
    if (!probe.result.ok) throw new Error(`probe refused: ${JSON.stringify(probe.result.refusal)}`);
    const over = Math.max(...Object.values(probe.result.peaks).map(p => p.peak_mb - p.steady_mb));
    receipt.observations.push(`${name}: ${over > 1 ? `a transient peak ${over} MiB above steady growth was seen` : 'no transient peak above steady-state growth was observed while the loads and batches ran'} (largest peak minus steady, ${Math.round(over * 10) / 10} MiB)`);
    receipt.observations.push(`${name}: free dedicated memory read before the child started was ${smiBefore && smiBefore.free_mb} MiB and the probe's, read after the child initialised Vulkan, was ${probe.result.free_mb} MiB (${smiBefore && smiBefore.free_mb === probe.result.free_mb ? 'equal: on this host nvidia-smi under WDDM shows no overhead from an idle Vulkan device' : 'different'})`);
    await step(`use ${name}: embed one query, rank 50 notes`, async () => {
      const c = new GpuClient().start();
      try {
        const [emb, rr] = models, rer = probe.result.rerank[rr];
        const loadMs = {};
        for (const m of models) { const t = Date.now(); await c.load(m, m === rr ? { batchSize: rer.batch_size } : {}); loadMs[m] = Date.now() - t; }
        const before = await c.vram();
        const t1 = Date.now();
        const q = await c.embed(emb, REF.query, { as: 'query' });
        const embedMs = Date.now() - t1;
        const t2 = Date.now();
        const r = await c.rank(rr, REF.query, notes, { chunkTokens: rer.chunk_tokens });
        const rankMs = Date.now() - t2;
        const ping = await c.ping();
        const order = r.scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]);
        const out = { load_ms: loadMs, embed_ms: embedMs, embed_dim: q.dim, rank_pairs: notes.length, rank_chunk_tokens: rer.chunk_tokens, rank_ms: rankMs, chunks: r.chunks.length, chunk_ms: r.chunks.map(x => x.ms), chunk_tokens: r.chunks.map(x => x.tokens), max_chunk_ms: Math.max(...r.chunks.map(x => x.ms)), truncated_notes: r.truncated, top3_note_index: order.slice(0, 3).map(x => x[1]), top3_scores: order.slice(0, 3).map(x => +x[0].toFixed(4)), flat: order[0][0] - order[order.length - 1][0] < 1e-3, vram_used_mb_after_load: +(before.used / 1048576).toFixed(1), ping_ms: ping.ms };
        if (emb === 'Qwen/Qwen3-Embedding-0.6B-GGUF') { out.cosine_to_cpu_reference = +cosine(q.embedding, REF.vector).toFixed(6); if (!(out.cosine_to_cpu_reference >= 0.999)) throw new Error(`the GPU query vector disagrees with the CPU reference: cosine ${out.cosine_to_cpu_reference}`); }
        return out;
      } finally { await c.close(); }
    });
  }
  // A document of about 1,500 tokens against a context of 2,048: does llama.cpp split one rank sequence across decodes when
  // the batch is 512? Ranked at batchSize 512 and at batchSize equal to the context, the scores must agree.
  for (const rr of ['ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF', 'giladgd/Qwen3-Reranker-4B-GGUF']) {
    await step(`long document at batchSize 512 against 2048: ${rr}`, async () => {
      const long1 = notes.join(' ').slice(0, 6200), long2 = notes.slice(25).join(' ').slice(0, 6000);
      const docs = [long1, long2, 'The owner is elected on demand by whoever needs the store and dies with them.'];
      const run = async (batchSize) => {
        const c = new GpuClient().start();
        try { await c.load(rr, { batchSize }); const t = Date.now(); const r = await c.rank(rr, REF.query, docs); return { scores: r.scores, pair_tokens: r.pair_tokens, truncated: r.truncated, chunks: r.chunks.length, ms: Date.now() - t }; } finally { await c.close(); }
      };
      const small = await run(512), big = await run(2048);
      const maxdiff = Math.max(...small.scores.map((x, i) => Math.abs(x - big.scores[i])));
      if (!(maxdiff < 0.01)) throw new Error(`scores differ by ${maxdiff} between batchSize 512 and 2048: cap documents at batchSize minus the query and template tokens`);
      return { doc_tokens: small.pair_tokens, truncated: small.truncated, scores_512: small.scores.map(x => +x.toFixed(5)), scores_2048: big.scores.map(x => +x.toFixed(5)), max_abs_difference: +maxdiff.toFixed(5), tolerance: 0.01, ms_512: small.ms, ms_2048: big.ms, verdict: 'equal within tolerance: llama.cpp splits a long rank sequence across decodes; the context-sized document cap stands' };
    });
  }
  receipt.runtime_dir_bytes = receipt.steps.find(s => s.name === 'belay embedder fetch --gpu').bytes;
  receipt.exit = 0;
})().catch((e) => { receipt.exit = 1; receipt.error = e.message; }).finally(() => {
  receipt.finished = new Date().toISOString();
  fs.mkdirSync(OUT, { recursive: true });
  const f = path.join(OUT, `gpu-smoke-${receipt.started.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(f, scrub(`${JSON.stringify(receipt, null, 2)}\n`));
  console.log(`receipt written, exit ${receipt.exit}`);
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { console.log(`sandbox left behind: ${scrub(e.message)}`); }
  process.exit(receipt.exit);
});
