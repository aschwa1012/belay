'use strict';
// gpu-wire-dead-child.test.cjs — the shared GPU child dies (here: killed during a run, as a heavy embed that crashed it would leave it).
// The next reranked search must not start a re-warm that cannot work and answer 'warming': it goes to the reranker and gets the child's
// coded error, which on_heavy_failure then drives. A FAKE GPU child: no GPU, no runtime, no model.

process.env.BELAY_TEST_MODE = '1';
require('../helpers/tmp.cjs');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./lifecycle-env.cjs');
const { core, callerFor } = require('./helpers.cjs');
const { rig, EMB4, RR4 } = require('./fixtures/gpu-wire-rig.cjs');
const { waitFor } = require('../helpers/wait.cjs');

const { Engine } = core('engine.cjs');
const HD = core('heavy-drain.cjs');
const GS = core('gpu-shared.cjs');
const ST = core('search-tier.cjs');

let T, E, R;
const operator = (run) => callerFor('operator', { run_id: run });
const ns = (p) => `project/${p}`;
const search = (run, p) => E.handle('memory.search', { caller: operator(run), namespaces: [ns(p)], query: 'something to look for', mode: 'hybrid', k: 10 });

before(async () => {
  R = rig(); R.install();
  T = await setup();
  E = new Engine({ dataDir: T.dir, store: T.store, establishedBy: 'test', getEmbedder: async () => ({ embed: async () => ({ embedding: [1, 0, 0], embedding_model: 'm' }) }), owner: { opts: { onEmbedderFailure: () => {} } } });
});
after(async () => { await R.restore(); T.close(); });

test('a search after the shared GPU child died gets the real error, not warming', async () => {
  const run = 'dc-a', p = 'dca';
  for (let i = 0; i < 2; i += 1) T.note(`${p} seed note ${'s'.repeat(i + 1)}`, { ns: ns(p), vec: [1, i / 10, 0] });
  await E.handle('run.attach', { caller: operator(run), adapter_pid: process.pid, project: p, memory_levers: JSON.stringify({ notes: false, project: p, profile: 'gpu-balanced', on_heavy_failure: 'fallback' }) });
  const first = await E.handle('run.pinRouting', { caller: operator(run) });
  for (const b of first.behind) await E.handle('memory.drainHeavy', { caller: operator(run), model: b.embedder, namespaces: b.namespaces });
  assert.strictEqual((await E.handle('run.pinRouting', { caller: operator(run) })).pinned, true);
  assert.strictEqual(HD.backlogOf(E, EMB4, [ns(p)]).length, 0);
  const ok = await search(run, p);
  assert.ok(ok.rerank, JSON.stringify(ok.modes_failed));
  const child = GS.client();
  const gone = waitFor({ emitter: child.child, event: 'exit' });
  assert.ok(require('../crash.cjs').crash(child.child), 'the GPU child is ended by its live handle');
  await gone;
  assert.strictEqual(GS.dead(), true);
  // The reranked search itself, after the heavy embed step (which would already have moved the run to its fallback tier): the rerank stage alone.
  const ranked = [{ id: 'a' }, { id: 'b' }];
  const tier = { profile: 'gpu-balanced', embedder: EMB4, reranker: RR4, device: 'gpu', depth: 2 };
  const lv = { rerank_depth: 2, rerank_bound_ms: 2000, on_heavy_failure: 'fallback' };
  const r = await ST.rerankHead(E, { run_id: null }, { tier, order: 'score', query: 'q', t0: Date.now() }, ranked, () => new Map([['a', { text: 'x' }], ['b', { text: 'y' }]]), lv);
  assert.ok(r.info, JSON.stringify(r));
  assert.notStrictEqual(r.info.cause && r.info.cause.reason, 'warming', JSON.stringify(r.info));
  assert.strictEqual(r.info.ran, false);
  assert.strictEqual(r.info.cause.code, 'E_RERANK');
  assert.match(r.info.cause.message, /GPU process/, 'the cause is the dead childs coded error');
});
