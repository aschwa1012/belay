'use strict';
// note-review-owner-gone.test.cjs — a review job that ends after the owner is marked gone writes nothing (audit D66). A write now
// would elect a second store owner inside the adapter (invariant 2), so a stopped job leaves no receipt and the run's sweep names the
// task. Three guards, each proven alone: the one after the job's wait (runJob), the one in runJob's catch, and the one in onTaskEnded's
// catch. The job's wait is held by the test and released after `shutdownFlags.ownerGone` is set; no sleeps, only ticks.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULTS } = require('../../src/core/memory-levers.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const MJ = require('../../src/run/memory-jobs.cjs');

const LV = { ...DEFAULTS, project: 'demo', notes: true, note_review: true, cost_ledger: true };
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const ticks = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const OK = { event: 'turn_end', is_error: false, timed_out: false };

function world() {
  const core = createFakeCore({ runId: 'run-fake' });
  const events = [];
  const verdicts = [];
  core.run = { get: async () => ({ run: { memory_levers: JSON.stringify(LV) } }) };
  core.task.get = async ({ task_id }) => ({ id: task_id, run_id: 'run-fake', state: 'released' });
  core.task.list = async () => ({ tasks: [{ id: 'ta', state: 'released' }] });
  core.worker.list = async () => ({ workers: [] });
  Object.assign(core.memory, {
    events: async () => ({ events: events.slice() }),
    recordEvent: async (e) => { events.push(e); return e; },
    reviewBrief: async () => ({ notes: [{ id: 'n1', title: 'x' }], reports: [], review: false, refuted_shown: [], reviewed_tasks: [] }),
    noteVerdicts: async (a) => { verdicts.push(a); return { applied: [], refused: [], already: [], unjudged: [{ id: 'n1' }] }; },
  });
  const flags = { closed: false, closing: false, ownerGone: false };
  const hold = defer();
  const m = { spawned: [], stopped: [], flags, waitImpl: async () => { await hold.promise; return OK; } };
  m._closed = () => flags.closed; m._closing = () => flags.closing;
  m.spawn = async (a) => { m.spawned.push(a.worker_id); return {}; };
  m.wait = (a) => m.waitImpl(a);
  m.stop = async ({ worker_id }) => { m.stopped.push(worker_id); };
  m._worker = () => ({ lastAssistantText: '{}', costUsd: 0.01 });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-gone-')).split(path.sep).join('/');
  const ctx = { core, runId: 'run-fake', dataDir, memoryLevers: LV, worktree: dataDir, manager: m, shutdownFlags: flags };
  const w = { id: 'wa', queue: Promise.resolve(), state: 'running' };
  const turn = () => MJ.afterTurn(w, ctx, { snap: { taskId: 'ta', workerId: 'wa', turn: 1, substrate: 'claude-code', pid: 1, cost: 0.1 } });
  const receipts = () => events.filter((e) => e.kind === 'review_job');
  return { core, m, flags, hold, verdicts, turn, receipts, ctx, done: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test('control: while the owner is still there, a finished job leaves its receipt', async () => {
  const W = world();
  try {
    W.turn(); await ticks();
    assert.deepStrictEqual(W.m.spawned, ['notereview-ta'], 'the job started');
    W.hold.resolve(); await ticks(80);
    assert.strictEqual(W.receipts().length, 1, 'a receipt, ok or failed, names the task');
  } finally { W.done(); }
});

test('a job whose wait ends after the owner is marked gone writes no receipt and applies no verdict (the guard after the wait)', async () => {
  const W = world();
  try {
    W.turn(); await ticks();
    assert.deepStrictEqual(W.m.spawned, ['notereview-ta']);
    W.flags.ownerGone = true; // the adapter's shutdown reached markOwnerGone while the job was still in its wait
    W.hold.resolve(); await ticks(80);
    assert.deepStrictEqual(W.m.stopped, ['notereview-ta'], 'the job itself was stopped');
    assert.deepStrictEqual(W.receipts(), [], 'no review_job receipt after the owner is gone');
    assert.deepStrictEqual(W.verdicts, [], 'no verdict write either');
  } finally { W.done(); }
});

test('a job that fails after the owner is marked gone writes no failure receipt (runJob\'s catch)', async () => {
  const W = world();
  try {
    W.m.waitImpl = async () => { await W.hold.promise; throw new Error('the wait broke'); };
    W.turn(); await ticks();
    W.flags.ownerGone = true;
    W.hold.resolve(); await ticks(80);
    assert.deepStrictEqual(W.receipts(), [], 'a failure receipt would be a write to a store whose owner is going');
  } finally { W.done(); }
});

test('control: the same failure with the owner still there writes its failure receipt', async () => {
  const W = world();
  try {
    W.m.waitImpl = async () => { await W.hold.promise; throw new Error('the wait broke'); };
    W.turn(); await ticks();
    W.hold.resolve(); await ticks(80);
    const r = W.receipts();
    assert.strictEqual(r.length, 1);
    assert.ok(r[0].ok === 0 || r[0].ok === false, 'a failed job is recorded failed');
  } finally { W.done(); }
});

test('a task listing that fails after the owner is marked gone writes no receipt (onTaskEnded\'s catch)', async () => {
  const W = world();
  try {
    const gate = defer();
    W.core.task.list = async () => { await gate.promise; throw new Error('the listing broke'); };
    W.turn(); await ticks();
    W.flags.ownerGone = true;
    gate.resolve(); await ticks(80);
    assert.deepStrictEqual(W.m.spawned, [], 'no job started');
    assert.deepStrictEqual(W.receipts(), []);
  } finally { W.done(); }
});
