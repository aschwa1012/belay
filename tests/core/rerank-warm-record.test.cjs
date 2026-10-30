'use strict';
// rerank-warm-record.test.cjs — a reranker warm-up is a fact of the run row (no wake): the pin's own warm-up, a first-search warm-up with the
// searches served 'warming' counted, and a failed warm-up with its retry. Read back through the same view `belay status` and the receipt use.
// A FAKE GPU child and the real pin: no GPU, no runtime, no model.

process.env.BELAY_TEST_MODE = '1';
require('../helpers/tmp.cjs');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./lifecycle-env.cjs');
const { core, callerFor } = require('./helpers.cjs');
const { rig, EMB4, RR4 } = require('./fixtures/gpu-wire-rig.cjs');

const { Engine } = core('engine.cjs');
const ST = core('search-tier.cjs');
const RV = core('retrieval-view.cjs');
const rows = core('rows.cjs');
const RPV = core('rerank-provider.cjs');

let T, E, R;
const operator = (run) => callerFor('operator', { run_id: run });
const ns = (p) => `project/${p}`;
const rowOf = (run) => rows.current(T.store, 'run', run);
const until = async (f) => { for (let i = 0; i < 400 && !f(); i += 1) await new Promise((r) => setTimeout(r, 10)); };
const tier = { profile: 'gpu-balanced', embedder: EMB4, reranker: RR4, device: 'gpu', depth: 2 };
const lv = { rerank_depth: 2, rerank_bound_ms: 2000, on_heavy_failure: 'fallback' };
const ask = (run) => ST.rerankHead(E, { run_id: run }, { tier, order: 'score', query: 'q', t0: Date.now() }, [{ id: 'a' }, { id: 'b' }], () => new Map([['a', { text: 'x' }], ['b', { text: 'y' }]]), lv);

async function pinnedRun(run, p) {
  for (let i = 0; i < 2; i += 1) T.note(`${p} seed note ${'s'.repeat(i + 1)}`, { ns: ns(p), vec: [1, i / 10, 0] });
  await E.handle('run.attach', { caller: operator(run), adapter_pid: process.pid, project: p, memory_levers: JSON.stringify({ notes: false, project: p, profile: 'gpu-balanced', on_heavy_failure: 'fallback' }) });
  const first = await E.handle('run.pinRouting', { caller: operator(run) });
  for (const b of first.behind) await E.handle('memory.drainHeavy', { caller: operator(run), model: b.embedder, namespaces: b.namespaces });
  assert.strictEqual((await E.handle('run.pinRouting', { caller: operator(run) })).pinned, true);
}

before(async () => {
  R = rig(); R.install();
  T = await setup();
  E = new Engine({ dataDir: T.dir, store: T.store, establishedBy: 'test', getEmbedder: async () => ({ embed: async () => ({ embedding: [1, 0, 0], embedding_model: 'm' }) }), owner: { opts: { onEmbedderFailure: () => {} } } });
});
after(async () => { await RPV.closeAll(); await R.restore(); T.close(); });

test('the pin records its reranker warm-up on the run row, and the view carries it', async () => {
  await pinnedRun('wr-rec', 'wrrec');
  const v = RV.describe(rowOf('wr-rec'));
  const w = v.warmups.find((x) => x.model === RR4);
  assert.ok(w, JSON.stringify(v.warmups));
  assert.strictEqual(w.trigger, 'pin');
  assert.strictEqual(w.state, 'ready');
  assert.strictEqual(w.served_warming, 0);
});

test('a first-search warm-up is recorded with its trigger, duration and the searches served warming; no wake is sent', async () => {
  const wakes = [];
  E.owner.wake = (...a) => wakes.push(a);
  E._rerankWarm = null; // an owner that started after the pin
  const a = await ask('wr-rec'), b = await ask('wr-rec');
  assert.strictEqual(a.info.cause.reason, 'warming');
  assert.strictEqual(b.info.cause.reason, 'warming');
  const done = () => { const w = (RV.describe(rowOf('wr-rec')).warmups || []).find((x) => x.trigger === 'first_search'); return w && w.state !== 'loading' ? w : null; };
  await until(done);
  const w = done();
  assert.ok(w, JSON.stringify(RV.describe(rowOf('wr-rec')).warmups));
  assert.strictEqual(w.state, 'ready');
  assert.ok(w.ms >= 0 && w.ended_at >= w.started_at);
  assert.strictEqual(w.served_warming, 2);
  assert.deepStrictEqual(wakes, []);
  assert.strictEqual(rowOf('wr-rec').written_by, 'harness');
});

