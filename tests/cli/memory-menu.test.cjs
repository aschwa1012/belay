'use strict';
require('../helpers/tmp.cjs');
// memory-menu.test.cjs — `belay memory menu`, `belay embedder delete` and the probe's last reading (ADR 0050 amendment 3): the facts the panel's
// Memory menu draws, as a read that creates nothing; the backlog counted from a copy of a real store; a model in use never deleted.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { core } = require('../core/helpers.cjs');
const { menu } = require('../../src/core/memory-menu.cjs');
const { GGUF_MODELS } = require('../../src/core/gguf-models.cjs');
const { ONNX_RERANKER_TABLE } = require('../../src/core/onnx-rerankers.cjs');
const embedderExtra = require('../../src/cli/cmd-embedder-extra.cjs');
const P = require('../../src/core/gpu-probe.cjs');
const C = require('../../src/cli/config.cjs');
const AD = require('../../src/run/agent-defaults.cjs');

const { Store } = core('store.cjs');
const JINA = 'jinaai/jina-reranker-v1-tiny-en';
const NANO = 'onnx-community/voyage-4-nano-ONNX';
const E4 = 'Qwen/Qwen3-Embedding-4B-GGUF', E8 = 'Qwen/Qwen3-Embedding-8B-GGUF', R4 = 'giladgd/Qwen3-Reranker-4B-GGUF';
let root, env0;
const mk = (n) => { const d = path.join(root, n); fs.mkdirSync(d, { recursive: true }); return d.split('\\').join('/'); };
const writeConfig = (dir, memory) => fs.writeFileSync(path.join(dir, 'belay.config.json'), JSON.stringify({ memory }));
// A fetched model: its manifest and every file at the table's byte size (sparse zeros), which is all checkPresent stats.
function fakeFetch(cache, entry) {
  const dir = path.join(cache, `${entry.id}@${entry.sha}`);
  for (const f of entry.files) { const p = path.join(dir, f.path); fs.mkdirSync(path.dirname(p), { recursive: true }); const fd = fs.openSync(p, 'w'); fs.ftruncateSync(fd, f.bytes); fs.closeSync(fd); }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ sha: entry.sha }));
  return dir;
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-menu-'));
  env0 = { c: process.env.BELAY_MODEL_CACHE, g: process.env.BELAY_GPU_RUNTIME };
  process.env.BELAY_MODEL_CACHE = mk('models');
  process.env.BELAY_GPU_RUNTIME = mk('gpu');
});
after(() => {
  for (const [k, v] of [['BELAY_MODEL_CACHE', env0.c], ['BELAY_GPU_RUNTIME', env0.g]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(root, { recursive: true, force: true });
});

const build = (proj, dataDir = path.join(proj, '.belay')) => menu({ found: C.discover(proj), dataDir, agentTypes: AD.AGENT_KEYS });

test('with nothing set up: not probed, the runtime absent, every model to download, no backlog count and the defaults', async () => {
  const proj = mk('p1');
  fs.mkdirSync(path.join(proj, '.belay'));
  const m = await build(proj);
  assert.strictEqual(m.gpu.state, 'not_probed');
  assert.strictEqual(m.gpu.runtime.installed, false);
  assert.deepStrictEqual([m.levers.profile, m.levers.profile_cpu, m.levers.on_heavy_failure, m.levers.on_heavy_behind, m.levers.rerank_depth, m.levers.search_log_cap_mb], ['cpu-fast', 'cpu-fast', 'fallback', 'wait', 50, 500]);
  assert.deepStrictEqual(m.agent_types.main, ['orchestrator', 'reviewer', 'coder']);
  assert.ok(m.agent_types.advanced.includes('tester') && !m.agent_types.advanced.includes('coder'));
  assert.ok(m.models.every((x) => x.state === 'download'));
  assert.strictEqual(m.models.length, 1 + 3 + 2 + 2, 'nano, three GPU embedders, two CPU and two GPU rerankers');
  assert.strictEqual(m.models.find((x) => x.id === R4).vram_mb, GGUF_MODELS[R4].vram_mb_ref);
  assert.strictEqual(m.models.find((x) => x.id === R4).vram_source, 'reference');
  assert.strictEqual(m.models.find((x) => x.id === JINA).device, 'cpu');
  assert.strictEqual(m.models.find((x) => x.id === JINA).vram_mb, null);
  assert.deepStrictEqual([m.selected_embedder, m.behind, m.disk], [NANO, 0, { bytes: 0, models: 0 }]);
  assert.deepStrictEqual(m.profiles.map((p) => p.name), ['cpu-fast', 'cpu-rerank-light', 'cpu-rerank', 'gpu-rerank-fast', 'gpu-rerank', 'gpu-balanced', 'gpu-recall-max']);
  assert.strictEqual(m.profiles.find((p) => p.name === 'gpu-balanced').vram_mb, GGUF_MODELS[E4].vram_mb_ref + GGUF_MODELS[R4].vram_mb_ref);
  assert.strictEqual(m.profiles.find((p) => p.name === 'cpu-rerank').vram_mb, 0);
});

test('the read creates no file, and the built CLI prints the same JSON', () => {
  const proj = mk('p2');
  const before = fs.readdirSync(proj).join(',');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'src', 'cli', 'belay.cjs'), 'memory', 'menu', '--json'], { cwd: proj, encoding: 'utf8', env: process.env, windowsHide: true });
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.gpu.state, 'not_probed');
  assert.strictEqual(fs.readdirSync(proj).join(','), before, 'no data directory, no sidecar');
  assert.ok(!fs.existsSync(path.join(proj, '.belay')));
});

