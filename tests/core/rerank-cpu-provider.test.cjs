'use strict';
// rerank-cpu-provider.test.cjs — what a CPU rerank returns: chunking and progress, truncation, the provider's output
// shape and ordering, and the bound turning into a coded timeout. The REAL rerank-worker.cjs runs on a stub
// transformers package (fixtures/rerank-stub-pkg.cjs): no model, no onnx runtime.

process.env.BELAY_TEST_MODE = '1';
const { test } = require('node:test');
const fs = require('node:fs');
const assert = require('node:assert');
const { core, sandbox, cleanup } = require('./helpers.cjs');
const { writeStubPackage, writeCache, fakeEntry } = require('./fixtures/rerank-stub-pkg.cjs');

const { CpuRerankClient, cpuRerankProvider } = core('rerank-cpu.cjs');
const { pidAlive } = core('lock.cjs');
const { waitGone, waitFor, countProgress, UP_DEADLINE } = require('../helpers/wait.cjs');
const { fakeTimers, outcome } = require('../helpers/fake-timers.cjs');
const G = require('../helpers/proc-gone.cjs'); // waitGone takes the identity (or the handle) of a process, never a bare pid that may be handed to another process (ADR 0039)

// Timing: a bound the provider enforces is asserted on an INJECTED clock (the `timers` option): wait for the child's own
// message, advance to bound - 1 (still pending) and then 1 (the coded timeout). A wait on a child is an event with a
// generous deadline, never a sleep; a fake child delay only has to be longer than the test's own steps.
const crash = async (client, code) => { const exited = waitFor({ emitter: client.child, event: 'exit' }); client.child.send({ id: 990 + code, op: 'crash', code }); await exited; };

function rig(stub = {}) {
  const dir = sandbox(), entry = fakeEntry();
  const pkg = writeStubPackage(`${dir}/pkg`, stub), cache = `${dir}/cache`;
  const table = { [entry.id]: entry };
  writeCache(cache, table);
  return { dir, pkg, cache, table, entry, id: entry.id, done: () => cleanup(dir), provider: (o = {}) => cpuRerankProvider({ model: entry.id, pkg, cacheDir: cache, table, ...o }) };
}
const NOTES = [
  { id: 'n-filler-1', text: 'colour palette for the settings page' },
  { id: 'n-stop', text: 'stop a worker process safely by its pid' },
  { id: 'n-filler-2', text: 'release notes formatting guide' },
  { id: 'n-pid', text: 'a worker pid is checked against one snapshot before it is killed' },
  { id: 'n-filler-3', text: 'lunch order for friday' },
];
const QUERY = 'stop a worker process by its pid';

test('rank goes out in chunks: one progress line and one chunk per model call, scores in input order, chunking changes no score', async () => {
  const r = rig();
  const c = new CpuRerankClient({ pkg: r.pkg, cacheDir: r.cache, table: r.table }).start();
  try {
    await c.load(r.id);
    const docs = Array.from({ length: 23 }, (_, i) => (i === 17 ? 'stop the worker by pid' : `filler note number ${i}`));
    const seen = [];
    c.child.on('message', (m) => { if (m.progress && m.progress.total === 23) seen.push(m.progress.done); });
    const chunked = await c.rank(r.id, 'stop worker pid', docs, { chunk: 10 });
    assert.deepStrictEqual(chunked.chunks.map(x => x.n), [10, 10, 3]);
    assert.deepStrictEqual(seen, [10, 20, 23], 'a progress line after every chunk');
    assert.strictEqual(chunked.scores.length, 23);
    assert.strictEqual(chunked.scores.indexOf(Math.max(...chunked.scores)), 17, 'the relevant document is the best, at its own index');
    const whole = await c.rank(r.id, 'stop worker pid', docs, { chunk: 100 });
    assert.deepStrictEqual(whole.chunks.map(x => x.n), [23], 'a large chunk sends one model call');
    assert.deepStrictEqual(whole.scores, chunked.scores, 'chunking changes no score');
    const dflt = await c.rank(r.id, 'stop worker pid', docs);
    assert.deepStrictEqual(dflt.chunks.map(x => x.n), [10, 10, 3], 'the default chunk is ten pairs');
    assert.ok(chunked.scores.every(s => s > 0 && s < 1), 'sigmoid scores');
    assert.ok(chunked.scores[17] > 0.5 && chunked.scores[0] < 0.5, 'the logit is 4 * overlap - 2 on the stub');
  } finally { await c.close(); r.done(); }
});

