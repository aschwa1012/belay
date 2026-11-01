'use strict';
require('../helpers/tmp.cjs');
// memory-menu-live.test.cjs — what keeps a model in use (ADR 0050 amendment 3): a run that is still pinning, a parked run, a reused adapter pid
// (ADR 0039), a model deleted after an ok probe, and a real open handle that stops the rename.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { core } = require('../core/helpers.cjs');
const MM = require('../../src/core/memory-menu.cjs');
const { GGUF_MODELS } = require('../../src/core/gguf-models.cjs');
const embedderExtra = require('../../src/cli/cmd-embedder-extra.cjs');
const P = require('../../src/core/gpu-probe.cjs');
const R = require('../../src/core/gpu-runtime.cjs');
const C = require('../../src/cli/config.cjs');
const AD = require('../../src/run/agent-defaults.cjs');

const { Store } = core('store.cjs');
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-menulive-'));
  env0 = { c: process.env.BELAY_MODEL_CACHE, g: process.env.BELAY_GPU_RUNTIME };
  process.env.BELAY_MODEL_CACHE = mk('models');
  process.env.BELAY_GPU_RUNTIME = mk('gpu');
});
after(() => {
  for (const [k, v] of [['BELAY_MODEL_CACHE', env0.c], ['BELAY_GPU_RUNTIME', env0.g]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(root, { recursive: true, force: true });
});
const withRuntime = async (ok, fn) => {
  const keep = R.check;
  R.check = () => ({ ok, dir: 'x', versions: {}, problems: ok ? [] : ['the GPU runtime is not installed (x)'], command: 'belay embedder fetch --gpu', manifest_version: '0' });
  try { return await fn(); } finally { R.check = keep; }
};
const build = (proj, data) => MM.menu({ found: C.discover(proj), dataDir: data, agentTypes: AD.AGENT_KEYS });
// A run row with the columns these tests vary.
function runs(data, list) {
  const store = new Store(path.join(data, 'memory.db'), { stamp: true });
  for (const r of list) {
    store.p('INSERT INTO run(id, epoch, adapter_pid, adapter_pid_created, started_at, ended_at, paused_at, memory_levers, retrieval_routing, written_at, written_by) VALUES (?, 1, ?, ?, ?, NULL, ?, ?, ?, ?, ?)')
      .run(r.id, r.pid, r.created === undefined ? null : r.created, Date.now(), r.paused ? Date.now() : null, r.levers ? JSON.stringify(r.levers) : null, r.pin ? JSON.stringify(r.pin) : null, Date.now(), 't');
  }
  store.close();
}
const project = (name, memory = { project: 'acme' }) => { const proj = mk(name); const data = path.join(proj, '.belay'); fs.mkdirSync(data); writeConfig(proj, memory); return { proj, data }; };
const del = (proj, data, id, extra = {}) => embedderExtra.run({ argv: ['delete', id], cwd: proj, dataDir: data, json: true, ...extra });

test('a model deleted after an ok probe stops being named: the badge and the menu fall back to the CPU profile', async () => {
  const { proj, data } = project('s1', { project: 'acme', profile: 'gpu-balanced' });
  const cache = process.env.BELAY_MODEL_CACHE;
  fakeFetch(cache, GGUF_MODELS[E4]);
  const r4dir = fakeFetch(cache, GGUF_MODELS[R4]);
  const store = new Store(path.join(data, 'memory.db'), { stamp: true });
  store.storeIn({ namespace: 'project/acme', worker_id: 'w', type: 'note', text: 'a note', title: 'a', run_id: 'r', embedding: [1, 0], embedding_model: 'fake', embedding_revision: 'r', dim: 2 });
  store.close();
  P.recordLast(P.peaksFile(), { ok: true, device: { name: 'GPU' }, dedicated: { free_mb: 8000, total_mb: 8000 } }, [E4]);
  const opts = { found: C.discover(proj), dataDir: data };
  const before = await withRuntime(true, async () => ({ b: await MM.badge(opts), m: await build(proj, data) }));
  assert.deepStrictEqual([before.b.selected_embedder, before.b.behind, before.m.selected_embedder], [E4, 1, E4]);
  fs.rmSync(r4dir, { recursive: true, force: true }); // the reranker of the saved routing goes away
  const after = await withRuntime(true, async () => ({ b: await MM.badge(opts), m: await build(proj, data) }));
  assert.deepStrictEqual([after.b.selected_embedder, after.b.behind, after.m.selected_embedder, after.m.selected_profile], [NANO, 0, NANO, 'cpu-fast']);
  fs.rmSync(P.peaksFile(), { force: true });
});

test('a live run that is still pinning counts through the models its recorded levers resolve to', async () => {
  const { proj, data } = project('s2');
  fakeFetch(process.env.BELAY_MODEL_CACHE, GGUF_MODELS[R4]);
  runs(data, [{ id: 'r-pin', pid: process.pid, levers: { profile: 'gpu-rerank' } }]); // no retrieval_routing yet
  const m = await build(proj, data);
  assert.deepStrictEqual(m.live_runs, ['r-pin']);
  assert.deepStrictEqual(m.models.find((x) => x.id === R4).in_use_by, ['run r-pin']);
  const r = await del(proj, data, R4);
  assert.strictEqual(r.code, 1);
  assert.match(r.text, /run r-pin/);
});

test('a paused run holds its pin whatever its pid says, and the refusal says how to clear a stale one', async () => {
  const { proj, data } = project('s3');
  const dir = fakeFetch(process.env.BELAY_MODEL_CACHE, GGUF_MODELS[R4]);
  const dead = require('../helpers/dead-pid.cjs').deadPid(); // an exited child's pid is reused on Windows
  const pin = { routing: { run: { embedder: NANO, reranker: R4 }, tiers: {} } };
  runs(data, [{ id: 'r-park', pid: dead, paused: true, pin }]);
  const m = await build(proj, data);
  assert.deepStrictEqual(m.models.find((x) => x.id === R4).in_use_by, ['run r-park (paused)']);
  const r = await del(proj, data, R4);
  assert.strictEqual(r.code, 1);
  assert.match(r.text, /r-park \(paused\)/);
  assert.match(r.text, /To clear a stale run: r-park \(paused\).*belay stop r-park.*no command ends the row/);
  assert.ok(fs.existsSync(dir));
});

test('delete confirms a live adapter pid against one process snapshot: a reused pid is a dead run, an unreadable snapshot keeps the refusal', async () => {
  const { proj, data } = project('s4');
  const cache = process.env.BELAY_MODEL_CACHE;
  const pin = { routing: { run: { embedder: NANO, reranker: R4 }, tiers: {} } };
  runs(data, [{ id: 'r-reused', pid: process.pid, created: 111, pin }]);
  const keep = embedderExtra.seams.snapshot;
  try {
    fakeFetch(cache, GGUF_MODELS[R4]);
    embedderExtra.seams.snapshot = async () => new Map([[process.pid, { created: 111, image: 'node' }]]);
    const same = await del(proj, data, R4);
    assert.strictEqual(same.code, 1, 'the creation time matches: the run is live');
    assert.match(same.text, /run r-reused/);
    embedderExtra.seams.snapshot = async () => null;
    const unread = await del(proj, data, R4);
    assert.strictEqual(unread.code, 1);
    assert.match(unread.text, /r-reused \(adapter pid .* could not be verified\): if it is live, end it with belay stop r-reused; if belay stop says "no live run", it is dead/);
    embedderExtra.seams.snapshot = async () => new Map([[process.pid, { created: 222, image: 'node' }]]);
    const reused = await del(proj, data, R4);
    assert.strictEqual(reused.code, 0, reused.text);
    assert.deepStrictEqual(reused.json.ignored_stale_runs, ['r-reused']);
    // the menu read trusts the bare pid (a read budget): it still lists the run
    assert.deepStrictEqual((await build(proj, data)).live_runs, ['r-reused']);
  } finally { embedderExtra.seams.snapshot = keep; }
});

test('a run that recorded no creation time is judged by its bare pid, with no snapshot taken', async () => {
  const { proj, data } = project('s5');
  fakeFetch(process.env.BELAY_MODEL_CACHE, GGUF_MODELS[R4]);
  runs(data, [{ id: 'r-old', pid: process.pid, pin: { routing: { run: { embedder: NANO, reranker: R4 }, tiers: {} } } }]);
  const keep = embedderExtra.seams.snapshot;
  let taken = 0;
  try {
    embedderExtra.seams.snapshot = async () => { taken += 1; return null; };
    assert.strictEqual((await del(proj, data, R4)).code, 1);
    assert.strictEqual(taken, 0);
  } finally { embedderExtra.seams.snapshot = keep; }
});

test('the full menu takes ONE copy of the store for the live runs and the backlog', async () => {
  const { proj, data } = project('s6', { project: 'acme', profile: 'gpu-balanced' });
  fakeFetch(process.env.BELAY_MODEL_CACHE, GGUF_MODELS[E4]);
  runs(data, [{ id: 'r-1', pid: process.pid, levers: { profile: 'gpu-balanced' } }]);
  const CR = require('../../src/core/copy-read.cjs');
  const keep = CR.withCopy;
  let copies = 0;
  CR.withCopy = (...a) => { copies += 1; return keep(...a); };
  try {
    const m = await build(proj, data);
    assert.strictEqual(copies, 1);
    assert.deepStrictEqual(m.live_runs, ['r-1']);
  } finally { CR.withCopy = keep; }
});

test('a file held open in a model folder makes the rename fail: delete removes nothing (a real open handle)', { skip: process.platform !== 'win32' }, async () => {
  const { proj, data } = project('s7');
  const dir = fakeFetch(process.env.BELAY_MODEL_CACHE, GGUF_MODELS[R4]);
  const file = path.join(dir, GGUF_MODELS[R4].files[0].path);
  const child = spawn(process.execPath, ['-e', "const fs=require('fs');fs.openSync(process.argv[1],'r');console.log('held');setInterval(()=>{},1000)", file], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('the holder exited'))); });
    const r = await del(proj, data, R4);
    assert.strictEqual(r.code, 1);
    assert.match(r.text, /could not be moved out of the cache \((EPERM|EBUSY)\).*Nothing was removed/);
    assert.ok(fs.existsSync(file), 'the folder is whole');
  } finally { child.kill(); await new Promise((res) => { if (child.exitCode !== null || child.signalCode) res(); else child.once('exit', res); }); }
  assert.strictEqual((await del(proj, data, R4)).code, 0, 'once the handle is closed the delete goes through');
});

