'use strict';
// gpu-wire-search.test.cjs — a heavy tier's backlog drain and its query embedding (ADR 0050 decisions 4 and 6), through the real
// memory.search and the real memory-vectors cache, with a FAKE GPU child (no GPU, no runtime, no model). The fake child's vectors depend
// only on the text length, so a query whose prompted length equals one note's text length matches that note exactly.

process.env.BELAY_TEST_MODE = '1';
require('../helpers/tmp.cjs'); // this file starts processes: its own spawn register (spawn-register-isolation.test.cjs)
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT } = require('./lifecycle-env.cjs');
const { core } = require('./helpers.cjs');
const { rig, EMB4, TABLE } = require('./fixtures/gpu-wire-rig.cjs');

const { Engine } = core('engine.cjs');
const MV = core('memory-vectors.cjs');
const HT = core('heavy-tier.cjs');
const HD = core('heavy-drain.cjs');
const { search } = core('memory-search.cjs');

const NS = `project/${PROJECT}`;
const TITLES = ['aa', 'bbbbbb', 'cccccccccc', 'dddddddddddddd', 'eeeeeeeeeeeeeeeeee', 'ffffffffffffffffffffff'];
let T, E, R, notes, seen;
const heavy = () => HT.withDims({ profile: 'custom', embedder: EMB4, reranker: null, device: 'gpu', depth: 0 });
const textOf = (id) => T.row(id).text;
const ask = (args = {}, internal = {}) => search(E, T.who.operator('plain'), { namespaces: [NS], mode: 'semantic', k: 20, ...args }, { tier: heavy(), ...internal });
const heavyRows = () => T.store.db.prepare('SELECT COUNT(*) AS n FROM memory_vectors WHERE model = ?').get(EMB4).n;

before(async () => {
  R = rig(); R.install();
  T = await setup();
  seen = [];
  E = new Engine({
    dataDir: T.dir, store: T.store, establishedBy: 'test',
    getEmbedder: async () => ({ embed: async () => ({ embedding: [1, 0, 0], embedding_model: 'm' }) }), // nano, for the fallback
    owner: { opts: { onEmbedderFailure: (f) => seen.push(f) } },
  });
  notes = TITLES.map((t, i) => T.note(t, { vec: [1, i / 10, 0] }));
});
after(async () => { await R.restore(); T.close(); });

test('the heavy tier has a backlog of every visible note until it is drained', () => {
  assert.strictEqual(HD.backlogOf(E, EMB4, [NS]).length, notes.length);
  assert.strictEqual(heavyRows(), 0);
  assert.ok(Number.isInteger(HT.withDims({ embedder: EMB4 }).dims), 'the tier knows its dims');
});

test('a bounded drain stops inside a batch, per document, and reports what is left', async () => {
  // The drain's clock is injected and ticks once per read, so the 1 ms bound passes after exactly one document however fast the machine is.
  let tick = 0;
  const r = await HD.drainHeavy(E, EMB4, { namespaces: [NS], batch: 2, boundMs: 1, now: () => tick++ });
  assert.strictEqual(r.total, notes.length);
  assert.strictEqual(r.written, 1, 'the bound covers one batch too: one document, then the deadline');
  assert.strictEqual(r.remaining, notes.length - 1);
  assert.strictEqual(r.done, false);
  assert.strictEqual(heavyRows(), 1);
});

test('the drain writes vectors, bumps the cache generation, reports progress and empties the backlog', async () => {
  const gen = MV.generation(T.store.db);
  const progress = [];
  const r = await HD.drainHeavy(E, EMB4, { namespaces: [NS], batch: 2, onProgress: (p) => progress.push(p) });
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.remaining, 0);
  assert.strictEqual(r.written, r.total);
  assert.deepStrictEqual(progress.map(p => p.done), [2, 4, 5], 'progress per batch, ending at the backlog it started with (one row was already done)');
  assert.ok(MV.generation(T.store.db) > gen, 'every vector write bumps the generation');
  assert.strictEqual(heavyRows(), notes.length);
  assert.strictEqual(HD.backlogOf(E, EMB4, [NS]).length, 0);
  const again = await HD.drainHeavy(E, EMB4, { namespaces: [NS] });
  assert.deepStrictEqual([again.total, again.written, again.done], [0, 0, true], 'a second drain finds nothing');
});

test('a heavy search with no query vector embeds the query through the heavy provider, with the query prompt', async () => {
  const target = notes[3], len = textOf(target).length;
  const q = 'x'.repeat(len - 'Q: '.length); // the fake child sees `Q: ` + query: the same length as the target note text
  const r = await ask({ query: q });
  assert.strictEqual(r.results[0].id, target);
  assert.ok(r.results[0].score > 0.999, `the target matches exactly (${r.results[0].score})`);
  assert.strictEqual(r.tier.embedder, EMB4);
  assert.strictEqual(r.model, EMB4);
  assert.strictEqual(r.modes_failed.length, 0);
});

