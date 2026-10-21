'use strict';
// gpu-wire-write.test.cjs — rows written in a run reach its pinned heavy tiers, and the pin's own guarantees (ADR 0050 decisions 3, 4 and 6).
// Everything here drives the REAL start path (run.pinRouting) and the REAL memory.search after the triggering event; no tier is injected.
// A FAKE GPU child and the real gpu-probe: no GPU, no runtime, no model.
//   B1 any memory write embeds its rows with each heavy embedder before it returns; a failure is the backlog AND on_heavy_failure
//   B3 a re-pin after a drain keeps the first probe's verdict (8 GB laptop numbers)
//   S1 the pin merges onto the FRESH row    S2 the sticky fallback is on the row, in every answer, in status, and ends with its epoch
//   S5 the pin warms every pinned model, CPU reranker included; a warm-up failure is a tier failure

process.env.BELAY_TEST_MODE = '1';
require('../helpers/tmp.cjs'); // this file starts processes: its own spawn register (spawn-register-isolation.test.cjs)
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./lifecycle-env.cjs');
const { core, callerFor } = require('./helpers.cjs');
const { rig, EMB4, EMB06, RR4, MIB } = require('./fixtures/gpu-wire-rig.cjs');

const { Engine } = core('engine.cjs');
const HT = core('heavy-tier.cjs');
const HD = core('heavy-drain.cjs');
const GS = core('gpu-shared.cjs');
const RV = core('retrieval-view.cjs');
const RPV = core('rerank-provider.cjs');
const RP = core('retrieval-profiles.cjs');
const rows = core('rows.cjs');
const JINA = 'jinaai/jina-reranker-v1-tiny-en';

let T, E, R, seen;
const operator = (run) => callerFor('operator', { run_id: run });
const attach = (run, levers) => E.handle('run.attach', { caller: operator(run), adapter_pid: process.pid, project: levers.project, memory_levers: JSON.stringify({ notes: false, ...levers }) });
const pin = (run, args = {}) => E.handle('run.pinRouting', { caller: operator(run), ...args });
const rowOf = (run) => rows.current(T.store, 'run', run);
const ns = (p) => `project/${p}`;
const fresh = (o) => { R = rig(o); R.install(); return R; };
const backlog = (p) => HD.backlogOf(E, EMB4, [ns(p)]).length;
const store = (run, p, text) => E.handle('memory.store', { caller: operator(run), text, namespace: ns(p), embed: false });
const search = (run, p, args = {}) => E.handle('memory.search', { caller: operator(run), namespaces: [ns(p)], query: 'something to look for', mode: 'semantic', k: 50, ...args });
// A gpu-balanced run with `n` notes, drained and pinned (on_heavy_behind wait is the default).
async function pinnedRun(run, p, extra = {}, n = 2) {
  for (let i = 0; i < n; i += 1) T.note(`${p} seed note ${'s'.repeat(i + 1)}`, { ns: ns(p), vec: [1, i / 10, 0] });
  await attach(run, { project: p, profile: 'gpu-balanced', ...extra });
  const first = await pin(run);
  assert.strictEqual(first.action, 'drain', JSON.stringify([first.notices, first.probe]));
  for (const b of first.behind) await E.handle('memory.drainHeavy', { caller: operator(run), model: b.embedder, namespaces: b.namespaces });
  const done = await pin(run);
  assert.strictEqual(done.pinned, true);
  return done;
}

before(async () => {
  R = fresh();
  T = await setup();
  seen = [];
  E = new Engine({
    dataDir: T.dir, store: T.store, establishedBy: 'test',
    getEmbedder: async () => ({ embed: async () => ({ embedding: [1, 0, 0], embedding_model: 'm' }) }), // nano
    owner: { opts: { onEmbedderFailure: (f) => seen.push(f) } },
  });
});
after(async () => { await R.restore(); T.close(); });
afterEach(() => { RPV.unregister(JINA); });

test('B1: a memory.store in a pinned heavy run is embedded by the heavy embedder before it returns, and the next heavy search succeeds', async () => {
  await pinnedRun('wr-a', 'wra');
  const stored = await store('wr-a', 'wra', 'a note stored by memory.store during the run');
  assert.ok(stored.id);
  assert.strictEqual(backlog('wra'), 0, 'the write left no heavy backlog');
  for (const mode of ['semantic', 'hybrid']) {
    const r = await search('wr-a', 'wra', { mode });
    assert.ok(r.results.some(x => x.id === stored.id), `${mode}: the new note is found`);
    assert.strictEqual(r.tier.embedder, EMB4, `${mode}: served on the pinned heavy tier`);
    assert.strictEqual(r.tier_fallback, undefined);
    assert.ok(!r.modes_failed.length, JSON.stringify(r.modes_failed));
  }
});

