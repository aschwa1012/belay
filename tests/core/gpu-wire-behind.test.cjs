'use strict';
// gpu-wire-behind.test.cjs — a pinned run's heavy tier found BEHIND mid-run (ADR 0050 decision 4): wait or fall back, never a hard failure.
// Rows reach the run's scope through other callers (an operator CLI write, another run, a memory job). The real memory.search then
//   - embeds them inline within a short bound and serves heavy;
//   - or serves THIS search on nano with tier_fallback { cause: 'behind' } and starts ONE background catch-up (not sticky, not a heavy failure);
//   - a real embed failure applies on_heavy_failure (sticky);
//   - outside the run's scope it still refuses by name.
// Also the re-pin's fresh reading (8 GB laptop numbers) and the profile_cpu fallback. A FAKE GPU child: no GPU, no runtime, no model.

process.env.BELAY_TEST_MODE = '1';
require('../helpers/tmp.cjs'); // this file starts processes: its own spawn register (spawn-register-isolation.test.cjs)
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./lifecycle-env.cjs');
const { core, callerFor } = require('./helpers.cjs');
const { rig, EMB4, RR4, MIB } = require('./fixtures/gpu-wire-rig.cjs');

const { Engine } = core('engine.cjs');
const HT = core('heavy-tier.cjs');
const HD = core('heavy-drain.cjs');
const HB = core('heavy-behind.cjs');
const EP = core('embed-provider.cjs');
const GS = core('gpu-shared.cjs');
const RP = core('retrieval-profiles.cjs');
const rows = core('rows.cjs');

let T, E, R;
const operator = (run) => callerFor('operator', { run_id: run });
const ns = (p) => `project/${p}`;
const attach = (run, levers) => E.handle('run.attach', { caller: operator(run), adapter_pid: process.pid, project: levers.project, memory_levers: JSON.stringify({ notes: false, ...levers }) });
const pin = (run, args = {}) => E.handle('run.pinRouting', { caller: operator(run), ...args });
const search = (run, p, args = {}) => E.handle('memory.search', { caller: operator(run), namespaces: [ns(p)], query: 'something to look for', mode: 'semantic', k: 100, ...args });
const fresh = (o) => { R = rig(o); R.install(); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// A run that is pinned on gpu-balanced and caught up.
async function pinnedRun(run, p, extra = {}) {
  for (let i = 0; i < 2; i += 1) T.note(`${p} seed ${'s'.repeat(i + 1)}`, { ns: ns(p), vec: [1, i / 10, 0] });
  await attach(run, { project: p, profile: 'gpu-balanced', ...extra });
  const first = await pin(run);
  for (const b of first.behind) await E.handle('memory.drainHeavy', { caller: operator(run), model: b.embedder, namespaces: b.namespaces });
  const done = await pin(run);
  assert.strictEqual(done.pinned, true);
}
// Rows another caller wrote into the run's scope (an operator CLI write: its run is not the pinned one).
const foreign = (p, n) => { for (let i = 0; i < n; i += 1) T.note(`${p} foreign ${i} ${'f'.repeat(i % 7)}`, { ns: ns(p), vec: [1, (i % 9) / 10, 0] }); };
// Makes the heavy provider slow, document by document, honouring the per-batch deadline as the real one does.
function slowEmbed(ms) {
  const impl = EP.get({ embedder: EMB4 }, { owner: E.owner }), orig = impl.embedDocs;
  impl.embedDocs = async (list, o) => { const out = []; for (const d of list) { if (out.length && o && o.deadline && Date.now() >= o.deadline) break; await sleep(ms); out.push(...await orig([d])); } return out; };
  return () => { impl.embedDocs = orig; };
}

before(async () => {
  R = rig(); R.install();
  T = await setup();
  E = new Engine({ dataDir: T.dir, store: T.store, establishedBy: 'test', getEmbedder: async () => ({ embed: async () => ({ embedding: [1, 0, 0], embedding_model: 'm' }) }), owner: { opts: {} } });
});
after(async () => { HB.setTestOptions(null); await R.restore(); T.close(); });

test('rows written by another caller are caught up inline within the bound, and the search is served heavy', async () => {
  await pinnedRun('bh-a', 'bha');
  const stored = await E.handle('memory.store', { caller: callerFor('operator', { run_id: 'cli' }), text: 'an operator import into the run scope', namespace: ns('bha'), embed: false });
  assert.strictEqual(HD.backlogOf(E, EMB4, [ns('bha')]).length, 1, 'the operator write left the heavy tier one row behind');
  const r = await search('bh-a', 'bha');
  assert.strictEqual(r.tier_fallback, undefined, 'caught up inline: served heavy');
  assert.strictEqual(r.tier.embedder, EMB4);
  assert.ok(r.results.some(x => x.id === stored.id));
  assert.strictEqual(HD.backlogOf(E, EMB4, [ns('bha')]).length, 0);
});

const idleWithin = (ms) => { let t; return Promise.race([HB.idle(E.owner), new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`the catch-up did not settle within ${ms} ms`)), ms); })]).finally(() => clearTimeout(t)); };
const gateOf = () => { let release; const gate = new Promise(r => { release = r; }); return { gate, release }; };

