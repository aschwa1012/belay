'use strict';
// gpu-stub-runtime.cjs — a stand-in for the installed runtime, so the REAL gpu-worker.cjs runs in CI with no GPU:
// writeStubRuntime(dir) lays out dir/node_modules/node-llama-cpp/dist/index.js exporting a getLlama whose models
// tokenize at 4 characters a token, embed to [length, checksum, 1, 1] (normalised by the worker) and rank by
// substring. With { keepAlive: true } loadModel starts an interval, which stands in for the native threads that keep
// a real child's event loop alive: such a child ends with its owner only through the worker's own disconnect handler.
// loadDelayMs and rankDelayMs make a model load or a rank chunk slow.
// writeCache(cache, table) lays out the table's tiny model files where the cache looks for them.

const fs = require('node:fs');
const path = require('node:path');

function writeStubRuntime(dir, { keepAlive = false, loadDelayMs = 0, rankDelayMs = 0 } = {}) {
  const lib = path.join(dir, 'node_modules', 'node-llama-cpp', 'dist');
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, 'package.json'), '{"type":"commonjs"}');
  fs.writeFileSync(path.join(lib, 'index.js'), `
    const KEEP = ${keepAlive ? 'true' : 'false'}, LOAD_DELAY = ${Number(loadDelayMs)}, RANK_DELAY = ${Number(rankDelayMs)};
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    exports.getLlama = async (o) => ({ gpu: o.gpu, getGpuDeviceNames: async () => ['stub'], getVramState: async () => ({ total: 100, used: 10, free: 90, unifiedSize: 0 }),
      loadModel: async (m) => {
        if (LOAD_DELAY) await wait(LOAD_DELAY);
        if (KEEP) setInterval(() => {}, 1000);
        const tokenize = (t) => Array.from({ length: Math.ceil(String(t).length / 4) }, (_, i) => i);
        return { gpuLayers: m.gpuLayers === 'max' ? 9 : 0, size: 2097152, embeddingVectorSize: 4, tokenize, detokenize: (t) => 'x'.repeat(t.length * 4),
          createEmbeddingContext: async () => ({ calculateInputLength: (t) => tokenize(t).length, getEmbeddingFor: async (t) => ({ vector: [t.length, [...t].reduce((s, c) => s + c.charCodeAt(0), 0) % 997, 1, 1] }), dispose: async () => {} }),
          createRankingContext: async (o) => ({ batchSize: o.batchSize, rankAll: async (q, d) => { if (RANK_DELAY) await wait(RANK_DELAY); (globalThis.__calls = globalThis.__calls || []).push(d.length); return d.map((x) => (x.includes(q) ? 1 : 0)); }, dispose: async () => {} }),
          dispose: async () => {} };
      }, dispose: async () => {} });
  `);
  return dir;
}

function writeCache(cache, table) {
  for (const e of Object.values(table)) {
    const dir = path.join(cache, `${e.id}@${e.sha}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, e.files[0].path), '0123456789');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ sha: e.sha }));
  }
}

module.exports = { writeStubRuntime, writeCache };