test('B1: a failing heavy embed under on_heavy_failure fallback leaves the row behind, records the fallback on the run row, and the next search is served on nano with tier_fallback', async () => {
  await R.restore(); fresh({ fake: { load_fail: true }, probe: { load_fail: false } }); // the shared child will not load; the probe's own child does
  const stored = await store('wr-a', 'wra', 'a note whose heavy embed fails');
  assert.ok(stored.id, 'the write itself is never failed');
  assert.strictEqual(backlog('wra'), 1, 'the row stays in the heavy backlog');
  const fb = HT.fallbackOf(E, 'wr-a');
  assert.ok(fb && fb.cause.code, 'the fallback is on the run row');
  assert.strictEqual(RV.describe(rowOf('wr-a')).fallback.cause.code, fb.cause.code);
  for (let i = 0; i < 2; i += 1) { // EVERY answer says so, not only the first
    const r = await search('wr-a', 'wra', { mode: 'hybrid', query: 'heavy embed fails' });
    assert.strictEqual(r.tier_fallback.to, 'cpu-fast', `search ${i}`);
    assert.ok(r.modes_failed.some(m => m.mode === 'heavy_embed'), JSON.stringify(r.modes_failed));
    assert.ok(r.results.some(x => x.id === stored.id), 'served on nano, which has the note');
  }
  assert.ok(RV.lines(RV.describe(rowOf('wr-a'))).some(l => /WARNING retrieval/.test(l)), 'status renders the fallback');
  // A new epoch (a resume attaches again) ends the fallback, as the rerank sticky does.
  await E.handle('run.attach', { caller: operator('wr-a'), adapter_pid: process.pid });
  assert.strictEqual(HT.fallbackOf(E, 'wr-a'), null);
  assert.strictEqual(RV.describe(rowOf('wr-a')).fallback, null);
  assert.strictEqual(RV.describe(rowOf('wr-a')).profile, 'gpu-balanced', 'the pin itself is carried across the epoch');
});

test('B1: under on_heavy_failure pause a failing heavy embed tells the run hook (heavy_embed), records no fallback, and the heavy search refuses by name', async () => {
  await R.restore(); fresh();
  await pinnedRun('wr-p', 'wrp', { on_heavy_failure: 'pause' });
  await R.restore(); fresh({ fake: { load_fail: true }, probe: { load_fail: false } });
  seen.length = 0;
  const stored = await store('wr-p', 'wrp', 'a note whose heavy embed fails under pause');
  assert.ok(stored.id);
  assert.strictEqual(seen.length, 1, 'the run hook was told once');
  assert.strictEqual(seen[0].call, 'memory.store');
  assert.strictEqual(seen[0].error.detail.stage, 'heavy_embed');
  assert.strictEqual(HT.fallbackOf(E, 'wr-p'), null);
  assert.strictEqual(backlog('wrp'), 1);
  await assert.rejects(search('wr-p', 'wrp'), (e) => e.detail && e.detail.stage === 'heavy_embed' && e.detail.cause === 'load_failed', 'mid-run the search catches the row up inline; the real failure under pause is loud, not a hard E_TIER_BEHIND');
});

test('B1: the embed after a write has ONE total deadline across embedders, and reaching it is not a failure', async () => {
  await R.restore(); fresh();
  // two heavy embedders in the routing: the run's gpu-balanced one and a reviewer's own
  await pinnedRun('wr-d', 'wrd', { routing: { reviewer: { embedder: EMB06, reranker: 'none' } } });
  const HN = core('heavy-notes.cjs'), EP = core('embed-provider.cjs');
  await store('wr-d', 'wrd', 'a row whose embed outlives the deadline');
  const t0 = Date.now();
  T.note('another row written outside the call', { ns: ns('wrd'), vec: [1, 0.3, 0] });
  const slow = new Map(), calls = [];
  let release; const gate = new Promise(r => { release = r; });
  for (const id of [EMB4, EMB06]) {
    const impl = EP.get({ embedder: id }, { owner: E.owner });
    slow.set(id, impl.embedDocs);
    impl.embedDocs = async (list, o) => { calls.push(id); await gate; return slow.get(id)(list, o); };
  }
  E.owner.catchUpsCancelled = true; // the background catch-up the deadline starts must not add its own embed calls to the count
  const res = await HN.afterWrite(E, operator('wr-d'), 'memory.store', 150, t0);
  assert.strictEqual(res.deadline, true);
  assert.deepStrictEqual(res.failed, [], 'a deadline is not a failure');
  assert.strictEqual(HT.fallbackOf(E, 'wr-d'), null, 'and applies no on_heavy_failure');
  assert.strictEqual(calls.length, 1, 'the first embedder was started and the deadline was shared: the second was never started');
  release();
  await res.settled; // the abandoned work finishes through the seam, so it cannot touch the next test
  for (const [id, f] of slow) EP.get({ embedder: id }, { owner: E.owner }).embedDocs = f;
  await core('heavy-behind.cjs').idle(E.owner);
  E.owner.catchUpsCancelled = false;
});

