'use strict';
// gpu-wire-pin.test.cjs — run.pinRouting (ADR 0050 decisions 3, 4 and 6): the routing is resolved once, after the GPU probe, and recorded on the
// run row; a probe refusal is a loud tier failure handled by on_heavy_failure (fallback with ONE notice, or pause); a heavy embedder with a
// backlog is on_heavy_behind's business (wait drains, fallback demotes with ONE notice); a note written while the tier is live is also embedded
// by each heavy embedder in the routing, best effort. A FAKE GPU child and the real gpu-probe: no GPU, no runtime, no model.

process.env.BELAY_TEST_MODE = '1';
require('../helpers/tmp.cjs'); // this file starts processes: its own spawn register (spawn-register-isolation.test.cjs)
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./lifecycle-env.cjs');
const { core, callerFor } = require('./helpers.cjs');
const { rig, EMB4, RR4, RR06 } = require('./fixtures/gpu-wire-rig.cjs');

const { Engine } = core('engine.cjs');
const ST = core('search-tier.cjs');
const HT = core('heavy-tier.cjs');
const HD = core('heavy-drain.cjs');
const RP = core('retrieval-profiles.cjs');
const rows = core('rows.cjs');

let T, E, R;
const operator = (run) => callerFor('operator', { run_id: run });
const attach = (run, levers) => E.handle('run.attach', { caller: operator(run), adapter_pid: process.pid, project: levers.project, memory_levers: JSON.stringify({ notes: false, ...levers }) });
const pin = (run, args = {}) => E.handle('run.pinRouting', { caller: operator(run), ...args });
const rowOf = (run) => rows.current(T.store, 'run', run);
const pinned = (run) => (rowOf(run).retrieval_routing ? JSON.parse(rowOf(run).retrieval_routing) : null);
const spawnRow = (run, id, agent_type, extra = {}) => E.handle('worker.write', { caller: callerFor('orchestrator', { run_id: run }), id, state: 'running', pid: process.pid, substrate: 'claude-code', worktree: 'w', ...(agent_type ? { agent_type } : {}), ...extra });
const worker = (run, id, extra = {}) => callerFor('worker', { run_id: run, worker_id: id, ...extra });
const gpuRows = (model = EMB4) => T.store.db.prepare('SELECT COUNT(*) AS n FROM memory_vectors WHERE model = ?').get(model).n;

before(async () => {
  R = rig(); R.install();
  T = await setup();
  E = new Engine({ dataDir: T.dir, store: T.store, getEmbedder: null, owner: { opts: {} }, establishedBy: 'test' });
});
after(async () => { await R.restore(); T.close(); });

test('a run with the default levers pins nothing and stays on nano', async () => {
  await attach('pin-default', { project: 'pind' });
  const t = ST.tierFor(E, operator('pin-default'));
  assert.deepStrictEqual([t.embedder, t.reranker], [RP.NANO, null]);
  assert.strictEqual(rowOf('pin-default').retrieval_routing, null);
});

test('the probe runs for the routing GPU models, the routing is recorded, and each agent type gets its tier from its process-bound identity', async () => {
  await attach('pin-a', { project: 'pina', profile: 'gpu-rerank-fast', routing: { orchestrator: 'gpu-rerank', reviewer: 'cpu-fast' }, search_log: true }); // the log is off by default; the index test below reads it
  const r = await pin('pin-a');
  assert.strictEqual(r.pinned, true);
  assert.strictEqual(r.probe.ok, true);
  assert.deepStrictEqual(r.probe.models.slice().sort(), [RR4, RR06].sort(), 'the probe was asked about exactly the routing GPU models');
  assert.strictEqual(r.probe.headroom_mb, 768, 'the vram_headroom_gb lever, in MiB');
  assert.deepStrictEqual(r.notices, []);
  const rec = pinned('pin-a');
  assert.strictEqual(rec.routing.run.reranker, RR06);
  assert.strictEqual(rec.routing.tiers.reviewer.profile, 'cpu-fast');

  await spawnRow('pin-a', 'w-rev', 'reviewer');
  await spawnRow('pin-a', 'w-cod', 'coder');
  await spawnRow('pin-a', 'w-none', null);
  await spawnRow('pin-a', 'w-fake-orch', 'orchestrator'); // a row that names the role: ignored for a worker
  await spawnRow('pin-b', 'w-other-run', 'reviewer');
  const tier = (caller) => ST.tierFor(E, caller);
  assert.strictEqual(tier(callerFor('orchestrator', { run_id: 'pin-a' })).reranker, RR4, 'the orchestrator gets the orchestrator tier');
  assert.strictEqual(tier(worker('pin-a', 'w-rev')).profile, 'cpu-fast', 'a reviewer worker gets the reviewer tier');
  assert.strictEqual(tier(worker('pin-a', 'w-cod')).reranker, RR06, 'a coder, not routed, gets the run tier');
  assert.strictEqual(tier(worker('pin-a', 'w-none')).reranker, RR06, 'a worker spawned with no agent type gets the run tier');
  assert.strictEqual(tier(operator('pin-a')).reranker, RR06, 'an operator gets the run tier');
  assert.strictEqual(tier(callerFor('operator', { run_id: 'pin-a', channel: 'harness' })).reranker, RR06, 'the harness gets the run tier');
  assert.strictEqual(tier(worker('pin-a', 'w-unknown')).reranker, RR06, 'an unknown worker gets the run tier');
  assert.strictEqual(tier(worker('pin-a', 'w-other-run')).reranker, RR06, 'a worker row of another run does not answer');
});