test('a note written after the drain leaves the heavy tier behind, and it refuses by name', async () => {
  const late = T.note('late arrival to the project', { vec: [1, 0.9, 0] });
  await assert.rejects(ask({ query: 'anything at all' }), (e) => e.code === 'E_TIER_BEHIND' && e.detail.ids.includes(late));
  // A worker is told how many rows are behind but not which: some may be notes it may not see.
  assert.throws(() => require('../../src/core/search-tier.cjs').assertServable(E, heavy(), [NS], false), (e) => e.code === 'E_TIER_BEHIND' && e.detail.behind >= 1 && e.detail.ids.length === 0);
  const r = await HD.drainHeavy(E, EMB4, { namespaces: [NS] });
  assert.deepStrictEqual([r.written, r.done], [1, true]);
  assert.strictEqual((await ask({ query: 'anything at all' })).results.length, notes.length + 1);
});

test('without the owner there is no heavy provider, and the search fails by name', async () => {
  await require('../../src/core/embed-provider.cjs').closeAll(); // a provider built earlier in this process is every caller's: start clean
  const plain = new Engine({ dataDir: T.dir, store: T.store, getEmbedder: null, owner: null, establishedBy: 'test' });
  await assert.rejects(search(plain, T.who.operator('plain'), { namespaces: [NS], query: 'anything', mode: 'semantic' }, { tier: heavy(), levers: { on_heavy_failure: 'pause' } }), (e) => e.code === 'E_NO_EMBEDDER' && e.detail.heavy === true);
  const copy = await search(plain, T.who.operator('plain'), { namespaces: [NS], query: 'anything', mode: 'semantic' }, { tier: heavy(), levers: { on_heavy_failure: 'pause' } }).catch((e) => e);
  assert.doesNotMatch(copy.message, /belay resume/, 'a copy-served search cannot resume a run, so it does not say to');
});

test('a heavy embed failure under on_heavy_failure pause is loud, tells the run hook, and keeps the run on its tier', async () => {
  await R.restore(); // a fresh child that cannot load
  R = rig({ fake: { load_fail: true } }); R.install();
  seen.length = 0;
  await assert.rejects(ask({ query: 'anything at all' }, { levers: { on_heavy_failure: 'pause' } }), (e) => e.code === 'E_INTERNAL' && e.detail.heavy === true && e.detail.cause === 'load_failed' && /Tell the operator/.test(e.message) && /fix the GPU embedder/.test(e.message) && !/embedder fetch/.test(e.message) && e.detail.stage === 'heavy_embed');
  assert.strictEqual(seen.length, 1, 'the run hook was told once');
  assert.strictEqual(seen[0].call, 'memory.search');
  assert.strictEqual(HT.fallbackOf(E, 'lc-plain'), null, 'pause does not fall back');
});

test('a heavy embed failure under on_heavy_failure fallback serves the search on nano and says so (a run with no pin has no sticky state)', async () => {
  const r = await ask({ query: 'anything at all' }, { levers: { on_heavy_failure: 'fallback' } });
  assert.strictEqual(r.tier_fallback.to, 'cpu-fast');
  assert.strictEqual(r.tier_fallback.cause.code, 'E_INTERNAL');
  assert.ok(r.modes_failed.some(m => m.mode === 'heavy_embed'), JSON.stringify(r.modes_failed));
  assert.match(r.warning, /heavy_embed/);
  assert.strictEqual(r.results.length, notes.length + 1, 'the nano scan answered');
  assert.strictEqual(HT.fallbackOf(E, 'lc-plain'), null, 'the sticky fallback lives on a pinned run row (gpu-wire-write.test.cjs)');
  assert.deepStrictEqual(Object.keys(TABLE).includes(EMB4), true);
});

test('S7: memory.drainHeavy asked to probe runs the VRAM probe before any load; a refusal loads nothing, and a pass drains', async () => {
  const GS = core('gpu-shared.cjs');
  await R.restore(); R = rig({ probe: { vram_fail: true } }); R.install();
  const late = T.note('a note for the probing drain', { vec: [1, 0.8, 0] });
  const op = T.who.operator('plain');
  await assert.rejects(E.handle('memory.drainHeavy', { caller: op, model: EMB4, namespaces: [NS], probe: true }), (e) => e.code === 'E_MODEL_ABSENT' && e.detail.cause === 'probe_refused' && e.detail.refusal.reason === 'no_gpu');
  assert.strictEqual(GS.isOpen(), false, 'the refused probe loaded nothing in the shared child');
  assert.ok(HD.backlogOf(E, EMB4, [NS]).some(r => r.id === late), 'the row is still behind');
  await R.restore(); R = rig({ fake: { load_fail: true, load_fail_msg: 'Invalid GGUF magic. Expected "GGUF"' } }); R.install();
  await assert.rejects(E.handle('memory.drainHeavy', { caller: op, model: EMB4, namespaces: [NS], probe: true }), (e) => e.code === 'E_MODEL_ABSENT' && e.detail.cause === 'model_corrupt' && e.message.includes(`${EMB4} (file m.gguf)`) && /belay embedder delete --gpu --model/.test(e.message) && !/probe refused/.test(e.message));
  await R.restore(); R = rig(); R.install();
  const ok = await E.handle('memory.drainHeavy', { caller: op, model: EMB4, namespaces: [NS], probe: true, headroom_gb: 0.5 });
  assert.strictEqual(ok.done, true);
  assert.strictEqual(HD.backlogOf(E, EMB4, [NS]).length, 0);
});