test('truncation: a pair at the model\'s max_length is counted, max_length can only be lowered, and the cut is reported', async () => {
  const r = rig();
  const c = new CpuRerankClient({ pkg: r.pkg, cacheDir: r.cache, table: r.table }).start();
  try {
    await c.load(r.id);
    const long = 'word '.repeat(200), short = 'a note';
    let out = await c.rank(r.id, 'word', [short, long, short, long, long], { chunk: 2 });
    assert.strictEqual(out.max_length, 32);
    assert.strictEqual(out.truncated, 3, 'three pairs reached 32 tokens');
    assert.deepStrictEqual(out.chunks.map(x => x.seq_len), [32, 32, 32], 'every chunk padded to the longest pair, which is capped');
    out = await c.rank(r.id, 'word', [short, short]);
    assert.strictEqual(out.truncated, 0);
    assert.ok(out.chunks[0].seq_len < 32);
    out = await c.rank(r.id, 'word', [short, 'a longer note of about forty words '.repeat(2)], { maxLength: 16 });
    assert.strictEqual(out.max_length, 16, 'a lower maxLength is honoured');
    assert.strictEqual(out.truncated, 1);
    out = await c.rank(r.id, 'word', [short], { maxLength: 4096 });
    assert.strictEqual(out.max_length, 32, 'a higher maxLength is not');
  } finally { await c.close(); r.done(); }
});

test('a two-logit head scores the second column minus the first; a non-finite score is a coded child error', async () => {
  const r = rig({ twoLogits: true });
  const c = new CpuRerankClient({ pkg: r.pkg, cacheDir: r.cache, table: r.table }).start();
  try {
    await c.load(r.id);
    const out = await c.rank(r.id, 'stop worker pid', ['stop the worker by pid', 'lunch']);
    assert.deepStrictEqual(out.logits, [10, -2]);
    assert.ok(out.scores[0] > 0.99 && out.scores[1] < 0.2);
  } finally { await c.close(); }
  const bad = rig({ nanAt: 1 });
  const c2 = new CpuRerankClient({ pkg: bad.pkg, cacheDir: bad.cache, table: bad.table }).start();
  try {
    await c2.load(bad.id);
    await assert.rejects(c2.rank(bad.id, 'q', ['a', 'b']), (e) => e.code === 'E_INTERNAL' && e.detail.cause === 'op_failed' && /pair 1 scored NaN/.test(e.message));
  } finally { await c2.close(); bad.done(); r.done(); }
});

test('the provider answers { scores, model, device, ms }: best first, each id once with its score, ties in input order', async () => {
  const r = rig(), rerank = r.provider();
  try {
    const out = await rerank({ query: QUERY, docs: NOTES, depth: 50, boundMs: 20000 });
    assert.deepStrictEqual(Object.keys(out).sort(), ['device', 'model', 'ms', 'scores']);
    assert.deepStrictEqual([out.model, out.device], [r.id, 'cpu']);
    assert.ok(Number.isInteger(out.ms) && out.ms >= 0);
    assert.strictEqual(out.scores.length, NOTES.length);
    assert.deepStrictEqual(out.scores.map(s => Object.keys(s).sort()), NOTES.map(() => ['id', 'score']));
    assert.deepStrictEqual(out.scores.slice(0, 2).map(s => s.id).sort(), ['n-pid', 'n-stop'], 'the two relevant notes beat the filler');
    assert.deepStrictEqual(out.scores.slice(2).map(s => s.id), ['n-filler-1', 'n-filler-2', 'n-filler-3'], 'equal scores keep input order');
    for (let i = 1; i < out.scores.length; i += 1) assert.ok(out.scores[i - 1].score >= out.scores[i].score);
    assert.ok(out.scores[0].score > out.scores[4].score, 'the scores are not flat');
    assert.strictEqual(out.warnings, undefined);
    assert.strictEqual(rerank.model, r.id);
  } finally { await rerank.close(); r.done(); }
});