test('a probe\'s last reading is what the GPU line shows, and recorded peaks replace the reference VRAM', async () => {
  const proj = mk('p3');
  fs.mkdirSync(path.join(proj, '.belay'));
  const file = P.peaksFile();
  assert.strictEqual(P.recordLast(file, { ok: true, device: { name: 'RTX 5060' }, dedicated: { free_mb: 7000, total_mb: 7899 } }, [E4]), true);
  P.recordPeaks(file, { 'k|v': { model: R4, peak_mb: 3000, settings: {}, driver: 'x' } });
  assert.strictEqual(P.recordLast(file, { ok: false, refusal: { reason: 'x' } }, []), false, 'a probe that never reached the device records nothing');
  const m = await build(proj);
  assert.deepStrictEqual([m.gpu.state, m.gpu.device, m.gpu.free_mb, m.gpu.total_mb, m.gpu.ok], ['probed', 'RTX 5060', 7000, 7899, true]);
  assert.strictEqual(m.models.find((x) => x.id === R4).vram_mb, 3000);
  assert.strictEqual(m.models.find((x) => x.id === R4).vram_source, 'measured');
  assert.strictEqual(m.profiles.find((p) => p.name === 'gpu-rerank').vram_mb, 3000);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).entries['k|v'].peak_mb, 3000, 'the peaks survive the reading');
  fs.rmSync(file);
});

test('the backlog of the selected heavy embedder counts the project\'s notes with no vector under it, from a copy', async () => {
  const proj = mk('p4');
  const data = path.join(proj, '.belay');
  fs.mkdirSync(data);
  writeConfig(proj, { project: 'acme', profile: 'gpu-balanced', profile_cpu: 'cpu-fast' });
  fakeFetch(process.env.BELAY_MODEL_CACHE, GGUF_MODELS[E4]);
  const store = new Store(path.join(data, 'memory.db'), { stamp: true });
  for (const t of ['one', 'two', 'three']) {
    store.storeIn({ namespace: 'project/acme', worker_id: 'w', type: 'note', text: `${t} a note about ${t}`, title: t, run_id: 'r', embedding: [1, 0], embedding_model: 'fake', embedding_revision: 'r', dim: 2 });
  }
  store.close();
  P.recordLast(P.peaksFile(), { ok: true, device: { name: 'GPU' }, dedicated: { free_mb: 8000, total_mb: 8000 } }, [E4]);
  const m = await build(proj, data);
  const row = m.models.find((x) => x.id === E4);
  assert.deepStrictEqual([row.state, row.heavy, row.backlog, row.in_use], ['ready', true, 3, true]);
  assert.strictEqual(m.selected_embedder, E4, 'the GPU is probed ok, so the profile (not profile_cpu) is selected');
  assert.strictEqual(m.behind, 3);
  assert.strictEqual(m.models.find((x) => x.id === E8).backlog, null, 'not fetched and not in use: not counted');
  assert.strictEqual(m.disk.models, 1);
  assert.strictEqual(m.disk.bytes, GGUF_MODELS[E4].files[0].bytes);
  fs.rmSync(P.peaksFile());
  const cpuOnly = await build(proj, data);
  assert.deepStrictEqual([cpuOnly.selected_embedder, cpuOnly.behind], [NANO, 0], 'with no probed GPU the selected embedder is nano, so there is no badge');
  assert.strictEqual(cpuOnly.models.find((x) => x.id === E4).backlog, 3, 'the per-embedder count stays');
});

