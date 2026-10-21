'use strict';
// note-review-close.test.cjs — applying a review task's verdicts against the run's close. A real engine on a sandbox store and lifecycle.cjs's
// real shutdown. Every interleaving is forced through a gate (a promise the test opens, or the citation check's own seam), never a sleep:
//   C1  the close begins while the review task's citation check is held: the application is waited for, applied, and only then do workers stop
//   C2  onTaskEnded registers its application before its first await, so a drain called in the same tick waits for it
//   C3  a citation check that never ends is waited for within the drain's bound only; the run-end sweep (another process) then applies the hand-back
//   C5  a close with nothing in flight adds no wait

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { core: coreMod, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');

const { Store } = coreMod('store.cjs');
const { Engine } = coreMod('engine.cjs');
const NR = require('../../src/run/note-review.cjs');
const LC = require('../../src/run/lifecycle.cjs');
const CC = coreMod('memory-citations.cjs');
const { DEFAULTS } = require('../../src/core/memory-levers.cjs');

let dir, store, E, core;
const RUN = 'r-nrclose';
const orch = callerFor('orchestrator', { run_id: RUN });
const harness = callerFor('orchestrator', { run_id: RUN, channel: 'harness' });
const wcaller = (id) => callerFor('worker', { run_id: RUN, worker_id: id });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const rowOf = (id) => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const LV = { ...DEFAULTS, project: 'acme', notes: true };
const STREAM_LINE = 'fixtures/unlisted.json was never opened';
let seq = 0, k = 0;

const DIM = 64;
const embed = async (text) => {
  const m = /\bK(\d+)\b/.exec(text);
  const v = new Array(DIM).fill(0);
  v[m ? Number(m[1]) : DIM - 1] = 1;
  return { embedding: v, embedding_model: 'fake', embedding_revision: 'r', dim: DIM };
};
const note = (marker) => ({ kind: 'lesson', title: `the ${marker} loader skips unlisted fixtures`, when: `add a ${marker} test fixture`, basis: 'observed', evidence: [{ where: `src/${marker}.js`, saw: 'never read' }], applies_to: ['fixtures'] });
const toolResult = (text) => `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu', name: 'Bash', input: {} }] } })}\n${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu', content: text }] } })}\n`;
const verdictsFor = (ids, v = 'confirmed') => JSON.stringify({ memory_verdicts: ids.map((id) => ({ id, verdict: v, cites: [{ where: 'stream', quote: STREAM_LINE }], reason: 'the stream shows it' })) });

async function written(w, n = 1) {
  await call('worker.write', orch, { id: w, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${w}`, last_event_at: Date.now(), worktree: dir });
  const t = await call('task.create', orch, { spec: `close ${++seq}`, acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] } });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: w });
  await call('worker.write', orch, { id: w, task_id: t.id });
  fs.mkdirSync(`${dir}/workers/${w}`, { recursive: true });
  fs.writeFileSync(`${dir}/workers/${w}/stream.jsonl`, toolResult(STREAM_LINE));
  const notes = Array.from({ length: n }, () => note(`K${++k}`));
  const out = await call('lease.release', wcaller(w), { lease_id: a.new_lease.id, notes, result: { summary: 'done' } });
  await call('task.evaluate', orch, { task_id: t.id, worktree: dir });
  return { task: { ...(await call('task.get', orch, { task_id: t.id })), state: 'released' }, notes: out.notes.map((x) => x.id), worker: w };
}

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => ({ embed }), owner: null, establishedBy: 'test' });
  core = new Proxy({}, { get: (_, g) => (g === 'caller' ? harness : new Proxy({}, { get: (__, n) => (args) => call(`${g}.${n}`, harness, args || {}) })) });
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
});
after(() => { store.close(); cleanup(dir); });


const J = (ctx) => ({ ctx, core: ctx.core, lv: LV, w: null, gate: { aborted: false }, s: {}, turnPath: false });
const ctxFor = () => ({ core, runId: RUN, dataDir: dir, memoryLevers: LV, worktree: dir, manager: null, shutdownFlags: { closed: false } });
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const ticks = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const settled = (p) => { let done = false; p.then(() => { done = true; }, () => { done = true; }); return async () => { await ticks(); return done; }; };

// A review task over w.task that handed back a confirmed verdict for the notes; its brief is captured as the launch would have.
async function reviewed(w, r) {
  await call('worker.write', orch, { id: r, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${r}`, last_event_at: Date.now() });
  const rt = await call('task.create', orch, { spec: `review ${++seq}`, depends_on: [w.task.id], acceptance: { verdict: true } });
  const a = await call('task.assign', orch, { task_id: rt.id, worker_id: r });
  await call('lease.release', wcaller(r), { lease_id: a.new_lease.id, notes: [], result: { verdict: 'holds', summary: 'ok', memory_verdicts: JSON.parse(verdictsFor(w.notes)).memory_verdicts } });
  await NR.reviewTail(ctxFor(), { id: r, taskId: rt.id });
  return call('task.get', orch, { task_id: rt.id });
}
// Hold the next citation check after it has read its evidence (the seam the verdict path already has).
function holdCheck() {
  const gate = defer();
  CC.seam.afterCheck = async () => { CC.seam.afterCheck = null; await gate.promise; };
  return gate;
}
const shutdownOver = (ctx, workers, log, over = {}) => LC.shutdown(workers, {
  stop: async ({ worker_id }) => { log.push(`stop:${worker_id}`); },
  core: { isOwner: () => false }, clearPoll: () => {},
  markClosed: () => { log.push('closed'); },
  markOwnerGone: () => new Set(),
  beforeStop: (ms) => NR.drainVerdicts(ctx, ms), onDrained: async () => { log.push('drained'); }, ...over,
});

test('C1: the close begins while the review task citation check is held; the application is waited for and lands before any worker stops', async () => {
  const w = await written('wr-c1', 1);
  const rt = await reviewed(w, 'rv-c1');
  const gate = holdCheck();
  try {
    const ctx = ctxFor();
    const p = NR.onTaskEnded(J(ctx), rt);
    await ticks(10);
    const rec = { id: w.worker, queue: Promise.resolve(), state: 'running' };
    const log = [];
    const down = shutdownOver(ctx, new Map([[rec.id, rec]]), log);
    const isDown = settled(down);
    assert.strictEqual(await isDown(), false, 'the close waits for the application');
    assert.deepStrictEqual(log, [], 'nothing has stopped');
    assert.strictEqual(rowOf(w.notes[0]).status ?? 'unverified', 'unverified');
    gate.resolve();
    await down; await p;
    assert.deepStrictEqual(log, [`stop:${w.worker}`, 'closed', 'drained']);
    assert.strictEqual(rowOf(w.notes[0]).status, 'verified', 'its verdict was applied before the workers stopped');
  } finally { CC.seam.afterCheck = null; gate.resolve(); }
});

test('C2: onTaskEnded registers its application before its first await, so a drain in the same tick waits for it', async () => {
  const w = await written('wr-c2');
  const rt = await reviewed(w, 'rv-c2');
  const gate = holdCheck();
  try {
    const ctx = ctxFor();
    const p = NR.onTaskEnded(J(ctx), rt);
    const drained = NR.drainVerdicts(ctx, 60000); // same tick: before the check has answered
    const isDrained = settled(drained);
    assert.strictEqual(await isDrained(), false, 'the drain sees the registered application');
    gate.resolve();
    await drained; await p;
    assert.strictEqual(rowOf(w.notes[0]).status, 'verified', 'the drain returned only after the verdict landed');
  } finally { CC.seam.afterCheck = null; gate.resolve(); }
});

test('C3: a check that outlasts the drain is waited for within the bound only; the run-end sweep then applies the hand-back', async () => {
  const w = await written('wr-c3');
  const rt = await reviewed(w, 'rv-c3');
  const gate = holdCheck();
  try {
    const ctx = ctxFor();
    const p = NR.onTaskEnded(J(ctx), rt);
    await ticks(10);
    const rec = { id: w.worker, queue: Promise.resolve(), state: 'running' };
    const log = [];
    const t0 = Date.now();
    await shutdownOver(ctx, new Map([[rec.id, rec]]), log, { drainBudgetMs: 400 });
    assert.ok(Date.now() - t0 < 2000, 'the close did not wait past its bound');
    assert.deepStrictEqual(log, [`stop:${w.worker}`, 'closed', 'drained']);
    assert.strictEqual(rowOf(w.notes[0]).status ?? 'unverified', 'unverified', 'still held');
    // belay run's store-only sweep (another manager state) applies it
    await NR.sweep(J(ctxFor()), [rt]);
    assert.strictEqual(rowOf(w.notes[0]).status, 'verified', 'applied by the sweep');
    gate.resolve();
    await p;
    assert.strictEqual(rowOf(w.notes[0]).status, 'verified', 'the late application changes nothing');
  } finally { CC.seam.afterCheck = null; gate.resolve(); }
});

test('C5: a close with nothing in flight adds no wait', async () => {
  const mk = (id) => ({ id, queue: Promise.resolve(), state: 'running' });
  const log = [];
  const t0 = Date.now();
  const res = await shutdownOver({}, new Map([['a', mk('a')], ['b', mk('b')]]), log);
  assert.deepStrictEqual(log.slice(0, 2), ['stop:a', 'stop:b']);
  assert.deepStrictEqual(res.memory_gave_up, []);
  assert.ok(Date.now() - t0 < 1000);
});
