'use strict';
require('../helpers/tmp.cjs');
// memory-menu-imports.test.cjs — invariant 9 for the Memory menu: with a heavy model present and a heavy backlog to count, reading the menu (and the
// badge) loads no GPU client, worker or probe, no rerank or embed provider, no embedder and no embedding library. Runs in its own process, so
// require.cache is the evidence.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { core } = require('./helpers.cjs');

test('menu() and badge() with a fetched heavy embedder and notes behind it load no model-running module', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-menuimp-'));
  const keep = { c: process.env.BELAY_MODEL_CACHE, g: process.env.BELAY_GPU_RUNTIME };
  process.env.BELAY_MODEL_CACHE = path.join(root, 'models');
  process.env.BELAY_GPU_RUNTIME = path.join(root, 'gpu');
  try {
    const { GGUF_MODELS } = require('../../src/core/gguf-models.cjs');
    const e = GGUF_MODELS['Qwen/Qwen3-Embedding-4B-GGUF'];
    const dir = path.join(process.env.BELAY_MODEL_CACHE, `${e.id}@${e.sha}`);
    for (const f of e.files) { const p = path.join(dir, f.path); fs.mkdirSync(path.dirname(p), { recursive: true }); const fd = fs.openSync(p, 'w'); fs.ftruncateSync(fd, f.bytes); fs.closeSync(fd); }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ sha: e.sha }));
    const proj = path.join(root, 'proj');
    const data = path.join(proj, '.belay');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(proj, 'belay.config.json'), JSON.stringify({ memory: { project: 'acme', profile: 'gpu-balanced', routing: { reviewer: 'gpu-rerank' } } }));
    const { Store } = core('store.cjs');
    const store = new Store(path.join(data, 'memory.db'), { stamp: true });
    store.storeIn({ namespace: 'project/acme', worker_id: 'w', type: 'note', text: 'a note', title: 'a', run_id: 'r', embedding: [1, 0], embedding_model: 'fake', embedding_revision: 'r', dim: 2 });
    store.close();
    const MM = require('../../src/core/memory-menu.cjs');
    const C = require('../../src/cli/config.cjs');
    const AD = require('../../src/run/agent-defaults.cjs');
    const m = await MM.menu({ found: C.discover(proj), dataDir: data, agentTypes: AD.AGENT_KEYS });
    assert.strictEqual(m.models.find((x) => x.id === e.id).backlog, 1, 'the backlog was counted, from a copy');
    await MM.badge({ found: C.discover(proj), dataDir: data });
    const loaded = Object.keys(require.cache).map((k) => k.split('\\').join('/'));
    const bad = loaded.filter((k) => /\/src\/core\/(gpu|gpu-shared|gpu-probe|gpu-worker|gpu-rerank|gpu-chunk|rerank-provider|rerank-cpu|rerank-worker|rerank-stage|embed-provider|embed-worker|embedder|embedder-core|heavy-drain|heavy-embed|heavy-tier)\.cjs$/.test(k) || /node_modules\/(@huggingface|node-llama-cpp|onnxruntime)/.test(k));
    assert.deepStrictEqual(bad, [], 'no module that runs a model');
    assert.ok(loaded.some((k) => /\/src\/core\/gguf-models\.cjs$/.test(k)), 'the pure model table is what it reads');
  } finally {
    for (const [k, v] of [['BELAY_MODEL_CACHE', keep.c], ['BELAY_GPU_RUNTIME', keep.g]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