test('a project with no store says so instead of a zero', async () => {
  const proj = mk('p5');
  fs.mkdirSync(path.join(proj, '.belay'));
  writeConfig(proj, { project: 'acme', profile: 'gpu-balanced' });
  const m = await build(proj);
  assert.strictEqual(m.models.find((x) => x.id === E4).backlog, null);
  assert.match(m.backlog_reason, /no store yet/);
});

test('delete removes a fetched model nothing uses, and refuses one the settings use, nano, an absent one and an unknown id', async () => {
  const proj = mk('p6');
  fs.mkdirSync(path.join(proj, '.belay'));
  const ctx = (argv) => ({ argv: ['delete', ...argv], cwd: proj, json: true });
  const dir = fakeFetch(process.env.BELAY_MODEL_CACHE, ONNX_RERANKER_TABLE[JINA]);
  writeConfig(proj, { project: 'acme', profile_cpu: 'cpu-rerank-light' });
  const used = await embedderExtra.run(ctx([JINA]));
  assert.strictEqual(used.code, 1);
  assert.match(used.text, /in use by the current settings \(.*run \(CPU only\)/);
  assert.ok(fs.existsSync(dir), 'nothing was removed');
  assert.ok((await embedderExtra.run(ctx([NANO]))).json.in_use_by.includes('every note (the base)'));
  writeConfig(proj, { project: 'acme' });
  const ok = await embedderExtra.run(ctx([JINA]));
  assert.strictEqual(ok.code, 0, ok.text);
  assert.deepStrictEqual([ok.json.removed, ok.json.bytes, fs.existsSync(dir)], [true, ONNX_RERANKER_TABLE[JINA].files.reduce((n, f) => n + f.bytes, 0), false]);
  const gone = await embedderExtra.run(ctx([JINA]));
  assert.strictEqual(gone.code, 1);
  assert.match(gone.text, /not in the model cache/);
  assert.strictEqual((await embedderExtra.run(ctx(['no/such-model']))).code, 2);
  assert.strictEqual((await embedderExtra.run({ argv: ['delete'], cwd: proj, json: true })).code, 2);
});

test('a routing that uses a GPU model protects it from delete, and the saved routing\'s GPU models are listed', async () => {
  const proj = mk('p7');
  fs.mkdirSync(path.join(proj, '.belay'));
  writeConfig(proj, { project: 'acme', routing: { reviewer: 'gpu-rerank' }, routing_cpu: { reviewer: 'cpu-rerank' } });
  const m = await build(proj);
  assert.deepStrictEqual(m.routing_gpu_models, [R4]);
  assert.deepStrictEqual(m.models.find((x) => x.id === R4).in_use_by, ['reviewer']);
  assert.strictEqual(m.models.find((x) => x.id === 'Alibaba-NLP/gte-reranker-modernbert-base').in_use, true, 'the CPU pick is in use too');
  fakeFetch(process.env.BELAY_MODEL_CACHE, GGUF_MODELS[R4]);
  const r = await embedderExtra.run({ argv: ['delete', R4], cwd: proj, json: true });
  assert.strictEqual(r.code, 1);
  assert.match(r.text, /\(.*reviewer/);
});