test('a large backlog is served on nano with cause behind (not sticky), one background catch-up runs, and later searches serve heavy again', async () => {
  await pinnedRun('bh-b', 'bhb');
  foreign('bhb', 120);
  const { gate, release } = gateOf(); // holds the background catch-up until the single-flight assertion has been made
  HB.setTestOptions({ inlineBoundMs: 250, catchUpGate: gate });
  const restore = slowEmbed(8);
  try {
    const r1 = await search('bh-b', 'bhb');
    assert.strictEqual(r1.tier_fallback.cause, 'behind');
    assert.ok(r1.tier_fallback.behind > 0 && r1.tier_fallback.behind <= 120, `behind ${r1.tier_fallback.behind}`);
    assert.strictEqual(r1.tier_fallback.to, 'cpu-fast');
    assert.ok(r1.modes_failed.some(m => m.mode === 'heavy_behind' && m.code === 'E_TIER_BEHIND'), JSON.stringify(r1.modes_failed));
    assert.match(r1.warning, /heavy_behind/);
    assert.strictEqual(HT.fallbackOf(E, 'bh-b'), null, 'not sticky, and not a heavy failure');
    assert.ok(r1.results.length >= 100, 'nano served the notes');
    await search('bh-b', 'bhb'); // a second search while the catch-up is held starts no second one
    assert.strictEqual(E.owner.catchUps.size, 1, 'single-flight per run and embedder');
    release();
    await idleWithin(30000);
  } finally { release(); restore(); HB.setTestOptions(null); }
  assert.strictEqual(HD.backlogOf(E, EMB4, [ns('bhb')]).length, 0, 'the catch-up finished the backlog');
  const r2 = await search('bh-b', 'bhb');
  assert.strictEqual(r2.tier_fallback, undefined, 'caught up: served heavy again');
  assert.strictEqual(r2.tier.embedder, EMB4);
});

test('the owner stop ends a background catch-up: a pass gated mid-flight writes no vector after the close', async () => {
  await pinnedRun('bh-c', 'bhc');
  foreign('bhc', 60);
  const held = gateOf(), mid = gateOf();
  HB.setTestOptions({ inlineBoundMs: 100, catchUpGate: held.gate });
  const restore = slowEmbed(10);
  const impl = EP.get({ embedder: EMB4 }, { owner: E.owner }), inner = impl.embedDocs;
  let blocking = false, entered;
  const inFlight = new Promise(r => { entered = r; });
  impl.embedDocs = async (list, o) => { if (!blocking) return inner(list, o); entered(); await mid.gate; return inner(list, o); };
  const MV = core('memory-vectors.cjs'), putVector = MV.putVector;
  let puts = 0;
  MV.putVector = (...a) => { puts += 1; return putVector(...a); };
  try {
    const r = await search('bh-c', 'bhc');
    assert.strictEqual(r.tier_fallback.cause, 'behind');
    assert.strictEqual(E.owner.catchUps.size, 1);
    blocking = true; held.release(); await inFlight; // the catch-up pass is now inside an embed
    await EP.closeOwned(E.owner, 100); // what Owner.stop() does: it cancels, and gives up waiting after its bound
    puts = 0;
    mid.release(); // the embed finishes after the close
    await idleWithin(30000);
    assert.strictEqual(E.owner.catchUps.size, 0, 'the catch-up has ended');
    assert.strictEqual(puts, 0, 'and wrote no vector after the stop');
  } finally { held.release(); mid.release(); MV.putVector = putVector; impl.embedDocs = inner; restore(); HB.setTestOptions(null); E.owner.catchUpsCancelled = false; GS.reopen(); }
});

