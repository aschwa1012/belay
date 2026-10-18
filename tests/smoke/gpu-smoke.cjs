'use strict';
// gpu-smoke.cjs — a real run of the GPU tier on this machine. NOT part of npm test: it installs the runtime with
// npm, loads real models on the GPU and needs the bench GGUF files. Usage: node tests/smoke/gpu-smoke.cjs <bench models dir> <receipt dir>
// The cache is a sandbox directory (BELAY_MODEL_CACHE); the bench files are hard-linked (or copied) into it and
// must pass the sha256 verify of `belay embedder verify --gpu --model` before anything loads.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const [BENCH, OUT] = [process.argv[2], process.argv[3]];
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-gpu-smoke-')).split(path.sep).join('/');
process.env.BELAY_MODEL_CACHE = `${SANDBOX}/models`;
delete process.env.BELAY_GPU_RUNTIME;
const { GGUF_MODELS } = require(path.join(ROOT, 'src/core/gguf-models.cjs'));
const embedderCmd = require(path.join(ROOT, 'src/cli/cmd-embedder.cjs'));
const K = require(path.join(ROOT, 'src/core/model-cache.cjs'));
const R = require(path.join(ROOT, 'src/core/gpu-runtime.cjs'));
const P = require(path.join(ROOT, 'src/core/gpu-probe.cjs'));
const { GpuClient } = require(path.join(ROOT, 'src/core/gpu.cjs'));

const LOCAL = { // bench file name per table id
  'Qwen/Qwen3-Embedding-0.6B-GGUF': 'Qwen3-Embedding-0.6B-Q8_0.gguf',
  'Qwen/Qwen3-Embedding-4B-GGUF': 'Qwen3-Embedding-4B-Q4_K_M.gguf',
  'ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF': 'qwen3-reranker-0.6b-q8_0.gguf',
  'giladgd/Qwen3-Reranker-4B-GGUF': 'Qwen3-Reranker-4B-giladgd-Q4_K_M.gguf',
};
const receipt = { invocation: `node ${process.argv.slice(1).join(' ')}`, started: new Date().toISOString(), node: process.version, sandbox: SANDBOX, steps: [] };
const step = async (name, fn) => { const t0 = Date.now(); try { const r = await fn(); receipt.steps.push({ name, ok: true, ms: Date.now() - t0, ...r }); return r; } catch (e) { receipt.steps.push({ name, ok: false, ms: Date.now() - t0, error: e.message }); throw e; } };

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
    const r = await embedderCmd.run({ argv: ['fetch', '--gpu'], emit: s => process.stdout.write(s) });
    if (r.code !== 0) throw new Error(r.text);
    return { exit: r.code, dir: r.json.dir, versions: r.json.versions, installed_mib: r.json.mb, bytes: r.json.bytes, npm_ms: r.json.npm_ms };
  });
  await step('belay embedder verify --gpu', async () => {
    const r = await embedderCmd.run({ argv: ['verify', '--gpu'] });
    if (r.code !== 0) throw new Error(r.text);
    return { exit: r.code };
  });
  let notes = [];
  try { notes = Object.values(JSON.parse(fs.readFileSync('notes.json', 'utf8'))).map(n => n.text); } catch { /* synthetic below */ }
  while (notes.length < 50) notes.push(`synthetic note ${notes.length}: the owner holds the store and the worker adapter holds its workers`);
  notes = notes.slice(0, 50).map(t => String(t).slice(0, 600));
  const sets = { 'sets 0.6B + 0.6B': ['Qwen/Qwen3-Embedding-0.6B-GGUF', 'ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF'], 'sets 4B + 4B': ['Qwen/Qwen3-Embedding-4B-GGUF', 'giladgd/Qwen3-Reranker-4B-GGUF'] };
  for (const [name, models] of Object.entries(sets)) {
    const probe = await step(`probe ${name}`, async () => { const r = await P.probe({ models }); return { result: r }; });
    if (!probe.result.ok) throw new Error(`probe refused: ${JSON.stringify(probe.result.refusal)}`);
    await step(`use ${name}: embed one query, rank 50 notes`, async () => {
      const c = new GpuClient().start();
      try {
        const [emb, rr] = models;
        const loadMs = {};
        for (const m of models) { const t = Date.now(); await c.load(m); loadMs[m] = Date.now() - t; }
        const before = await c.vram();
        const t1 = Date.now();
        const q = await c.embed(emb, 'how does the store owner get elected without a daemon', { as: 'query' });
        const embedMs = Date.now() - t1;
        const chunk = probe.result.rerank[rr].chunk;
        const t2 = Date.now();
        const r = await c.rank(rr, 'how does the store owner get elected without a daemon', notes, { chunk });
        const rankMs = Date.now() - t2;
        const ping = await c.ping();
        const order = r.scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]);
        return { load_ms: loadMs, embed_ms: embedMs, embed_dim: q.dim, rank_pairs: notes.length, rank_chunk: chunk, rank_ms: rankMs, max_chunk_ms: Math.max(...r.chunks.map(x => x.ms)), chunks: r.chunks.length, top3_note_index: order.slice(0, 3).map(x => x[1]), top3_scores: order.slice(0, 3).map(x => +x[0].toFixed(4)), flat: order[0][0] - order[order.length - 1][0] < 1e-3, vram_used_mb_after_load: +(before.used / 1048576).toFixed(1), ping_ms: ping.ms, child_pid: c.pid };
      } finally { await c.close(); }
    });
  }
  receipt.runtime_dir_bytes = receipt.steps.find(s => s.name === 'belay embedder fetch --gpu').bytes;
  receipt.exit = 0;
})().catch((e) => { receipt.exit = 1; receipt.error = e.message; }).finally(() => {
  receipt.finished = new Date().toISOString();
  fs.mkdirSync(OUT, { recursive: true });
  const f = path.join(OUT, `gpu-smoke-${receipt.started.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(f, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`receipt ${f} exit ${receipt.exit}`);
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { console.log(`sandbox left at ${SANDBOX}: ${e.message}`); }
  process.exit(receipt.exit);
});