test('a failed warm-up is recorded as failed with its error, then retried as its own record', async () => {
  const dead = RPV.get({ reranker: RR4 }, { owner: E.owner });
  const orig = dead.rerank;
  let n = 0;
  dead.rerank = async () => { n += 1; throw new Error('model file missing'); };
  try {
    E._rerankWarm = null;
    await ask('wr-rec');
    await until(() => (E._rerankWarm.get(RR4) || {}).state === 'failed');
    const ws = RV.describe(rowOf('wr-rec')).warmups.filter((x) => x.state === 'failed');
    assert.strictEqual(n, 2);
    assert.deepStrictEqual(ws.map((x) => x.trigger).sort(), ['first_search', 'retry'].sort());
    assert.match(ws[0].error, /model file missing/);
  } finally { dead.rerank = orig; }
});

test('a warm-up with no run is kept on the owner only: nothing is written to any row', async () => {
  const before = JSON.stringify(RV.describe(rowOf('wr-rec')).warmups);
  E._rerankWarm = null;
  await ask(null);
  await until(() => (E._rerankWarm.get(RR4) || {}).state === 'ready');
  assert.strictEqual(JSON.stringify(RV.describe(rowOf('wr-rec')).warmups), before);
  const list = require('../../src/core/retrieval-warm.cjs').warmList(E);
  assert.strictEqual(list[0].model, RR4);
  assert.strictEqual(list[0].state, 'ready');
});

// A gated provider: the warm-up stays in flight until `release` is called, so the interleavings below are forced, not raced.
function gated() {
  const p = RPV.get({ reranker: RR4 }, { owner: E.owner });
  const orig = p.rerank;
  let release, fail = null;
  const gate = new Promise((r) => { release = r; });
  p.rerank = async (...a) => { await gate; if (fail) throw fail; return orig(...a); };
  return { release: (err) => { fail = err || null; release(); }, restore: () => { p.rerank = orig; } };
}

test('an owner that stops mid warm-up writes no failed record: the closed provider is not a fact of the run', async () => {
  await pinnedRun('wr-stop', 'wrstop');
  const g = gated();
  try {
    E._rerankWarm = null;
    await ask('wr-stop');
    E.owner.stopped = true; // what stop() sets before it closes the providers
    g.release(new Error('the provider was closed'));
    await until(() => (E._rerankWarm.get(RR4) || {}).state === 'failed');
    const ws = RV.describe(rowOf('wr-stop')).warmups.filter((w) => w.trigger !== 'pin');
    assert.deepStrictEqual(ws.map((w) => w.state), ['loading'], 'the record the start wrote stands; no failed record follows');
    const ended = RV.describe({ ...rowOf('wr-stop'), ended_at: Date.now() });
    assert.ok(RV.lines(ended).some((l) => /did not finish/.test(l)), RV.lines(ended).join('|'));
    assert.strictEqual(RV.models(ended).find((m) => m.role === 'reranker').state, 'unfinished');
    assert.strictEqual(RV.describe(rowOf('wr-stop'), { pid: process.pid + 1, alive: true }).warmups.find((w) => w.trigger !== 'pin').state, 'unfinished', 'a live run, another owner now');
    assert.strictEqual(RV.describe(rowOf('wr-stop'), { pid: process.pid, alive: true }).warmups.find((w) => w.trigger !== 'pin').owner_pid, process.pid, 'the record names its owner');
  } finally { E.owner.stopped = false; g.restore(); }
});

test('two runs on one owner: each run is counted for its own searches and gets its own record of the warm-up', async () => {
  await pinnedRun('wr-two-a', 'wrtwoa');
  await pinnedRun('wr-two-b', 'wrtwob');
  const g = gated();
  try {
    E._rerankWarm = null;
    await ask('wr-two-a');
    await ask('wr-two-b'); await ask('wr-two-b'); await ask('wr-two-b');
    g.release();
    const done = (id) => (RV.describe(rowOf(id)).warmups || []).find((w) => w.trigger === 'first_search' && w.state === 'ready');
    await until(() => done('wr-two-a') && done('wr-two-b'));
    assert.strictEqual(done('wr-two-a').served_warming, 1);
    assert.strictEqual(done('wr-two-b').served_warming, 3);
    assert.strictEqual(done('wr-two-a').started_at, done('wr-two-b').started_at, 'one warm-up, a record on each run it served');
  } finally { g.restore(); }
});