test('a worker cannot claim the orchestrator tier, by its row, its identity or its request', async () => {
  const tier = (caller) => ST.tierFor(E, caller);
  assert.strictEqual(tier(worker('pin-a', 'w-fake-orch')).reranker, RR06, 'a worker row naming orchestrator reads as no type');
  const claim = worker('pin-a', 'w-rev', { agent_type: 'orchestrator', tier: 'orchestrator', role_type: 'orchestrator', tier_profile: 'gpu-rerank' });
  assert.strictEqual(tier(claim).profile, 'cpu-fast', 'fields a model could send are not read: only the row and the bound role are');
  const w = rows.current(T.store, 'worker', 'w-rev');
  assert.strictEqual(w.agent_type, 'reviewer');
  const sp = await E.handle('memory.search', { caller: claim, namespaces: ['project/pina'], query: 'x', mode: 'keyword', agent_type: 'orchestrator' }).catch((e) => e);
  assert.ok(sp instanceof Error ? sp.code === 'E_ARGS' : true, 'a request field naming a tier is refused or ignored, never obeyed');
});

test('the first-message index logs the tier that served (nano) and the pinned tier of the worker it is for', async () => {
  const harness = callerFor('orchestrator', { run_id: 'pin-a', channel: 'harness' });
  await E.handle('memory.index', { caller: harness, worker_id: 'w-rev', task_id: 't1' });
  await E.handle('memory.index', { caller: harness, worker_id: 'w-cod', task_id: 't2' });
  const ev = T.store.db.prepare("SELECT message FROM memory_event WHERE kind = 'index' ORDER BY id").all().map(r => JSON.parse(r.message));
  const byWorker = Object.fromEntries(ev.map(e => [e.for_worker, e.tier]));
  const pinnedOf = Object.fromEntries(ev.map(e => [e.for_worker, e.pinned_tier]));
  for (const w of ['w-rev', 'w-cod']) assert.deepStrictEqual([byWorker[w].embedder, byWorker[w].reranker], [RP.NANO, null], 'the index ranks on nano, so the tier that SERVED is nano');
  assert.strictEqual(pinnedOf['w-rev'].profile, 'cpu-fast', 'the reviewer worker pinned tier, not the orchestrator tier of the caller');
  assert.strictEqual(pinnedOf['w-cod'].reranker, RR06);
});

test('a probe refusal under on_heavy_failure fallback serves the fallback profile everywhere, with ONE notice', async () => {
  await R.restore(); R = rig({ probe: { vram_fail: true } }); R.install();
  await attach('pin-f', { project: 'pinf', profile: 'gpu-balanced', routing: { reviewer: 'gpu-rerank', coder: 'gpu-rerank-fast' } });
  const r = await pin('pin-f');
  assert.strictEqual(r.pinned, true);
  assert.strictEqual(r.probe.ok, false);
  assert.strictEqual(r.notices.length, 1, 'one notice, not one per role');
  assert.strictEqual(r.notices[0].code, 'gpu_probe_refused');
  assert.match(r.notices[0].message, /no usable Vulkan GPU|no_gpu/);
  assert.ok(r.notices[0].agent_types.includes('reviewer') && r.notices[0].agent_types.includes('coder'));
  const rec = pinned('pin-f');
  assert.deepStrictEqual(rec.routing.gpu_models, []);
  for (const t of [rec.routing.run, ...Object.values(rec.routing.tiers)]) assert.deepStrictEqual([t.profile, t.embedder, t.reranker], ['cpu-fast', RP.NANO, null]);
  const tier = ST.tierFor(E, callerFor('orchestrator', { run_id: 'pin-f' }));
  assert.deepStrictEqual([tier.profile, tier.reranker, tier.fallback_from], ['cpu-fast', null, 'gpu-balanced']);
});

