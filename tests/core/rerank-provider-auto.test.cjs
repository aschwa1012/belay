'use strict';
// rerank-provider-auto.test.cjs — the CPU rerank provider is built on demand, in the store owner only (ADR 0050 decision 5): the
// first get() for a pinned ONNX reranker id builds and registers one, a second get() returns the same instance, a non-owner (a copy
// read, a client) never builds one and the rerank stage says so loudly, a GPU or unknown id is not built, and the owner's shutdown
// closes what was built. The REAL rerank-worker.cjs runs on a stub transformers package: no model, no onnx runtime.

process.env.BELAY_TEST_MODE = '1';
require('../helpers/tmp.cjs'); // this file starts processes: its own spawn register (spawn-register-isolation.test.cjs)
const cp = require('node:child_process');
const forked = [];
const realFork = cp.fork;
cp.fork = function (...a) { const c = realFork.apply(this, a); forked.push(c.pid); return c; }; // the pids of the rerank children, to prove they end (rerank-cpu takes fork at its first load)
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT } = require('./lifecycle-env.cjs');
const fs = require('node:fs');
const { core, sandbox, cleanup } = require('./helpers.cjs');
const { writeStubPackage, writeCache, fakeEntry } = require('./fixtures/rerank-stub-pkg.cjs');
const RP = core('retrieval-profiles.cjs');
const provider = core('rerank-provider.cjs');
const { search } = core('memory-search.cjs');
const { Engine } = core('engine.cjs');
const { pidAlive } = core('lock.cjs');
const gone = async (pid, ms = 5000) => { const t0 = Date.now(); while (pidAlive(pid) && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 20)); return !pidAlive(pid); };

const NS = `project/${PROJECT}`;
const entry = fakeEntry();
const RR = entry.id;
let T, E2, dir;
const FIX = [[1, 0, 0], [0.95, 0.31, 0], [0.8, 0.6, 0], [0.5, 0.866, 0]];
const TEXTS = ['colour palette for the settings page', 'release notes formatting guide', 'lunch order for friday', 'stop a worker process safely by its pid'];
let notes;
before(async () => {
  dir = sandbox();
  const table = { [RR]: entry };
  writeCache(`${dir}/cache`, table);
  provider.setAutoOptions({ pkg: writeStubPackage(`${dir}/pkg`), cacheDir: `${dir}/cache`, table });
  T = await setup();
  notes = TEXTS.map((t, i) => T.note(t, { vec: FIX[i] }));
  E2 = new Engine({ dataDir: T.dir, store: T.store, getEmbedder: null, owner: { opts: {} }, establishedBy: 'test' });
});
after(async () => { await provider.closeAll(); provider.setAutoOptions(null); await T.close(); cleanup(dir); });
afterEach(async () => { await provider.closeAll(); T.E._rerankFallback = null; E2._rerankFallback = null; });

const tier = (over = {}) => ({ profile: 'custom', embedder: RP.NANO, reranker: RR, device: 'cpu', depth: 4, ...over });
const ask = (E, internal = {}) => search(E, T.who.operator('plain'), { namespaces: [NS], query: 'stop a worker by its pid', query_embedding: [1, 0, 0], embedding_model: 'm', mode: 'semantic', k: 4 }, { tier: tier(), ...internal });

test('the owner builds the provider on the first get, the same instance on the second, and registers it', () => {
  assert.strictEqual(provider.get(tier()), null, 'without the owner fact nothing is built');
  const a = provider.get(tier(), { owner: true });
  assert.ok(a && typeof a.rerank === 'function' && typeof a.close === 'function');
  assert.strictEqual(provider.get(tier(), { owner: true }), a);
  assert.strictEqual(provider.get(tier()), a, 'once registered, any caller gets it');
});

test('a non-owner gets none, and the rerank stage reports the absent provider loudly', async () => {
  assert.strictEqual(provider.get(tier(), { owner: false }), null);
  const r = await ask(T.E);
  assert.strictEqual(r.rerank.ran, false);
  assert.ok(r.modes_failed.some(m => m.mode === 'rerank'), JSON.stringify(r.modes_failed));
  assert.strictEqual(provider.get(tier()), null, 'the failed search built nothing');
});

test('a GPU, unknown or missing reranker id is not auto-built', () => {
  for (const id of ['Qwen/Qwen3-Reranker-0.6B-GGUF', 'no/such-reranker', null]) assert.strictEqual(provider.get(tier({ reranker: id }), { owner: true }), null, String(id));
});

test('an end-to-end search in the owner builds the provider and reorders the rows', async () => {
  const r = await ask(E2);
  assert.strictEqual(r.rerank.ran, true, JSON.stringify(r.rerank));
  assert.strictEqual(r.rerank.reranked, 4);
  assert.strictEqual(r.results[0].id, notes[3], 'the note sharing words with the query rises from last to first');
  assert.deepStrictEqual(r.modes_failed, []);
});