test('a catch-up stops when its run has ended', async () => {
  await pinnedRun('bh-i', 'bhi');
  foreign('bhi', 40);
  const { gate, release } = gateOf();
  HB.setTestOptions({ inlineBoundMs: 60, catchUpGate: gate });
  const restore = slowEmbed(10);
  try {
    const r = await search('bh-i', 'bhi');
    assert.strictEqual(r.tier_fallback.cause, 'behind');
    const left = HD.backlogOf(E, EMB4, [ns('bhi')]).length;
    assert.ok(left > 0);
    await E.handle('run.end', { caller: operator('bh-i'), exit_reason: 'ended while its catch-up waited' });
    release();
    await idleWithin(30000);
    assert.strictEqual(HD.backlogOf(E, EMB4, [ns('bhi')]).length, left, 'no pass ran for an ended run');
  } finally { release(); restore(); HB.setTestOptions(null); }
});

test('a second E_TIER_BEHIND inside the guard (a write between the retry query embed and its candidates) serves THIS search on nano, never throws', async () => {
  await pinnedRun('bh-h', 'bhh');
  foreign('bhh', 1);
  const ST = core('search-tier.cjs'), candidates = ST.candidates;
  let late = 0;
  ST.candidates = (E2, tier, ...rest) => { if (tier.embedder !== RP.NANO) T.note(`a concurrent write ${late++}`, { ns: ns('bhh'), vec: [1, 0.5, 0] }); return candidates(E2, tier, ...rest); };
  try {
    const r = await search('bh-h', 'bhh');
    assert.strictEqual(r.tier_fallback.cause, 'behind');
    assert.ok(late >= 2, `the seam inserted before each heavy candidates call (${late})`);
    assert.strictEqual(HT.fallbackOf(E, 'bh-h'), null, 'still not sticky');
    assert.ok(r.results.length >= 3);
  } finally { ST.candidates = candidates; await idleWithin(30000); }
});

test('a row with no renderable text is not behind and not in the catch-up, with ONE warning; searches stay on the heavy tier', async () => {
  const bad = T.note('a row whose text is not text', { ns: ns('bhu'), vec: [1, 0.2, 0] });
  T.store.db.prepare('UPDATE memory_entries SET text = ? WHERE id = ?').run(Buffer.from([0, 1, 2]), bad);
  const warnings = [];
  const onW = (w) => { if (w.code === 'BELAY_UNRENDERABLE_ROW') warnings.push(w.message); };
  process.on('warning', onW);
  try {
    await pinnedRun('bh-u', 'bhu');
    assert.strictEqual(HD.backlogOf(E, EMB4, [ns('bhu')]).length, 0, 'not counted as behind');
    HD.backlogOf(E, EMB4, [ns('bhu')]);
    const r = await search('bh-u', 'bhu');
    assert.strictEqual(r.tier_fallback, undefined, 'served heavy: it does not keep every search on nano');
    assert.strictEqual(r.tier.embedder, EMB4);
    await new Promise(res => setImmediate(res)); // emitWarning delivers on the next tick
    assert.strictEqual(warnings.filter(m => m.includes(bad)).length, 1, 'one warning for the row, however often it is met');
  } finally { process.removeListener('warning', onW); }
});