test('a corrupt model file is a model_corrupt notice naming the model and file, and on_heavy_failure still decides', async () => {
  await R.restore(); R = rig({ fake: { load_fail: true, load_fail_msg: 'Invalid GGUF magic. Expected "GGUF" but got "0000".' } }); R.install();
  await attach('pin-c', { project: 'pinc', profile: 'gpu-rerank-fast' });
  const r = await pin('pin-c');
  assert.strictEqual(r.pinned, true, 'fallback: the run starts on the fallback profile, as for a probe refusal');
  assert.strictEqual(r.notices.length, 1);
  assert.strictEqual(r.notices[0].code, 'model_corrupt');
  assert.strictEqual(r.notices[0].reason, 'model_corrupt');
  assert.ok(r.notices[0].message.includes(`${RR06} (file m.gguf)`), r.notices[0].message);
  assert.doesNotMatch(r.notices[0].message, /probe refused/);
  assert.match(r.notices[0].options.join(' '), /belay embedder delete --gpu --model/);
  await attach('pin-c2', { project: 'pinc2', profile: 'gpu-rerank-fast', on_heavy_failure: 'pause' });
  await assert.rejects(pin('pin-c2'), (e) => e.code === 'E_MODEL_ABSENT' && e.detail.cause === 'model_corrupt' && /on_heavy_failure is pause/.test(e.message));
});

test('a probe refusal under on_heavy_failure pause refuses to pin, by name, and the run stays on nano', async () => {
  await attach('pin-p', { project: 'pinp', profile: 'gpu-rerank', on_heavy_failure: 'pause' });
  await assert.rejects(pin('pin-p'), (e) => e.code === 'E_MODEL_ABSENT' && e.detail.cause === 'probe_refused' && e.detail.refusal.reason === 'no_gpu' && /on_heavy_failure is pause/.test(e.message));
  assert.strictEqual(rowOf('pin-p').retrieval_routing, null);
  assert.strictEqual(ST.tierFor(E, operator('pin-p')).reranker, null);
});

test('on_heavy_behind wait: nothing is pinned until the backlog is drained, then the heavy tier is pinned', async () => {
  await R.restore(); R = rig(); R.install();
  for (let i = 0; i < 3; i += 1) T.note(`waiting note ${'x'.repeat(i * 3)}`, { ns: 'project/pinw', vec: [1, i / 10, 0] });
  await attach('pin-w', { project: 'pinw', profile: 'gpu-balanced', on_heavy_behind: 'wait' });
  const first = await pin('pin-w');
  assert.deepStrictEqual([first.pinned, first.action], [false, 'drain']);
  assert.deepStrictEqual(first.behind.map(b => [b.embedder, b.rows]), [[EMB4, 3]]);
  assert.strictEqual(rowOf('pin-w').retrieval_routing, null, 'a wait pins nothing yet');
  assert.strictEqual(ST.tierFor(E, operator('pin-w')).embedder, RP.NANO, 'the run is on nano until it is pinned: a heavy tier never serves a partial index');
  const d = await E.handle('memory.drainHeavy', { caller: operator('pin-w'), model: EMB4, namespaces: first.behind[0].namespaces });
  assert.deepStrictEqual([d.written, d.remaining, d.done], [3, 0, true]);
  const second = await pin('pin-w');
  assert.strictEqual(second.pinned, true);
  assert.strictEqual(second.behind.choice, null, 'nothing was behind when it was pinned');
  const tier = ST.tierFor(E, operator('pin-w'));
  assert.deepStrictEqual([tier.embedder, tier.reranker, tier.dims], [EMB4, RR4, 8]);
});

test('on_heavy_behind fallback: the heavy roles use nano for this run, with ONE notice and no drain', async () => {
  for (let i = 0; i < 2; i += 1) T.note(`fallback note ${'y'.repeat(i * 5)}`, { ns: 'project/pinx', vec: [1, i / 10, 0] });
  const before = gpuRows();
  await attach('pin-x', { project: 'pinx', profile: 'gpu-balanced', routing: { reviewer: { embedder: EMB4, reranker: 'none' } }, on_heavy_behind: 'fallback' });
  const r = await pin('pin-x');
  assert.strictEqual(r.pinned, true);
  assert.strictEqual(r.behind.choice, 'fallback');
  assert.deepStrictEqual(r.notices.map(n => n.code), ['heavy_behind'], 'one notice');
  assert.match(r.notices[0].message, /belay memory embed --model/);
  const rec = pinned('pin-x');
  assert.strictEqual(rec.routing.run.embedder, RP.NANO);
  assert.strictEqual(rec.routing.run.reranker, RR4, 'the reranker is kept');
  assert.strictEqual(rec.routing.tiers.reviewer.embedder, RP.NANO, 'every heavy role is demoted');
  assert.strictEqual(gpuRows(), before, 'nothing was drained');
});