test('depth scores only the first depth docs; no docs is an empty answer with no child started; bad arguments are E_ARGS', async () => {
  const r = rig(), rerank = r.provider();
  try {
    assert.deepStrictEqual(await rerank({ query: QUERY, docs: [], depth: 5 }), { scores: [], model: r.id, device: 'cpu', ms: 0 });
    const out = await rerank({ query: QUERY, docs: NOTES, depth: 3 });
    assert.deepStrictEqual(out.scores.map(s => s.id).sort(), ['n-filler-1', 'n-filler-2', 'n-stop']);
    for (const bad of [{ query: 7, docs: NOTES }, { query: 'q', docs: 'x' }, { query: 'q', docs: [{ id: 1 }] }, { query: 'q', docs: NOTES, depth: 0 }, { query: 'q', docs: NOTES, depth: 1.5 }, { query: 'q', docs: NOTES, boundMs: -1 }, { query: 'q', docs: NOTES, boundMs: 'soon' }]) {
      await assert.rejects(rerank(bad), (e) => e.code === 'E_ARGS', JSON.stringify(bad).slice(0, 60));
    }
    assert.throws(() => cpuRerankProvider({}), (e) => e.code === 'E_ARGS');
    assert.throws(() => cpuRerankProvider({ model: 'nope/none' }), (e) => e.code === 'E_ARGS');
  } finally { await rerank.close(); r.done(); }
});