test('the read creates and changes no file in a data dir that holds a store with its WAL, with the store open', async () => {
  const { proj, data } = project('s8', { project: 'acme', profile: 'gpu-balanced' });
  fakeFetch(process.env.BELAY_MODEL_CACHE, GGUF_MODELS[E4]);
  const store = new Store(path.join(data, 'memory.db'), { stamp: true });
  try {
    store.storeIn({ namespace: 'project/acme', worker_id: 'w', type: 'note', text: 'a note', title: 'a', run_id: 'r', embedding: [1, 0], embedding_model: 'fake', embedding_revision: 'r', dim: 2 });
    const names = () => fs.readdirSync(data).sort();
    const stat = () => names().map((n) => { const s = fs.statSync(path.join(data, n)); return `${n}:${s.size}:${s.mtimeMs}`; });
    assert.ok(names().some((n) => n.endsWith('-wal')), 'the store has its write-ahead log');
    const before = { names: names(), stat: stat(), proj: fs.readdirSync(proj).sort() };
    await build(proj, data);
    await MM.badge({ found: C.discover(proj), dataDir: data });
    assert.deepStrictEqual(names(), before.names, 'no file was created or removed');
    assert.deepStrictEqual(stat(), before.stat, 'no file changed');
    assert.deepStrictEqual(fs.readdirSync(proj).sort(), before.proj);
  } finally { store.close(); }
});
