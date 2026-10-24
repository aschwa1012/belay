'use strict';
// note-review-closing.test.cjs — a review task's verdicts and the close, through the real afterTurn and lifecycle.shutdown (a fake core, no sleeps):
//   C1  a turn that ends after the close began (closing set) starts no application: nothing is marked applied, and the store-only sweep applies it;
//   C2  a failure receipt after the owner is marked gone is never written (it would elect a new owner);
//   C3  the receipt that names a cut-off is bounded inside the shared deadline; a stalled or a rejected recordEvent comes back on the shutdown result
//       together with the pending review tasks.

const test = require('node:test');
const assert = require('node:assert');
const { DEFAULTS } = require('../../src/core/memory-levers.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const MJ = require('../../src/run/memory-jobs.cjs');
const NR = require('../../src/run/note-review.cjs');
const LC = require('../../src/run/lifecycle.cjs');
const MP = require('../../src/run/memory-preface.cjs');

const LV = { ...DEFAULTS, project: 'demo', notes: true };
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const ticks = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const review = (id) => ({ id, state: 'released', acceptance: { verdict: true }, handoff: { at: 1, result: {} } });

function world() {
  const core = createFakeCore({ runId: 'run-fake' });
  const events = [], applied = [], gates = new Map(), tasks = new Map();
  core.run = { get: async () => ({ run: { memory_levers: JSON.stringify(LV) } }) };
  core.task.get = async ({ task_id }) => tasks.get(task_id);
  core.task.list = async () => ({ tasks: [...tasks.values()] });
  core.worker.list = async () => ({ workers: [] });
  Object.assign(core.memory, {
    events: async () => ({ events: events.slice() }),
    recordEvent: async (e) => { if (world.record) return world.record(e); events.push(e); return e; },
    noteBriefCapture: async (a) => ({ ref: 'fake', notes: a.notes.length, event_id: 'me-fake' }),
    reviewBrief: async () => ({ notes: [], reports: [], review: false, refuted_shown: [], reviewed_tasks: [] }),
    noteVerdicts: async ({ review_task_id }) => {
      const g = gates.get(review_task_id);
      if (g) { gates.delete(review_task_id); await g.promise; }
      applied.push(review_task_id);
      return { applied: [], refused: [], already: [], unjudged: [] };
    },
  });
  const flags = { closed: false, closing: false, ownerGone: false };
  const ctx = { core, runId: 'run-fake', dataDir: 'unused', memoryLevers: LV, worktree: 'unused', manager: { flags }, shutdownFlags: flags };
  const w = { id: 'wa', queue: Promise.resolve(), state: 'running' };
  const workers = new Map([['wa', w]]);
  const turn = (taskId) => { tasks.set(taskId, review(taskId)); return MJ.afterTurn(w, ctx, { snap: { taskId, workerId: 'wa', turn: 1, substrate: 'claude-code', pid: 1, cost: 0.1 } }); };
  const J = { ctx, core, lv: LV, w: null, gate: { aborted: false }, s: {}, turnPath: false };
  const shutdown = (over = {}) => LC.shutdown(workers, {
    stop: async () => {}, core: { isOwner: () => false }, clearPoll: () => {},
    markClosed: () => { flags.closed = true; }, markClosing: () => { flags.closing = true; }, markOwnerGone: () => { flags.ownerGone = true; return new Set(); },
    beforeStop: (ms) => NR.drainVerdicts(ctx, ms), onDrained: async () => {}, ...over,
  });
  return { core, events, applied, gates, tasks, flags, ctx, w, workers, turn, J, shutdown };
}

test('C1: a turn callback that fires after the second drain, while the close is under way, starts no application and marks nothing applied: the sweep applies it', async () => {
  const W = world();
  let calls = 0;
  let late = null;
  await W.shutdown({
    drainBudgetMs: 5000,
    beforeStop: async (ms) => {
      const r = await NR.drainVerdicts(W.ctx, ms);
      calls += 1;
      if (calls === 2) { late = W.turn('rt-late'); } // the turn ends after the second drain, before the flag that closes the queues
      return r;
    },
  });
  assert.strictEqual(W.flags.closing, true);
  await late; await ticks();
  assert.deepStrictEqual(W.applied, [], 'no application was started once the close had begun');
  assert.strictEqual(W.w.lastError && W.w.lastError.where, 'after-shutdown');
  await NR.sweep(W.J, [W.tasks.get('rt-late')]); // the store-only run-end sweep: the hand-back is still eligible
  assert.deepStrictEqual(W.applied, ['rt-late']);
});

test('C1b: onTaskEnded itself refuses to start while closing or closed, and leaves the hand-back unmarked', async () => {
  const W = world();
  W.flags.closing = true;
  await NR.onTaskEnded(W.J, review('rt-x'));
  assert.deepStrictEqual(W.applied, []);
  await NR.sweep(W.J, [review('rt-x')]);
  assert.deepStrictEqual(W.applied, ['rt-x']);
});

test('C2: a failure of an application that began before the close, landing after the owner is marked gone, writes no receipt', async () => {
  const W = world();
  const gate = defer();
  W.gates.set('rt-fail', gate);
  W.core.memory.noteVerdicts = async () => { await gate.promise; throw new Error('the apply failed late'); };
  W.turn('rt-fail');
  await ticks();
  await W.shutdown({ drainBudgetMs: 400 }); // the application is held past the drain: the shutdown goes on and the owner is marked gone
  assert.strictEqual(W.flags.ownerGone, true);
  const before = W.events.length;
  gate.resolve();
  await ticks(60);
  assert.deepStrictEqual(W.events.slice(before).filter((e) => String(e.key).startsWith('route:')), [], 'no late failure receipt');
  // control: with the owner still there the same failure is a receipt
  const C = world();
  const g2 = defer();
  C.core.memory.noteVerdicts = async () => { await g2.promise; throw new Error('the apply failed'); };
  C.turn('rt-ctl');
  await ticks();
  g2.resolve();
  await ticks(60);
  assert.strictEqual(C.events.filter((e) => String(e.key).startsWith('route:')).length, 1);
});

test('C3: a stalled receipt does not stretch the shared deadline, and the shutdown result names the pending review task and the receipt failure', async () => {
  const W = world();
  const hold = defer();
  W.gates.set('rt-stall', hold);
  world.record = () => new Promise(() => {}); // recordEvent never answers
  try {
    W.turn('rt-stall');
    await ticks();
    const t0 = Date.now();
    // its own short deadline: a stalled recordEvent that nothing bounds fails here within seconds, not at the runner's timeout
    let guard;
    const res = await Promise.race([W.shutdown({ drainBudgetMs: 200 }), new Promise((_, rej) => { guard = setTimeout(() => rej(new Error('a stalled receipt held the shutdown')), 3000); })]);
    clearTimeout(guard);
    const spent = Date.now() - t0;
    assert.ok(spent < 1500, `the shutdown took ${spent} ms: the receipt was bounded by the reserve inside the deadline`);
    assert.deepStrictEqual(res.verdict_drain.pending, ['rt-stall']);
    assert.match(res.verdict_drain.receipt.error, /not written within/);
  } finally { world.record = null; hold.resolve(); }
});

test('C3b: a rejected receipt is returned, not swallowed; a written one is just written', async () => {
  const W = world();
  const hold = defer();
  W.gates.set('rt-rej', hold);
  world.record = async () => { throw new Error('the store refused the receipt'); };
  try {
    W.turn('rt-rej');
    await ticks();
    const r = await NR.drainVerdicts(W.ctx, 100);
    assert.deepStrictEqual(r.pending, ['rt-rej']);
    assert.match(r.receipt.error, /the store refused the receipt/);
    world.record = null;
    const ok = await NR.drainVerdicts(W.ctx, 100);
    assert.strictEqual(ok.receipt, 'written');
    assert.ok(W.events.some((e) => e.code === 'E_TIMEOUT' && /still running \(rt-rej\)/.test(e.message)));
  } finally { world.record = null; hold.resolve(); }
});

test('C3c: the reserve is real: the receipt write starts inside the reserve, before the deadline, and the drain ends within a fixed allowance of it', async () => {
  const W = world();
  const hold = defer();
  W.gates.set('rt-res', hold);
  let wroteAt = null;
  const t0 = Date.now();
  world.record = () => { wroteAt = Date.now() - t0; return new Promise(() => {}); }; // the receipt write is noted when it starts, and never answers
  const MS = 1000; // reserve = 250
  let guard;
  try {
    W.turn('rt-res');
    await ticks();
    // its own deadline: without the bound on the receipt this would hang, so it fails here instead
    const r = await Promise.race([NR.drainVerdicts(W.ctx, MS), new Promise((_, rej) => { guard = setTimeout(() => rej(new Error('the drain was held by a stalled receipt')), 6000); })]);
    clearTimeout(guard);
    const spent = Date.now() - t0;
    assert.ok(wroteAt !== null && wroteAt < MS - 125, `the receipt write started at ${wroteAt} ms: inside the reserve, before the ${MS} ms deadline`);
    assert.ok(spent < MS + 3000, `the drain ended after ${spent} ms`); // a generous allowance for a loaded runner
    assert.match(r.receipt.error, /not written within 250 ms/);
  } finally { clearTimeout(guard); world.record = null; hold.resolve(); }
});

test('C4: notes as the only lever, a standalone adapter shutdown: a turn that ends during the stop loop is applied by the run-end sweep, with its receipt', async () => {
  const W = world();
  const real = W.core.memory.noteVerdicts;
  W.core.memory.noteVerdicts = async (a) => { const r = await real(a); await W.core.memory.recordEvent({ kind: 'note_review', ok: true, key: 'applied:' + a.review_task_id }); return r; };
  const res = await W.shutdown({
    drainBudgetMs: 5000,
    stop: async () => { W.turn('rt-stop'); await ticks(40); }, // the turn ends while the stop loop runs: the close has begun, so no application starts
    onDrained: () => MP.runEnd(W.ctx), // what manager.cjs wires: the memory run-end, once the queues are drained
  });
  assert.strictEqual(res.stopped.length, 1);
  assert.deepStrictEqual(W.applied, ['rt-stop'], 'the run-end sweep applied the deferred hand-back');
  assert.ok(W.events.some((e) => e.key === 'applied:rt-stop'), 'with its receipt');
  assert.strictEqual(W.ctx.runEndError, undefined);
});