test('B1: only the rows the call wrote are embedded, and a method that wrote no row embeds nothing', async () => {
  await R.restore(); fresh();
  await pinnedRun('wr-o', 'wro');
  const foreign = T.note('a row written by someone else', { ns: ns('wro'), vec: [1, 0.2, 0] }); // another caller, another run
  const EP = core('embed-provider.cjs'), impl = EP.get({ embedder: EMB4 }, { owner: E.owner });
  const orig = impl.embedDocs, seenDocs = [];
  impl.embedDocs = async (list, o) => { seenDocs.push(list.length); return orig(list, o); };
  try {
    const own = await store('wr-o', 'wro', 'the row this call wrote');
    assert.deepStrictEqual(seenDocs, [1], 'one document: the call own row, not the whole backlog');
    assert.ok(HD.backlogOf(E, EMB4, [ns('wro')]).some(r => r.id === foreign), "someone else's row is left to the catch-up");
    assert.ok(!HD.backlogOf(E, EMB4, [ns('wro')]).some(r => r.id === own.id));
    seenDocs.length = 0;
    await E.handle('memory.stats', { caller: operator('wr-o') });
    await E.handle('memory.setStatus', { caller: operator('wr-o'), id: own.id, status: 'verified', receipt: 'test:ok' }).catch(() => {});
    assert.deepStrictEqual(seenDocs, [], 'a method that wrote no row (or no new text) embeds nothing');
  } finally { impl.embedDocs = orig; }
});

test('B3: a re-pin after a wait drain keeps the first probe verdict (8 GB laptop: 7,899 MiB free, 4B embedder 2,622, 4B reranker 2,763, headroom 768)', async () => {
  await R.restore();
  // free memory as nvidia-smi would say it: the card, less what the shared child already holds
  const smi = () => ({ name: 'NVIDIA GeForce RTX 5060 Laptop GPU', driver: '617.42', total_mb: 8151, used_mb: 0, free_mb: 7899 - (GS.holds(EMB4) ? 2622 : 0) });
  fresh({ fake: { per_model: { [EMB4]: 2622 * MIB, [RR4]: 2763 * MIB } }, smi });
  const done = await pinnedRun('wr-b3', 'wrb3', {}, 3);
  assert.strictEqual(done.probe.ok, true, JSON.stringify([done.probe, done.notices]));
  assert.deepStrictEqual(done.notices, [], 'no spurious refusal after the drain');
  assert.strictEqual(done.routing.run.profile, 'gpu-balanced');
  assert.strictEqual(done.probe.needed_mb, 2622 + 2763 + 768);
  assert.strictEqual(smi().free_mb, 7899 - 2622, 'the embedder really was resident when the second pin ran: a fresh probe would have been refused');
});

