'use strict';
// note-review-close-race.test.cjs — the close's protections for applying a review task's verdicts, each proven alone through
// lifecycle's real shutdown over records that look like workers and a fake core whose verdict application is held by the test
// (no sleeps; gates and tick counts):
//   R1  drain-follow: an application registered while another is drained is waited for too; no worker stops until it ends
//   R3  the straggler loop: a worker that joins the map during the stop loop is stopped
//   R4  the second drain: an application that outlasts the first drain finishes before the owner is marked gone
//   R7  one budget: both drains together never wait longer than the single bound

const test = require('node:test');
const assert = require('node:assert');
const { DEFAULTS } = require('../../src/core/memory-levers.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const NR = require('../../src/run/note-review.cjs');
const LC = require('../../src/run/lifecycle.cjs');

const LV = { ...DEFAULTS, project: 'demo', notes: true };
const rec = (id) => ({ id, queue: Promise.resolve(), state: 'running' });
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const ticks = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const reviewTask = (id) => ({ id, state: 'released', acceptance: { verdict: true }, handoff: { at: 1, result: {} } });

function world(budget = 120000) {
  const core = createFakeCore({ runId: 'run-fake' });
  const applied = [], gates = new Map();
  Object.assign(core.memory, {
    noteVerdicts: async ({ review_task_id }) => { if (gates.has(review_task_id)) await gates.get(review_task_id).promise; applied.push(review_task_id); return { applied: [], refused: [], already: [], unjudged: [] }; },
  });
  const flags = { closed: false, closing: false, ownerGone: false };
  const workers = new Map();
  const stopped = [];
  const m = { stopped, onStop: null };
  const ctx = { core, runId: 'run-fake', dataDir: 'unused', memoryLevers: LV, worktree: 'unused', manager: m, shutdownFlags: flags };
  const J = { ctx, core, lv: LV, w: null, gate: { aborted: false }, s: {}, turnPath: false };
  const calls = [];
  const shutdown = (over = {}) => LC.shutdown(workers, {
    stop: async ({ worker_id }) => { stopped.push(worker_id); if (m.onStop) await m.onStop(worker_id); }, core: { isOwner: () => false }, clearPoll: () => {},
    markClosed: () => { flags.closed = true; }, markClosing: () => { flags.closing = true; }, markOwnerGone: () => { flags.ownerGone = true; return new Set(); },
    beforeStop: (ms) => { calls.push(ms); return NR.drainVerdicts(ctx, ms); }, onDrained: async () => {}, drainBudgetMs: budget, ...over,
  });
  return { m, workers, ctx, J, gates, applied, shutdown, calls, flags };
}

test('R1: an application registered while another is drained is waited for too; no worker stops until it ends', async () => {
  const W = world();
  W.workers.set('wa', rec('wa')); W.workers.set('wb', rec('wb'));
  const holdA = defer(), holdB = defer();
  W.gates.set('ra', holdA); W.gates.set('rb', holdB);
  void NR.onTaskEnded(W.J, reviewTask('ra'));
  await ticks();
  const down = W.shutdown();
  await ticks();
  void NR.onTaskEnded(W.J, reviewTask('rb')); // B ends while A is held in the drain
  await ticks(40);
  holdA.resolve();
  await ticks(40);
  assert.deepStrictEqual(W.m.stopped, [], 'A is done but B is held: the drain follows B and no worker has stopped');
  assert.deepStrictEqual(W.applied, ['ra']);
  holdB.resolve();
  await down;
  assert.deepStrictEqual(W.applied.sort(), ['ra', 'rb']);
  assert.deepStrictEqual(W.m.stopped.sort(), ['wa', 'wb']);
});

test('R3: a worker that joins the map while the stop loop runs is stopped before shutdown() returns (the straggler loop)', async () => {
  const W = world();
  W.workers.set('wa', rec('wa'));
  W.m.onStop = async (id) => { if (id === 'wa') W.workers.set('wx', rec('wx')); };
  await W.shutdown();
  assert.deepStrictEqual(W.m.stopped.sort(), ['wa', 'wx']);
});

test('R4: an application that outlasts the first drain finishes in the second, before the owner is marked gone', async () => {
  const W = world(600); // the first drain gets 450 ms, the second what is left
  W.workers.set('wa', rec('wa'));
  const hold = defer();
  W.gates.set('ra', hold);
  void NR.onTaskEnded(W.J, reviewTask('ra'));
  await ticks();
  W.m.onStop = async () => { setTimeout(() => hold.resolve(), 50); }; // it ends while the stop loop runs, after the first drain gave up
  let goneWhenApplied = null;
  const origPush = W.applied.push.bind(W.applied);
  W.applied.push = (x) => { goneWhenApplied = W.flags.ownerGone; return origPush(x); };
  await W.shutdown();
  assert.deepStrictEqual([...W.applied], ['ra']);
  assert.strictEqual(goneWhenApplied, false, 'the application landed before the owner went');
  assert.strictEqual(W.calls.length, 2, 'the drain ran twice');
});

test('R7: both drains share one budget: the close never waits longer than the single bound', async () => {
  const BUDGET = 600;
  const asked = [];
  const t0 = Date.now();
  await LC.shutdown(new Map([['w1', rec('w1')]]), {
    stop: async () => {}, core: { isOwner: () => false }, clearPoll: () => {}, markClosed: () => {}, markOwnerGone: () => new Set(),
    beforeStop: async (ms) => { asked.push(ms); await new Promise((r) => setTimeout(r, ms)); }, // a stuck application: each drain takes all it is given
    onDrained: async () => {}, drainBudgetMs: BUDGET,
  });
  const ms = Date.now() - t0;
  assert.strictEqual(asked.length, 2);
  assert.ok(asked[0] <= BUDGET && asked[1] <= BUDGET, JSON.stringify(asked));
  assert.ok(ms < BUDGET + 300, `the close took ${ms} ms against a ${BUDGET} ms bound`); // 300 ms: timer and scheduling slack, not a second drain
});
