'use strict';
// gpu-wire-providers.test.cjs — the GPU rerank and embed providers are built on demand in the store owner only, share ONE GPU child, and
// are closed with it (ADR 0049 decision 3, ADR 0050 decisions 4 and 5). A FAKE GPU child: no GPU, no runtime, no model.

process.env.BELAY_TEST_MODE = '1';
require('../helpers/tmp.cjs'); // this file starts processes: its own spawn register (spawn-register-isolation.test.cjs)
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core } = require('./helpers.cjs');
const { rig, EMB4, RR4 } = require('./fixtures/gpu-wire-rig.cjs');

const RP = core('retrieval-profiles.cjs');
const RPV = core('rerank-provider.cjs');
const EP = core('embed-provider.cjs');
const GS = core('gpu-shared.cjs');
const { pidAlive } = core('lock.cjs');

const R = rig();
before(() => R.install());
after(() => R.restore());

const rerankTier = { profile: 'custom', embedder: RP.NANO, reranker: RR4, device: 'gpu', depth: 4 };
const heavyTier = { profile: 'custom', embedder: EMB4, reranker: null, device: 'gpu', depth: 0 };
const docs = [{ id: 'a', text: 'lunch order for friday' }, { id: 'b', text: 'stop a worker process by its pid' }, { id: 'c', text: 'worker pid list' }];
const { waitGone: gone } = require('../helpers/wait.cjs');
const G = require('../helpers/proc-gone.cjs'); // waitGone takes the identity of a process taken while it lived: a bare pid may be handed to another process (ADR 0039)

test('the owner builds the GPU rerank provider on the first get, once, and a non-owner never does', async () => {
  assert.strictEqual(RPV.get(rerankTier), null, 'no owner fact, nothing built');
  assert.strictEqual(RPV.get(rerankTier, { owner: false }), null);
  assert.strictEqual(GS.isOpen(), false, 'a refused get forked no child');
  const p = RPV.get(rerankTier, { owner: true });
  assert.ok(p && typeof p.rerank === 'function');
  assert.strictEqual(RPV.get(rerankTier, { owner: true }), p, 'the same instance');
  assert.strictEqual(RPV.get(rerankTier), p, 'once registered, any caller gets it');
  const r = await p.rerank({ query: 'stop a worker by its pid', docs, depth: 3, boundMs: 5000 });
  assert.deepStrictEqual(r.scores.map(s => s.id), ['a', 'b', 'c']);
  assert.strictEqual(r.device, 'gpu');
  assert.strictEqual(r.model, RR4);
  const byId = Object.fromEntries(r.scores.map(s => [s.id, s.score]));
  assert.ok(byId.b > byId.a, 'the relevant document scores above the filler');
});

test('the owner builds the heavy embed provider once; nano and a non-owner get none', async () => {
  assert.strictEqual(EP.get(heavyTier), null, 'no owner fact, nothing built');
  assert.strictEqual(EP.get({ ...heavyTier, embedder: RP.NANO }, { owner: true }), null, 'nano is the store embedder, not a provider');
  assert.strictEqual(EP.get({ ...heavyTier, embedder: 'no/such-model' }, { owner: true }), null);
  const e = EP.get(heavyTier, { owner: true });
  assert.ok(e && typeof e.embedQuery === 'function' && typeof e.embedDocs === 'function');
  assert.strictEqual(EP.get(heavyTier, { owner: true }), e);
  assert.strictEqual(EP.get(heavyTier), e);
  const q = await e.embedQuery('stop a worker');
  assert.strictEqual(q.dim, 8);
  assert.ok(Math.abs(Math.hypot(...q.embedding) - 1) < 1e-6, 'a unit vector');
  const d = await e.embedDocs([{ id: 'x', text: 'stop a worker' }, { id: 'y', text: 'lunch' }]);
  assert.deepStrictEqual(d.map(x => x.id), ['x', 'y']);
  assert.notDeepStrictEqual(d[0].embedding, q.embedding, 'the query side carries the model query prompt, the document side does not');
});

test('one child holds the reranker and the embedder, and closeAll closes it', async () => {
  const c = GS.client();
  const pid = c.pid;
  const ping = await c.ping(2000);
  assert.strictEqual(ping.ok, true);
  assert.deepStrictEqual([...ping.models].sort(), [EMB4, RR4].sort(), 'both models are loaded in the one child');
  assert.ok(pidAlive(pid));
  const id = await G.identify(pid);
  await RPV.closeAll();
  assert.ok(await gone(id), 'closing the rerank providers closed the shared GPU child');
  assert.strictEqual(GS.isOpen(), false);
  assert.strictEqual(RPV.get(rerankTier), null, 'a closed provider is forgotten');
});

test('the embed providers closeAll closes the shared child too, and both are safe twice', async () => {
  R.install(); // a closed child latches the shared client until a new owner (or a test) opens it again
  const e = EP.get(heavyTier, { owner: true });
  await e.embedQuery('hello');
  const pid = GS.client().pid;
  const id = await G.identify(pid);
  await EP.closeAll();
  assert.ok(await gone(id));
  await EP.closeAll();
  await RPV.closeAll();
  assert.strictEqual(EP.get(heavyTier), null);
});

test('after close no GPU child is forked; a child that closed itself is not silently re-forked; a new pin recycles it', async () => {
  R.install();
  const e = EP.get(heavyTier, { owner: true });
  await e.embedQuery('x');
  const first = GS.client();
  await GS.close();
  assert.throws(() => GS.client(), (x) => x.code === 'E_MODEL_ABSENT' && x.detail.closing === true, 'a stopping owner or an in-flight drain forks nothing');
  await assert.rejects(e.embedQuery('y'), (x) => x.code === 'E_MODEL_ABSENT' && x.detail.cause === 'dead');
  R.install(); // reopened
  const second = EP.get(heavyTier, { owner: true });
  await second.embedQuery('z');
  const child = GS.client();
  assert.notStrictEqual(child, first);
  await child.close(); // the child closes itself, as it does on its wall-clock timeout
  assert.strictEqual(GS.client(), child, 'the dead child is returned as it is, not replaced');
  await assert.rejects(second.embedQuery('again'), (x) => x.code === 'E_MODEL_ABSENT' && x.detail.cause === 'dead', 'its coded error is the answer: no re-fork without a probe');
  assert.strictEqual(GS.recycle(), true, 'only a new pin (which probes first) forgets it');
  await second.embedQuery('fresh');
  assert.notStrictEqual(GS.client(), child, 'and then a new child serves');
  assert.strictEqual(GS.holds(EMB4), true);
});

test('a load that fails is a coded GPU error', async () => {
  await GS.close();
  const bad = rig({ fake: { load_fail: true } });
  bad.install();
  try {
    const e = EP.get(heavyTier, { owner: true });
    await assert.rejects(e.embedQuery('x'), (x) => x.code === 'E_INTERNAL' && x.detail.gpu === true && x.detail.cause === 'load_failed');
  } finally { await bad.restore(); R.install(); }
});
