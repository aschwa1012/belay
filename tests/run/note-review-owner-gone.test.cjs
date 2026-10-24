'use strict';
// note-review-owner-gone.test.cjs — a review task that ends after the close began writes nothing (audit D66). A verdict application is a
// write; one begun after the owner is marked gone would elect a second store owner inside the adapter (invariant 2). The turn path drops
// it once the closed flag is up (afterTurn names the drop on the worker), and the run's store-only sweep applies it later. Proven with a
// fake core, no sleeps, only ticks.

const test = require('node:test');
const assert = require('node:assert');
const { DEFAULTS } = require('../../src/core/memory-levers.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const MJ = require('../../src/run/memory-jobs.cjs');
const NR = require('../../src/run/note-review.cjs');

const LV = { ...DEFAULTS, project: 'demo', notes: true, cost_ledger: true };
const ticks = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function world() {
  const core = createFakeCore({ runId: 'run-fake' });
  const events = [];
  const verdicts = [];
  const review = { id: 'rt', state: 'released', acceptance: { verdict: true }, handoff: { at: 1, result: {} } };
  core.run = { get: async () => ({ run: { memory_levers: JSON.stringify(LV) } }) };
  core.task.get = async () => review;
  core.task.list = async () => ({ tasks: [review] });
  core.worker.list = async () => ({ workers: [] });
  Object.assign(core.memory, {
    events: async () => ({ events: events.slice() }),
    recordEvent: async (e) => { events.push(e); return e; },
    noteBriefCapture: async (a) => ({ ref: 'fake', notes: a.notes.length, event_id: 'me-fake' }),
    reviewBrief: async () => ({ notes: [], reports: [], review: false, refuted_shown: [], reviewed_tasks: [] }),
    noteVerdicts: async (a) => { verdicts.push(a); return { applied: [], refused: [], already: [], unjudged: [] }; },
  });
  const flags = { closed: false, closing: false, ownerGone: false };
  const ctx = { core, runId: 'run-fake', dataDir: 'unused', memoryLevers: LV, worktree: 'unused', manager: { flags }, shutdownFlags: flags };
  const w = { id: 'wa', queue: Promise.resolve(), state: 'running' };
  const turn = () => MJ.afterTurn(w, ctx, { snap: { taskId: 'rt', workerId: 'wa', turn: 1, substrate: 'claude-code', pid: 1, cost: 0.1 } });
  return { core, flags, verdicts, events, turn, w, ctx, review };
}

test('control: while the run is open, an ended review task\'s verdicts are applied once', async () => {
  const W = world();
  W.turn(); await ticks();
  assert.deepStrictEqual(W.verdicts, [{ review_task_id: 'rt' }]);
  W.turn(); await ticks();
  assert.strictEqual(W.verdicts.length, 1, 'a second turn of the same review applies nothing more in this manager');
});

test('a review task that ends once the closed flag is up applies nothing, and says so on the worker', async () => {
  const W = world();
  W.flags.closed = true; W.flags.ownerGone = true;
  W.turn(); await ticks();
  assert.deepStrictEqual(W.verdicts, [], 'no verdict write after the close');
  assert.deepStrictEqual(W.events.filter((e) => e.kind === 'review_job'), [], 'no receipt either');
  assert.strictEqual(W.w.lastError.where, 'after-shutdown');
});

test('a turn queued before the close whose work runs after the flag flips is dropped too', async () => {
  const W = world();
  let release;
  W.w.memoryQueue = new Promise((r) => { release = r; }); // an earlier job on the worker's queue holds this one back
  W.turn(); await ticks();
  W.flags.closed = true;
  release(); await ticks(80);
  assert.deepStrictEqual(W.verdicts, []);
  assert.strictEqual(W.w.lastError.where, 'after-shutdown');
});

test('the run-end sweep, store-only, applies the hand-back a closed run left', async () => {
  const W = world();
  await NR.sweep({ ctx: W.ctx, core: W.core, lv: LV, w: null, gate: { aborted: false }, s: {}, turnPath: false }, [W.review]);
  assert.deepStrictEqual(W.verdicts, [{ review_task_id: 'rt' }]);
});