test('S1: the pin merges onto the fresh row: a run that ended while the probe ran is refused, and a pause set meanwhile survives', async () => {
  await R.restore(); fresh();
  const ok = { ok: true, device: { name: 'x' }, needed_mb: 1, free_mb: 9, headroom_mb: 768, models: [RR4], rerank: {} };
  const probeThen = async (fn) => { await GS.close(); /* forgets the first run's verdict */ GS.setTestOptions({ clientOpts: R.clientOpts, probe: async () => { await fn(); return ok; } }); };
  await attach('wr-s1', { project: 'wrs1', profile: 'gpu-rerank' });
  await probeThen(() => E.handle('run.end', { caller: operator('wr-s1'), exit_reason: 'ended during the probe' }));
  await assert.rejects(pin('wr-s1'), (e) => e.code === 'E_ARGS' && /ended while its routing was being resolved/.test(e.message));
  const ended = rowOf('wr-s1');
  assert.notStrictEqual(ended.ended_at, null, 'the run stays ended: nothing resurrected it');
  assert.strictEqual(ended.retrieval_routing, null);

  await attach('wr-s1b', { project: 'wrs1b', profile: 'gpu-rerank' });
  await probeThen(() => E.handle('run.setPaused', { caller: operator('wr-s1b'), paused: true, by: 'operator' }));
  const r = await pin('wr-s1b');
  assert.strictEqual(r.pinned, true);
  const row = rowOf('wr-s1b');
  assert.notStrictEqual(row.paused_at, null, 'the pause set while the probe ran was not cleared by a stale copy');
  assert.ok(row.retrieval_routing);
});

test('S5: the pin warms every pinned model (heavy embedder and GPU reranker) before the run, and records it', async () => {
  await R.restore(); fresh();
  const done = await pinnedRun('wr-w1', 'wrw1');
  assert.deepStrictEqual(done.warm.map(w => [w.model, w.kind]).sort(), [[EMB4, 'embedder'], [RR4, 'reranker']].sort());
  const ping = await GS.client().ping(2000);
  assert.deepStrictEqual([...ping.models].sort(), [EMB4, RR4].sort(), 'both are already loaded: the first rerank pays no cold load');
  assert.ok(RV.describe(rowOf('wr-w1')).warm.length === 2);
});

test('S5: a pinned CPU reranker is warmed too', async () => {
  await R.restore(); fresh();
  const calls = [];
  RPV.register(JINA, { rerank: async (a) => { calls.push(a); return { scores: a.docs.map((d) => ({ id: d.id, score: 1 })), model: JINA, device: 'cpu', ms: 1 }; } });
  await attach('wr-w2', { project: 'wrw2', profile: 'cpu-rerank-light' });
  const r = await pin('wr-w2');
  assert.strictEqual(r.pinned, true);
  assert.strictEqual(calls.length, 1, 'one tiny real rerank loaded the model');
  assert.deepStrictEqual(r.warm.map(w => [w.model, w.kind]), [[JINA, 'reranker']]);
});

test('S5: a warm-up failure is a tier failure: fallback pins the fallback profile with ONE notice, pause refuses', async () => {
  await R.restore(); fresh({ fake: { load_fail: true }, probe: { load_fail: false } }); // the probe passes, the shared child cannot load
  await attach('wr-w3', { project: 'wrw3', profile: 'gpu-balanced' });
  const r = await pin('wr-w3');
  assert.strictEqual(r.pinned, true);
  assert.deepStrictEqual(r.notices.map(n => n.code), ['retrieval_warmup_failed']);
  assert.match(r.notices[0].message, /warming .* failed/);
  assert.deepStrictEqual([r.routing.run.profile, r.routing.run.embedder, r.routing.run.reranker, r.routing.run.fallback_from], ['cpu-fast', RP.NANO, null, 'gpu-balanced']);
  await attach('wr-w4', { project: 'wrw4', profile: 'gpu-balanced', on_heavy_failure: 'pause' });
  await assert.rejects(pin('wr-w4'), (e) => e.code === 'E_MODEL_ABSENT' && e.detail.cause === 'warmup_failed' && /on_heavy_failure is pause/.test(e.message));
  assert.strictEqual(rowOf('wr-w4').retrieval_routing, null);
});

test('B2 (owner side): a drain the caller reports failed pins the demoted routing with ONE heavy_drain_failed notice', async () => {
  await R.restore(); fresh();
  for (let i = 0; i < 2; i += 1) T.note(`wrd2 note ${'q'.repeat(i + 1)}`, { ns: ns('wrd2'), vec: [1, i / 10, 0] });
  await attach('wr-b2', { project: 'wrd2', profile: 'gpu-balanced' });
  const first = await pin('wr-b2');
  assert.strictEqual(first.action, 'drain');
  const r = await pin('wr-b2', { drain_failed: [{ embedder: EMB4, code: 'E_MODEL_ABSENT', message: 'the GPU process exited' }] });
  assert.strictEqual(r.pinned, true);
  assert.deepStrictEqual(r.notices.map(n => n.code), ['heavy_drain_failed']);
  assert.strictEqual(r.routing.run.embedder, RP.NANO);
  assert.strictEqual(r.behind.choice, 'fallback');
});