test('a pair cut at max_length is reported as a RERANK_TRUNCATED warning that names the count and the limit', async () => {
  const r = rig(), rerank = r.provider();
  try {
    const docs = [{ id: 'long', text: 'worker '.repeat(100) }, { id: 'short', text: 'worker pid' }];
    const out = await rerank({ query: 'worker', docs });
    assert.strictEqual(out.warnings.length, 1);
    assert.deepStrictEqual([out.warnings[0].code, out.warnings[0].truncated, out.warnings[0].max_length], ['RERANK_TRUNCATED', 1, 32]);
    assert.match(out.warnings[0].message, /1 of 2 pairs reached the model's 32-token limit/);
  } finally { await rerank.close(); r.done(); }
});

test('the first call loads once; later calls reuse the child; close ends it', async () => {
  const r = rig(), rerank = r.provider();
  let pid = null;
  try {
    const client = new CpuRerankClient({ pkg: r.pkg, cacheDir: r.cache, table: r.table });
    const shared = cpuRerankProvider({ model: r.id, client });
    await Promise.all([shared({ query: QUERY, docs: NOTES }), shared({ query: QUERY, docs: NOTES })]);
    pid = client.pid;
    assert.deepStrictEqual((await client.ping(UP_DEADLINE)).models, [r.id], 'one load for two simultaneous first calls');
    await shared({ query: QUERY, docs: NOTES });
    assert.strictEqual(client.pid, pid, 'the same child');
    const id = await G.identify(pid);
    await shared.close();
    assert.ok(await waitGone(id), 'close ended the child');
  } finally { await rerank.close(); r.done(); }
});

test('a model that is not fetched fails each call with the command, and works the call after it is fetched', async () => {
  const r = rig(), empty = sandbox();
  const rerank = cpuRerankProvider({ model: r.id, pkg: r.pkg, cacheDir: empty, table: r.table });
  try {
    for (let i = 0; i < 2; i += 1) await assert.rejects(rerank({ query: QUERY, docs: NOTES }), (e) => e.code === 'E_MODEL_ABSENT' && e.detail.cause === 'absent' && e.detail.command === `belay embedder fetch --reranker ${r.id}`);
    writeCache(empty, r.table);
    const out = await rerank({ query: QUERY, docs: NOTES });
    assert.strictEqual(out.scores.length, NOTES.length);
  } finally { await rerank.close(); cleanup(empty); r.done(); }
});

test('the bound during a rerank is a coded timeout, the abandoned child is closed, and the next call starts a fresh one', async () => {
  const r = rig({ rankDelayMs: 800 });
  const ft = fakeTimers();
  const client = new CpuRerankClient({ pkg: r.pkg, cacheDir: r.cache, table: r.table });
  const rerank = cpuRerankProvider({ model: r.id, client, chunk: 1, timers: ft.timers });
  try {
    await rerank({ query: QUERY, docs: NOTES.slice(0, 1), boundMs: 20000 }); // loads, and warms the child
    const first = client.pid;
    const firstId = await G.identify(first);
    const progress = countProgress(client.child);
    const call = outcome(rerank({ query: QUERY, docs: NOTES, boundMs: 400 }));
    await progress.reach(1); // the child is ranking: its first chunk has come back, four more are to come
    await ft.advance(399);
    assert.strictEqual(call.settled, false, 'still pending at bound - 1');
    await ft.advance(1);
    assert.ok(call.error && call.error.code === 'E_EMBEDDER_TIMEOUT' && call.error.detail.cause === 'timeout' && call.error.detail.reranker === true && call.error.detail.bound_ms === 400 && call.error.detail.phase === 'ranking', call.error && call.error.message);
    assert.ok(await waitGone(firstId), 'the abandoned child was closed');
    const out = await rerank({ query: QUERY, docs: NOTES.slice(0, 2), boundMs: 20000 });
    assert.strictEqual(out.scores.length, 2);
  } finally { await rerank.close(); r.done(); }
});

test('the bound during the first load is a coded timeout that leaves the load running, so a later call finds the model ready', async () => {
  const r = rig({ loadDelayMs: 1500 });
  const ft = fakeTimers();
  const client = new CpuRerankClient({ pkg: r.pkg, cacheDir: r.cache, table: r.table });
  const rerank = cpuRerankProvider({ model: r.id, client, timers: ft.timers });
  try {
    const call = outcome(rerank({ query: QUERY, docs: NOTES, boundMs: 150 }));
    await ft.advance(149);
    assert.strictEqual(call.settled, false, 'still pending at bound - 1');
    await ft.advance(1);
    assert.ok(call.error && call.error.code === 'E_EMBEDDER_TIMEOUT' && call.error.detail.phase === 'loading the model' && call.error.detail.bound_ms === 150, call.error && call.error.message);
    const pid = client.pid;
    assert.ok(pidAlive(pid), 'the child was not closed');
    const out = await rerank({ query: QUERY, docs: NOTES, boundMs: 20000 });
    assert.strictEqual(client.pid, pid, 'the same child, loaded once');
    assert.strictEqual(out.scores.length, NOTES.length);
  } finally { await rerank.close(); r.done(); }
});

test('after a crash the NEXT call builds a new client and reloads the model, once per call; a failed reload fails that call with its real cause', async () => {
  const r = rig();
  const client = new CpuRerankClient({ pkg: r.pkg, cacheDir: r.cache, table: r.table });
  const rerank = cpuRerankProvider({ model: r.id, client });
  const pids = [];
  const starts = [], clients = [];
  const realStart = CpuRerankClient.prototype.start;
  CpuRerankClient.prototype.start = function start() { const was = this.child; const out = realStart.call(this); if (this.child !== was) { starts.push(this.pid); clients.push(this); } return out; };
  try {
    await rerank({ query: QUERY, docs: NOTES });
    pids.push(client.pid);
    await crash(client, 9); // the exit event arrived
    assert.strictEqual(client.exit.code, 9);
    assert.throws(() => client.start(), (e) => e.code === 'E_MODEL_ABSENT' && e.detail.cause === 'dead' && /exit code 9/.test(e.message), 'start() does not re-fork over a dead child');
    assert.strictEqual(client.child.pid, pids[0], 'and forked nothing');
    // two later calls: each succeeds on a fresh child that loaded the model
    for (let n = 0; n < 2; n += 1) {
      const before = starts.length;
      const out = await rerank({ query: QUERY, docs: NOTES });
      assert.strictEqual(out.scores.length, NOTES.length);
      assert.strictEqual(starts.length, before + 1, 'one new child for the call');
      const fresh = starts[starts.length - 1];
      assert.ok(!pids.includes(fresh), 'a new pid');
      pids.push(fresh);
      await crash(clients[clients.length - 1], 5);
    }
    // a reload that fails is that call's error, with the real cause, and the provider tries again on the next call
    const gone = r.cache + '-away';
    fs.renameSync(r.cache, gone);
    await assert.rejects(rerank({ query: QUERY, docs: NOTES }), (e) => e.code === 'E_MODEL_ABSENT' && e.detail.cause === 'absent' && /belay embedder fetch --reranker/.test(e.message));
    fs.renameSync(gone, r.cache);
    assert.strictEqual((await rerank({ query: QUERY, docs: NOTES })).scores.length, NOTES.length);
  } finally { CpuRerankClient.prototype.start = realStart; await rerank.close(); r.done(); }
});

test("two concurrent calls: one call's timeout closes the shared child, and the other is retried once on a fresh one inside its own bound", async () => {
  const r = rig({ rankDelayMs: 800 });
  const ft = fakeTimers();
  const client = new CpuRerankClient({ pkg: r.pkg, cacheDir: r.cache, table: r.table });
  const rerank = cpuRerankProvider({ model: r.id, client, chunk: 1, timers: ft.timers });
  try {
    await rerank({ query: QUERY, docs: NOTES.slice(0, 1) }); // loaded and warm
    const first = client.pid;
    const firstId = await G.identify(first);
    const progress = countProgress(client.child);
    const a = outcome(rerank({ query: QUERY, docs: NOTES, boundMs: 400 })); // five chunks: its bound passes
    const b = outcome(rerank({ query: QUERY, docs: NOTES.slice(0, 2), boundMs: 30000 })); // queued behind it on the same child
    await progress.reach(1);
    await ft.advance(399);
    assert.strictEqual(a.settled, false, 'a is still pending at bound - 1');
    await ft.advance(1);
    await Promise.all([a.done, b.done]);
    assert.ok(a.error && a.error.code === 'E_EMBEDDER_TIMEOUT' && a.error.detail.cause === 'timeout');
    assert.strictEqual(b.error, undefined, b.error && b.error.message);
    assert.strictEqual(b.value.scores.length, 2);
    assert.ok(await waitGone(firstId), 'the first child is gone');
  } finally { await rerank.close(); r.done(); }
});

test('after a timeout the next call waits for the old child to be gone before it forks: at most one model in memory', async () => {
  const r = rig({ rankDelayMs: 800 });
  const ft = fakeTimers();
  const live = [], clients = [];
  const realStart = CpuRerankClient.prototype.start;
  const seen = [];
  // Counted BEFORE the fork, which itself takes time. An earlier child is alive until its handle reports an exit: the number of a child that
  // has exited can be handed to another process (ADR 0039), so a pid check could count a bystander.
  CpuRerankClient.prototype.start = function start() { const was = this.child, alive = live.filter((h) => h.exitCode === null && h.signalCode === null).length; const out = realStart.call(this); if (this.child !== was) { seen.push(alive); live.push(this.child); clients.push(this); } return out; };
  const rerank = cpuRerankProvider({ model: r.id, pkg: r.pkg, cacheDir: r.cache, table: r.table, chunk: 1, timers: ft.timers });
  try {
    await rerank({ query: QUERY, docs: NOTES.slice(0, 1) });
    const progress = countProgress(clients[0].child);
    const call = outcome(rerank({ query: QUERY, docs: NOTES, boundMs: 350 }));
    await progress.reach(1);
    await ft.advance(349);
    assert.strictEqual(call.settled, false, 'still pending at bound - 1');
    await ft.advance(1);
    await call.done;
    assert.ok(call.error && call.error.code === 'E_EMBEDDER_TIMEOUT');
    await rerank({ query: QUERY, docs: NOTES.slice(0, 1) });
    assert.strictEqual(live.length, 2);
    assert.deepStrictEqual(seen, [0, 0], 'no earlier child was alive when a new one was forked');
  } finally { CpuRerankClient.prototype.start = realStart; await rerank.close(); r.done(); }
});

test('with no boundMs the provider uses its default (10 s unless given), never unbounded', async () => {
  const { DEFAULT_BOUND_MS } = core('rerank-cpu.cjs');
  assert.strictEqual(DEFAULT_BOUND_MS, 10000);
  const r = rig({ rankDelayMs: 3000 });
  const ft = fakeTimers();
  const client = new CpuRerankClient({ pkg: r.pkg, cacheDir: r.cache, table: r.table });
  const rerank = cpuRerankProvider({ model: r.id, client, defaultBoundMs: 400, timers: ft.timers });
  try {
    const call = outcome(rerank({ query: QUERY, docs: NOTES }));
    await waitFor(() => client.models.size > 0, { label: 'the model loaded (the rank is under way)' });
    await ft.settle();
    await ft.advance(399);
    assert.strictEqual(call.settled, false, 'the default bound is 400 here, not passed again');
    await ft.advance(1);
    assert.ok(call.error && call.error.code === 'E_EMBEDDER_TIMEOUT' && call.error.detail.bound_ms === 400, call.error && call.error.message);
  } finally { await rerank.close(); r.done(); }
});

test("a load has a wall-clock limit that the child's heartbeats do not reset", async () => {
  const r = rig({ loadDelayMs: 4000 });
  const ft = fakeTimers();
  const c = new CpuRerankClient({ pkg: r.pkg, cacheDir: r.cache, table: r.table, workerOpts: { heartbeatMs: 50 }, loadBoundMs: 2000, loadWallMs: 500, timers: ft.timers }).start();
  try {
    assert.strictEqual((await c.ping(UP_DEADLINE)).ok, true, 'warm: the child is up before the clock starts');
    const stuckId = await G.identify(c.pid);
    const progress = countProgress(c.child);
    const load = outcome(c.load(r.id));
    await progress.reach(3); // at least three real heartbeats: the silence clock has been credited repeatedly
    await ft.advance(499);
    assert.strictEqual(load.settled, false, 'not rejected at wall - 1');
    await ft.advance(1);
    assert.ok(load.error && load.error.code === 'E_EMBEDDER_TIMEOUT' && load.error.detail.cause === 'timeout' && load.error.detail.wall_clock === true && load.error.detail.timeout_ms === 500, JSON.stringify(load.error));
    assert.ok(c.hung, 'a load past its wall clock is a hung child');
    assert.ok(await waitGone(stuckId), 'the wall-clock branch closed the stuck child itself');
  } finally { await c.close(); r.done(); }
});

test('close() during an in-flight ensure forks and loads nothing after it: a crash, a call, an immediate close', async () => {
  const r = rig();
  const client = new CpuRerankClient({ pkg: r.pkg, cacheDir: r.cache, table: r.table });
  const rerank = cpuRerankProvider({ model: r.id, client });
  const pids = [];
  const handles = []; // each child as it is forked: the handle is the proof it ended, whatever number Windows gives out next
  const realStart = CpuRerankClient.prototype.start;
  CpuRerankClient.prototype.start = function start() { const was = this.child; const out = realStart.call(this); if (this.child !== was) { pids.push(this.pid); handles.push(this.child); } return out; };
  try {
    await rerank({ query: QUERY, docs: NOTES });
    await crash(client, 4); // the exit event arrived
    const before = pids.length;
    const call = rerank({ query: QUERY, docs: NOTES }).catch((e) => e);
    await rerank.close(); // immediately: the call is inside ensure()
    const out = await call;
    assert.ok(out instanceof Error && out.code === 'E_MODEL_ABSENT' && out.detail.cause === 'dead', 'the call failed with a coded dead error');
    for (const h of handles) assert.ok(await waitGone(h), `child ${h.pid} outlived close()`);
    assert.ok(pids.length <= before + 1, 'at most the one child the call had started, now closed');
    await assert.rejects(rerank({ query: QUERY, docs: NOTES }), (e) => e.code === 'E_MODEL_ABSENT' && e.detail.cause === 'dead', 'and nothing starts after close');
    assert.strictEqual(pids.length, Math.min(pids.length, before + 1));
  } finally { CpuRerankClient.prototype.start = realStart; await rerank.close(); r.done(); }
});

test('loaded() is true while the model sits in a live child, and false once the child exits outside a rerank or the provider closes', async () => {
  const r = rig();
  const p = r.provider();
  try {
    assert.strictEqual(p.loaded(), false, 'nothing is loaded before the first call');
    await p({ query: QUERY, docs: NOTES, depth: 2 });
    assert.strictEqual(p.loaded(), true);
    const c = p.__client ? p.__client() : null;
    assert.ok(c, 'the test seam exposes the live client');
    await crash(c, 3);
    assert.strictEqual(p.loaded(), false, 'a child that exited while idle no longer holds the model');
  } finally { await p.close(); r.done(); }
  assert.strictEqual(p.loaded(), false);
});
