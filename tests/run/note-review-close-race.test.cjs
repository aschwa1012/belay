'use strict';
// note-review-close-race.test.cjs — the close's protections for the review job, each proven alone through lifecycle's real shutdown over
// records that look like workers and a fake manager whose waits are held by the test (no sleeps; gates and tick counts):
//   R1  drain-follow: a job decided while another is drained is waited for too; no worker stops until it ends
//   R2  the closing flag: a task that ends during the stop loop gets no job and an E_SHUTDOWN receipt
//   R3  the straggler loop: a worker that joins the map during the stop loop is stopped
//   R4  the second drain: a job that outlasts the first drain and is stopped still writes its receipt before the owner is marked gone
//   R5  the escape: the first drain gives up, a job spawns while the loop stops its worker and never ends by itself; it is stopped
//   R6  the nested memory queue: the queue is re-read until it stops changing
//   R7  one budget: the turn queues and both job drains together never wait longer than the single bound

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULTS } = require('../../src/core/memory-levers.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const NR = require('../../src/run/note-review.cjs');
const LC = require('../../src/run/lifecycle.cjs');
const MJ = require('../../src/run/memory-jobs.cjs');

const LV = { ...DEFAULTS, project: 'demo', notes: true, note_review: true, cost_ledger: true };
const rec = (id) => ({ id, queue: Promise.resolve(), state: 'running' });
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const ticks = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const OK = { event: 'turn_end', is_error: false, timed_out: false };

function world(budget = 120000) {
  const core = createFakeCore({ runId: 'run-fake' });
  const events = [];
  core.run = { get: async () => ({ run: { memory_levers: JSON.stringify(LV) } }) };
  core.task.get = async ({ task_id }) => ({ id: task_id, run_id: 'run-fake', state: 'released' });
  core.task.list = async () => ({ tasks: ['ta', 'tb'].map((id) => ({ id, state: 'released' })) });
  core.worker.list = async () => ({ workers: [] });
  Object.assign(core.memory, {
    events: async () => ({ events: events.slice() }),
    recordEvent: async (e) => { events.push(e); return e; },
    reviewBrief: async () => ({ notes: [{ id: 'n1', title: 'x' }], reports: [], review: false, refuted_shown: [], reviewed_tasks: [] }),
    noteVerdicts: async () => ({ applied: [], refused: [], already: [], unjudged: [{ id: 'n1' }] }),
  });
  const flags = { closed: false, closing: false, ownerGone: false };
  const workers = new Map();
  const m = { spawned: [], stopped: [], gates: new Map(), releases: new Map(), releaseTicks: 0, flags, onStop: null };
  m._closed = () => flags.closed; m._closing = () => flags.closing;
  m.spawn = async (a) => { if (m.gates.has(a.worker_id)) await m.gates.get(a.worker_id).promise; m.spawned.push(a.worker_id); workers.set(a.worker_id, rec(a.worker_id)); return {}; };
  m.waitFor = null; // (job id) => result; null: the turn ends at once
  m.wait = async ({ worker_ids }) => (m.waitFor ? m.waitFor(worker_ids[0]) : OK);
  m.untilStopped = (id) => new Promise((res) => m.releases.set(id, res)); // a job that never ends by itself
  m.stop = async ({ worker_id }) => {
    m.stopped.push(worker_id);
    const r = m.releases.get(worker_id);
    if (r) (async () => { await ticks(m.releaseTicks); r({ event: 'exited', is_error: false, timed_out: false }); })();
    if (m.onStop) await m.onStop(worker_id);
  };
  m._worker = (id) => ({ lastAssistantText: '{}', costUsd: 0.01, ...(workers.get(id) || {}) });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-race-')).split(path.sep).join('/');
  const ctx = { core, runId: 'run-fake', dataDir, memoryLevers: LV, worktree: dataDir, manager: m, shutdownFlags: flags };
  const calls = [];
  const shutdown = (over = {}) => LC.shutdown(workers, {
    stop: async (a) => m.stop(a), core: { isOwner: () => false }, clearPoll: () => {},
    markClosed: () => { flags.closed = true; }, markClosing: () => { flags.closing = true; }, markOwnerGone: () => { flags.ownerGone = true; return new Set(); },
    beforeStop: (ms) => { calls.push(ms); return NR.drain(ctx, ms); }, queuesFirst: () => NR.expectsJobs(ctx), onDrained: async () => {}, drainBudgetMs: budget, ...over,
  });
  const turn = (w, taskId) => MJ.afterTurn(w, ctx, { snap: { taskId, workerId: w.id, turn: 1, substrate: 'claude-code', pid: 1, cost: 0.1 } });
  const receipts = (taskId) => events.filter((e) => e.kind === 'review_job' && e.key === `task:${taskId}`);
  return { m, events, workers, ctx, shutdown, turn, receipts, calls, flags, done: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test('R1: a job decided while another is drained is waited for too; no worker stops until it ends', async () => {
  const W = world();
  try {
    const a = rec('wa'), b = rec('wb'); W.workers.set('wa', a); W.workers.set('wb', b);
    const holdA = defer(), holdB = defer();
    W.m.waitFor = async (id) => { await (id === 'notereview-ta' ? holdA : holdB).promise; return OK; };
    W.turn(a, 'ta');
    await ticks();
    const down = W.shutdown();
    await ticks();
    W.turn(b, 'tb'); // B's turn ends while A's job is held in the drain
    await ticks(40);
    assert.ok(W.m.spawned.includes('notereview-tb'), 'job B is held in its wait');
    holdA.resolve();
    await ticks(40);
    assert.deepStrictEqual(W.m.stopped.filter((x) => !x.startsWith('notereview-')), [], 'A is done but B is held: the drain follows B and no worker has stopped');
    holdB.resolve();
    await down;
    assert.deepStrictEqual(W.m.stopped.filter((x) => !x.startsWith('notereview-')).sort(), ['wa', 'wb']);
    assert.strictEqual(W.receipts('ta').length + W.receipts('tb').length, 2, 'both jobs left a receipt');
  } finally { W.done(); }
});

test('R2: a task that ends during the stop loop gets no job and an E_SHUTDOWN receipt (the closing flag)', async () => {
  const W = world();
  try {
    const a = rec('wa'), b = rec('wb'); W.workers.set('wa', a); W.workers.set('wb', b);
    W.m.onStop = async (id) => { if (id === 'wa') { W.turn(b, 'tb'); await ticks(40); } };
    await W.shutdown();
    assert.ok(!W.m.spawned.includes('notereview-tb'), 'no job was started past the closing flag');
    assert.deepStrictEqual(W.receipts('tb').map((e) => [e.ok, e.code]), [[false, 'E_SHUTDOWN']]);
  } finally { W.done(); }
});

test('R3: a worker that joins the map while the stop loop runs is stopped before shutdown() returns (the straggler loop)', async () => {
  const W = world();
  try {
    W.workers.set('wa', rec('wa'));
    W.m.onStop = async (id) => { if (id === 'wa') W.workers.set('wx', rec('wx')); };
    await W.shutdown();
    assert.deepStrictEqual(W.m.stopped.sort(), ['wa', 'wx']);
  } finally { W.done(); }
});

test('R4: a job that outlasts the first drain and is stopped still writes its receipt before the owner is marked gone (the second drain)', async () => {
  const W = world(600); // the first drain gets 450 ms, the second what is left
  try {
    const a = rec('wa'); W.workers.set('wa', a);
    W.m.waitFor = (id) => W.m.untilStopped(id);
    W.m.releaseTicks = 60; // the stopped job takes a while to finish: longer than the rest of the close
    W.turn(a, 'ta');
    await ticks();
    await W.shutdown();
    assert.strictEqual(W.flags.ownerGone, true);
    assert.strictEqual(W.receipts('ta').length, 1, `the stopped job's receipt landed before the owner went: ${JSON.stringify(W.events)}`);
    assert.strictEqual(W.calls.length, 2, 'the drain ran twice');
  } finally { W.done(); }
});

test('R5: the first drain gives up, a job spawns while the loop stops its worker and never ends by itself: it is stopped', async () => {
  const W = world(400);
  try {
    const a = rec('wa'), b = rec('wb'); W.workers.set('wa', a); W.workers.set('wb', b);
    W.m.waitFor = (id) => W.m.untilStopped(id);
    const gate = defer(); W.m.gates.set('notereview-tb', gate);
    W.turn(a, 'ta');
    await ticks();
    const down = W.shutdown();
    await ticks();
    W.turn(b, 'tb'); // B's job is decided during the drain and its spawn stays under way
    W.m.onStop = async (id) => { if (id === 'wb') { gate.resolve(); await ticks(40); } }; // it lands while the loop stops worker B
    await down;
    assert.ok(W.m.spawned.includes('notereview-tb'), 'the job did spawn');
    assert.ok(W.m.stopped.includes('notereview-tb'), `and was stopped: ${W.m.stopped.join(',')}`);
    assert.ok(W.m.stopped.includes('notereview-ta'));
  } finally { W.done(); }
});

test('R6: the memory queue is re-read until it stops changing (a job appends the next link from inside the first)', async () => {
  const w = rec('w1');
  const g1 = defer(), g2 = defer();
  let innerDone = false;
  const outer = (async () => { await g1.promise; w.memoryQueue = outer.then(async () => { await g2.promise; innerDone = true; }); })();
  w.memoryQueue = outer;
  let seen = null;
  const down = LC.shutdown(new Map([['w1', w]]), {
    stop: async () => {}, core: { isOwner: () => false }, clearPoll: () => {}, markClosed: () => {}, markOwnerGone: () => new Set(),
    beforeStop: async () => { seen = innerDone; }, queuesFirst: () => true, onDrained: async () => {}, drainBudgetMs: 5000,
  });
  await ticks();
  g1.resolve();
  await ticks();
  g2.resolve();
  await down;
  assert.strictEqual(seen, true, 'the job drain began only after the appended link had run');
});

test('R7: the turn queues and both job drains share one budget: the close never waits longer than the single bound', async () => {
  const BUDGET = 600;
  const w = rec('w1'); w.memoryQueue = new Promise(() => {}); // a queue that never settles
  const asked = [];
  const t0 = Date.now();
  const res = await LC.shutdown(new Map([['w1', w]]), {
    stop: async () => {}, core: { isOwner: () => false }, clearPoll: () => {}, markClosed: () => {}, markOwnerGone: () => new Set(),
    beforeStop: async (ms) => { asked.push(ms); await new Promise((r) => setTimeout(r, ms)); }, // a stuck job: each drain takes all it is given
    queuesFirst: () => true, onDrained: async () => {}, drainBudgetMs: BUDGET,
  });
  const ms = Date.now() - t0;
  assert.strictEqual(asked.length, 2);
  assert.ok(asked[0] <= BUDGET && asked[1] <= BUDGET, JSON.stringify(asked));
  assert.ok(ms < BUDGET + 300, `the close took ${ms} ms against a ${BUDGET} ms bound`); // 300 ms: timer and scheduling slack, not a second drain
  assert.deepStrictEqual(res.memory_gave_up, ['w1']);
});
