'use strict';
require('../helpers/tmp.cjs');
// memory-menu-delete.test.cjs — `belay embedder delete` against live runs, a refused config, an unreadable store and a half-failed removal, and the
// menu's selected embedder (the runtime must be sound now) and badge read (ADR 0050 amendment 3).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { core } = require('../core/helpers.cjs');
const MM = require('../../src/core/memory-menu.cjs');
const { GGUF_MODELS } = require('../../src/core/gguf-models.cjs');
const { ONNX_RERANKER_TABLE } = require('../../src/core/onnx-rerankers.cjs');
const embedderExtra = require('../../src/cli/cmd-embedder-extra.cjs');
const P = require('../../src/core/gpu-probe.cjs');
const R = require('../../src/core/gpu-runtime.cjs');
const C = require('../../src/cli/config.cjs');
const AD = require('../../src/run/agent-defaults.cjs');

const { Store } = core('store.cjs');
const JINA = 'jinaai/jina-reranker-v1-tiny-en';
const NANO = 'onnx-community/voyage-4-nano-ONNX';
const E4 = 'Qwen/Qwen3-Embedding-4B-GGUF', R4 = 'giladgd/Qwen3-Reranker-4B-GGUF';
let root, env0;
const mk = (n) => { const d = path.join(root, n); fs.mkdirSync(d, { recursive: true }); return d.split('\\').join('/'); };
const writeConfig = (dir, memory) => fs.writeFileSync(path.join(dir, 'belay.config.json'), JSON.stringify({ memory }));
function fakeFetch(cache, entry) {
  const dir = path.join(cache, `${entry.id}@${entry.sha}`);
  for (const f of entry.files) { const p = path.join(dir, f.path); fs.mkdirSync(path.dirname(p), { recursive: true }); const fd = fs.openSync(p, 'w'); fs.ftruncateSync(fd, f.bytes); fs.closeSync(fd); }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ sha: entry.sha }));
  return dir;
}
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-menudel-'));
  env0 = { c: process.env.BELAY_MODEL_CACHE, g: process.env.BELAY_GPU_RUNTIME };
  process.env.BELAY_MODEL_CACHE = mk('models');
  process.env.BELAY_GPU_RUNTIME = mk('gpu');
});
after(() => {
  for (const [k, v] of [['BELAY_MODEL_CACHE', env0.c], ['BELAY_GPU_RUNTIME', env0.g]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(root, { recursive: true, force: true });
});

const build = (proj, dataDir) => MM.menu({ found: C.discover(proj), dataDir, agentTypes: AD.AGENT_KEYS });
// The runtime check reads a real installed tree; a test says what it answers.
const withRuntime = async (ok, fn) => {
  const keep = R.check;
  R.check = () => ({ ok, dir: 'x', versions: {}, problems: ok ? [] : ['the GPU runtime is not installed (x)'], command: 'belay embedder fetch --gpu', manifest_version: '0' });
  try { return await fn(); } finally { R.check = keep; }
};
const liveStore = (data, runs) => {
  const store = new Store(path.join(data, 'memory.db'), { stamp: true });
  for (const r of runs) {
    const pin = { routing: { run: { embedder: NANO, reranker: R4, profile: 'gpu-rerank' }, tiers: { reviewer: { embedder: E4, reranker: R4 } } } };
    store.p('INSERT INTO run(id, epoch, adapter_pid, started_at, ended_at, retrieval_routing, written_at, written_by) VALUES (?, 1, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.pid, Date.now(), r.ended ? Date.now() : null, JSON.stringify(pin), Date.now(), 't');
  }
  store.close();
};

test('delete refuses a model the pinned routing of a LIVE run names, naming the run, and lets go of an ended run or a dead adapter', async () => {
  const proj = mk('p8');
  const data = path.join(proj, '.belay');
  fs.mkdirSync(data);
  writeConfig(proj, { project: 'acme' });
  const dir = fakeFetch(process.env.BELAY_MODEL_CACHE, GGUF_MODELS[R4]);
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  liveStore(data, [{ id: 'r-live', pid: process.pid }, { id: 'r-ended', pid: process.pid, ended: true }, { id: 'r-dead', pid: dead }]);
  const m = await build(proj, data);
  assert.deepStrictEqual(m.live_runs, ['r-live']);
  assert.deepStrictEqual(m.models.find((x) => x.id === R4).in_use_by, ['run r-live'], 'the menu reads the same source, so the panel shows it in use');
  assert.strictEqual(m.models.find((x) => x.id === E4).in_use, true);
  const r = await embedderExtra.run({ argv: ['delete', R4], cwd: proj, dataDir: data, json: true });
  assert.strictEqual(r.code, 1);
  assert.match(r.text, /this project's settings or runs \(run r-live/);
  assert.ok(fs.existsSync(dir), 'nothing was removed');
  const db = path.join(data, 'memory.db');
  for (const f of [db, `${db}-wal`, `${db}-shm`]) fs.rmSync(f, { force: true });
  liveStore(data, [{ id: 'r-ended', pid: process.pid, ended: true }, { id: 'r-dead', pid: dead }]);
  assert.strictEqual((await embedderExtra.run({ argv: ['delete', R4], cwd: proj, dataDir: data, json: true })).code, 0);
});

test('delete refuses when the config memory block is refused, naming why, and when the store cannot be read', async () => {
  const proj = mk('p9');
  const data = path.join(proj, '.belay');
  fs.mkdirSync(data);
  writeConfig(proj, { project: 'acme', profile: 'nope' });
  fakeFetch(process.env.BELAY_MODEL_CACHE, ONNX_RERANKER_TABLE[JINA]);
  const r = await embedderExtra.run({ argv: ['delete', JINA], cwd: proj, dataDir: data, json: true });
  assert.strictEqual(r.code, 1);
  assert.match(r.text, /memory block is refused \(memory.profile must be one of/);
  assert.ok((await build(proj, data)).config_error);
  writeConfig(proj, { project: 'acme' });
  fs.writeFileSync(path.join(data, 'memory.db'), 'this is not a database');
  const bad = await embedderExtra.run({ argv: ['delete', JINA], cwd: proj, dataDir: data, json: true });
  assert.strictEqual(bad.code, 1);
  assert.match(bad.text, /store could not be read/);
  fs.rmSync(path.join(data, 'memory.db'));
});

test('delete moves the folder to a tombstone first: a refused rename removes nothing, a refused removal still reports the model gone, and the next delete sweeps the leftover', async () => {
  const proj = mk('p10');
  const data = path.join(proj, '.belay');
  fs.mkdirSync(data);
  writeConfig(proj, { project: 'acme' });
  const cache = process.env.BELAY_MODEL_CACHE;
  const dir = fakeFetch(cache, ONNX_RERANKER_TABLE[JINA]);
  const real = { rename: embedderExtra.seams.rename, rm: embedderExtra.seams.rm };
  const args = { argv: ['delete', JINA], cwd: proj, dataDir: data, json: true };
  try {
    embedderExtra.seams.rename = () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
    const a = await embedderExtra.run(args);
    assert.strictEqual(a.code, 1);
    assert.match(a.text, /could not be moved out of the cache \(EBUSY\).*Nothing was removed/);
    assert.strictEqual(a.json.removed, false);
    assert.ok(fs.existsSync(path.join(dir, 'manifest.json')), 'the folder is whole');
    embedderExtra.seams.rename = real.rename;
    embedderExtra.seams.rm = () => { throw Object.assign(new Error('held'), { code: 'EPERM' }); };
    const b = await embedderExtra.run(args);
    assert.strictEqual(b.code, 0, b.text);
    assert.deepStrictEqual([b.json.removed, b.json.tombstone_left], [true, 'EPERM']);
    assert.ok(!fs.existsSync(dir), 'the model is gone from its place');
    assert.match(b.text, /leftover files \(EPERM\).*next delete or fetch/);
    assert.ok(fs.readdirSync(cache).some((n) => n.startsWith('.tomb-')), 'the tombstone is left');
    embedderExtra.seams.rm = real.rm;
    fakeFetch(cache, GGUF_MODELS[R4]);
    const c = await embedderExtra.run({ ...args, argv: ['delete', R4] });
    assert.strictEqual(c.code, 0, c.text);
    assert.ok(!fs.readdirSync(cache).some((n) => n.startsWith('.tomb-')), 'the next delete swept the old tombstone');
  } finally { Object.assign(embedderExtra.seams, real); }
});

test('the selected embedder needs the runtime sound now, not only an ok probe; the badge read counts that one embedder', async () => {
  const proj = mk('p11');
  const data = path.join(proj, '.belay');
  fs.mkdirSync(data);
  writeConfig(proj, { project: 'acme', profile: 'gpu-balanced' });
  fakeFetch(process.env.BELAY_MODEL_CACHE, GGUF_MODELS[E4]);
  fakeFetch(process.env.BELAY_MODEL_CACHE, GGUF_MODELS[R4]);
  const store = new Store(path.join(data, 'memory.db'), { stamp: true });
  for (const t of ['a', 'b']) store.storeIn({ namespace: 'project/acme', worker_id: 'w', type: 'note', text: `${t} note ${t}`, title: t, run_id: 'r', embedding: [1, 0], embedding_model: 'fake', embedding_revision: 'r', dim: 2 });
  store.close();
  P.recordLast(P.peaksFile(), { ok: true, device: { name: 'GPU' }, dedicated: { free_mb: 8000, total_mb: 8000 } }, [E4]);
  const opts = { found: C.discover(proj), dataDir: data };
  const up = await withRuntime(true, () => MM.badge(opts));
  assert.deepStrictEqual([up.badge, up.selected_embedder, up.behind], [true, E4, 2]);
  const down = await withRuntime(false, () => MM.badge(opts));
  assert.deepStrictEqual([down.selected_embedder, down.behind], [NANO, 0], 'a probe that was ok does not make a missing runtime usable');
  assert.strictEqual((await withRuntime(false, () => build(proj, data))).selected_embedder, NANO);
  assert.strictEqual(P.recordLast(P.peaksFile(), { ok: false, refusal: { reason: 'some_other' } }, []), false, 'a refusal that is not one of the four records nothing');
  assert.strictEqual(P.readLast(P.peaksFile()).ok, true);
  assert.strictEqual(P.recordLast(P.peaksFile(), { ok: false, refusal: { reason: 'no_runtime' } }, []), true, 'a probe that fails before the device is read says the GPU is not usable now');
  const last = P.readLast(P.peaksFile());
  assert.deepStrictEqual([last.ok, last.reason, last.device, last.free_mb], [false, 'no_runtime', 'GPU', 8000], 'with the earlier device reading kept for display');
  assert.match(require('../../src/cli/cmd-memory-menu.cjs').text(up), /selected embedder .*: 2 notes behind/);
  fs.rmSync(P.peaksFile());
});

test('a failed rename of the probe record leaves no temp file', () => {
  const file = path.join(mk('rec'), 'probe-peaks.json');
  fs.mkdirSync(file); // a directory where the file belongs: the rename fails
  assert.throws(() => P.recordPeaks(file, { k: { model: 'm', peak_mb: 1 } }));
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')), []);
  assert.strictEqual(P.recordLast(file, { ok: true, device: { name: 'g' }, dedicated: { free_mb: 1, total_mb: 1 } }, []), false);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')), []);
});

test('the settings say a GPU model is wanted exactly when the resolver finds one in a tier', () => {
  const K = require('../../src/cli/settings-keys.cjs');
  const heavy = (memory) => K.heavyConfigured({ found: true, config: { memory } });
  assert.strictEqual(K.heavyConfigured({ found: false }), false);
  assert.strictEqual(heavy({ project: 'a' }), false);
  assert.strictEqual(heavy({ profile: 'cpu-rerank' }), false);
  assert.strictEqual(heavy({ profile: 'gpu-rerank-fast' }), true, 'a GPU reranker counts');
  assert.strictEqual(heavy({ profile: 'gpu-balanced' }), true);
  assert.strictEqual(heavy({ routing: { reviewer: 'cpu-fast' } }), false, 'a routing of CPU profiles is not heavy');
  assert.strictEqual(heavy({ routing: { reviewer: { embedder: NANO, reranker: R4 } } }), true, 'a custom pair counts');
  assert.strictEqual(heavy({ profile: 'custom', embedder: E4 }), true);
  assert.strictEqual(heavy({ routing_cpu: { reviewer: 'cpu-rerank' } }), false, 'a CPU pick alone is not heavy');
  assert.strictEqual(heavy({ profile: 'bogus' }), false, 'a refused block is no wish');
});