test('closeAll closes the child, ends its process, forgets the provider, and a later owner builds a fresh one', async () => {
  const a = provider.get(tier(), { owner: true });
  const n = forked.length;
  await a.rerank({ query: 'stop worker pid', docs: [{ id: 'x', text: 'stop the worker by pid' }] });
  assert.strictEqual(forked.length, n + 1);
  const pid = forked[n];
  assert.ok(pidAlive(pid));
  await provider.closeAll(5000);
  assert.ok(await gone(pid), 'the rerank child is dead');
  assert.strictEqual(provider.get(tier()), null, 'closed providers are forgotten');
  await assert.rejects(a.rerank({ query: 'q', docs: [{ id: 'x', text: 'y' }] }), /closed/);
  assert.notStrictEqual(provider.get(tier(), { owner: true }), a);
});

const { Owner } = core('owner.cjs');
const lockHeld = (d) => fs.existsSync(`${d}/owner.lock`);

test('an owner closes the providers it built, ends their children and releases the lock; one it did not build is left alone', async () => {
  const d = sandbox();
  let other = 0;
  provider.register('other/provider', { rerank: async () => ({ scores: [] }), close: async () => { other += 1; } });
  try {
    const o = new Owner(d, { embed: false });
    await o.start();
    const p = provider.get(tier(), { owner: o });
    const n = forked.length;
    await p.rerank({ query: 'stop worker pid', docs: [{ id: 'x', text: 'stop the worker by pid' }] });
    assert.deepStrictEqual([...o.rerankBuilt], [RR]);
    await o.stop();
    assert.ok(await gone(forked[n]), 'the rerank child is dead after stop()');
    assert.strictEqual(provider.get(tier()), null);
    assert.strictEqual(other, 0, 'a provider this owner did not build is not closed by it');
    assert.ok(!lockHeld(d), 'the lock is released');
  } finally { provider.unregister('other/provider'); cleanup(d); }
});

test('a search that reaches a stopping owner builds nothing, and no child exists', async () => {
  const d = sandbox();
  try {
    const o = new Owner(d, { embed: false });
    await o.start();
    const n = forked.length;
    const stopping = o.stop(); // sets stopped before its first await
    assert.strictEqual(provider.get(tier(), { owner: o }), null);
    const E3 = new Engine({ dataDir: T.dir, store: T.store, getEmbedder: null, owner: o, establishedBy: 'test' });
    const r = await ask(E3);
    assert.strictEqual(r.rerank.ran, false);
    await stopping;
    assert.strictEqual(provider.get(tier()), null, 'nothing registered');
    assert.strictEqual(forked.length, n, 'no child was forked');
  } finally { cleanup(d); }
});

test('a provider that fails because the owner is stopping is a non-sticky, non-pausing shutdown failure', async () => {
  const hooked = [];
  const E4 = new Engine({ dataDir: T.dir, store: T.store, getEmbedder: null, owner: { stopped: true, opts: { onEmbedderFailure: (x) => { hooked.push(x); } } }, establishedBy: 'test' });
  provider.register(RR, { rerank: async () => { throw Object.assign(new Error('closed'), { code: 'E_MODEL_ABSENT' }); } });
  const r = await ask(E4, { levers: { on_heavy_failure: 'pause' } });
  assert.strictEqual(r.rerank.cause.reason, 'shutdown');
  assert.deepStrictEqual(hooked, [], 'no pause');
  assert.strictEqual(E4._rerankFallback ? E4._rerankFallback.size : 0, 0, 'not sticky');
  provider.unregister(RR);
});

test('a provider whose close never settles does not hold stop() past its bound, and the lock is released; one whose close throws is forgotten', async () => {
  const d = sandbox();
  try {
    const o = new Owner(d, { embed: false });
    await o.start();
    provider.register('hang/close', { rerank: async () => ({ scores: [] }), close: () => new Promise(() => {}) });
    provider.register('throw/close', { rerank: async () => ({ scores: [] }), close: async () => { throw new Error('cannot close'); } });
    o.rerankBuilt = new Set(['hang/close', 'throw/close']);
    const t0 = Date.now();
    await o.stop();
    const ms = Date.now() - t0;
    assert.ok(ms >= 2800 && ms < 5000, `stop took ${ms} ms`);
    assert.ok(!lockHeld(d), 'the lock is released');
    assert.strictEqual(provider.get({ reranker: 'hang/close' }), null);
    assert.strictEqual(provider.get({ reranker: 'throw/close' }), null);
  } finally { cleanup(d); }
});