test('a real embed failure is a heavy failure: sticky fallback with its cause, not a behind fallback', async () => {
  await R.restore(); fresh();
  await pinnedRun('bh-d', 'bhd');
  await R.restore(); fresh({ fake: { load_fail: true }, probe: { load_fail: false } });
  foreign('bhd', 3);
  const r = await search('bh-d', 'bhd');
  assert.strictEqual(typeof r.tier_fallback.cause, 'object', 'a failure cause, not the word behind');
  assert.strictEqual(r.tier_fallback.cause.code, 'E_INTERNAL');
  assert.ok(HT.fallbackOf(E, 'bh-d'), 'sticky on the run row');
  const next = await search('bh-d', 'bhd');
  assert.strictEqual(next.tier_fallback.to, 'cpu-fast', 'and in every later answer');
});

test('outside the run scope the heavy tier still refuses by name', async () => {
  await R.restore(); fresh();
  await pinnedRun('bh-e', 'bhe');
  T.note('a note of another project', { ns: ns('other'), vec: [1, 0.1, 0] });
  await assert.rejects(search('bh-e', 'other'), (e) => e.code === 'E_TIER_BEHIND', 'a scope the run does not own is not mid-run');
});

test('a re-pin takes one fresh reading: 8 GB laptop numbers fit; another program taking the memory is refused with the numbers', async () => {
  await R.restore();
  let others = 0; // MiB another program holds
  const smi = () => ({ name: 'NVIDIA GeForce RTX 5060 Laptop GPU', driver: '617.42', total_mb: 8151, used_mb: 0, free_mb: 7899 - others - (GS.holds(EMB4) ? 2622 : 0) - (GS.holds(RR4) ? 2763 : 0) });
  fresh({ fake: { per_model: { [EMB4]: 2622 * MIB, [RR4]: 2763 * MIB } }, smi });
  T.note('re-pin fixture', { ns: ns('bhf'), vec: [1, 0, 0] });
  await attach('bh-f', { project: 'bhf', profile: 'gpu-balanced' });
  const first = await pin('bh-f');
  assert.strictEqual(first.action, 'drain');
  await E.handle('memory.drainHeavy', { caller: operator('bh-f'), model: EMB4, namespaces: first.behind[0].namespaces });
  const ok = await pin('bh-f');
  assert.strictEqual(ok.pinned, true);
  assert.deepStrictEqual(ok.notices, [], 'the resident embedder is added back to the fresh reading: 5,277 + 2,622 covers 6,153');
  assert.strictEqual(ok.routing.run.profile, 'gpu-balanced');

  // the same run, re-pinned after another program took 2 GiB: the verdict is not trusted blindly
  others = 2000;
  const again = await pin('bh-f');
  assert.strictEqual(again.pinned, true);
  assert.deepStrictEqual(again.notices.map(n => n.code), ['gpu_probe_refused']);
  assert.match(again.notices[0].message, /needs 6153 MiB.*free now/);
  assert.strictEqual(again.routing.run.profile, 'cpu-fast');
});

test('profile_cpu: a failing model of profile_cpu itself falls back to the fallback profile, naming the model and the fetch command', async () => {
  await R.restore(); fresh({ probe: { vram_fail: true } });
  await attach('bh-g', { project: 'bhg', profile: 'gpu-balanced', profile_cpu: 'cpu-rerank-light' });
  const r = await pin('bh-g'); // the probe refuses; profile_cpu's reranker is not fetched in the sandbox, so its warm-up fails too
  assert.strictEqual(r.pinned, true);
  assert.deepStrictEqual(r.notices.map(n => n.code), ['gpu_probe_refused', 'retrieval_warmup_failed']);
  const warm = r.notices[1];
  assert.match(warm.message, /jinaai\/jina-reranker-v1-tiny-en/);
  assert.match(warm.message, /belay embedder fetch --reranker jinaai\/jina-reranker-v1-tiny-en/);
  assert.match(warm.message, /cpu-fast profile \(nano, no reranker\)/);
  assert.doesNotMatch(warm.message, /no heavy model/);
  assert.deepStrictEqual([r.routing.run.profile, r.routing.run.embedder, r.routing.run.reranker], ['cpu-fast', RP.NANO, null]);
  assert.strictEqual(rows.current(T.store, 'run', 'bh-g').retrieval_routing.includes('cpu-fast'), true);
});
