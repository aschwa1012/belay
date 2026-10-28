'use strict';
// The reviewer's repro of a cut during the run-end notes sweep: every store call the sweep makes goes through the run-end gate (gated-core.cjs).
const test = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { teardown } = require('../helpers/teardown.cjs');
const { openCore } = core('index.cjs');
const { memoryRunEnd } = require('../../src/cli/run-memory-end.cjs');
const MJ = require('../../src/run/memory-jobs.cjs');
const { TIMED_OUT } = require('../../src/run/orchestrator-interactive.cjs');
const { DEFAULTS } = require('../../src/run/memory-levers.cjs');
const RUN = 'late-sweep-1';
const LEVERS = { ...DEFAULTS, notes: true, project: 'p', summaries: 'off', wrapup: false };

test('a cut during the notes sweep writes nothing after the shutdown', async () => {
  // Every owner, core and directory registers its teardown right after it is created (run last-in first-out); the body's error wins, else the
  // first teardown error fails the test.
  const steps = [];
  let bodyError = null;
  let release = () => {};
  let tail = null;
  try {
    const dir = sandbox();
    steps.push(() => cleanup(dir));
    const op = await openCore({ dataDir: dir, caller: { role: 'operator', run_id: RUN, pid: process.pid }, embed: false });
    steps.push(() => op.close());
    await op.becomeOwner();
    steps.push(async () => { if (op.isOwner()) await op.shutdownOwner(); });
    const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
    const closeOrch = () => orch.close();
    steps.push(closeOrch);
    await orch.run.attach({ adapter_pid: process.pid, memory_levers: JSON.stringify(LEVERS), project: 'p' });
    await orch.task.create({ spec: 'x' });
    // An ended review task gives the notes sweep a hand-back to apply (memory.noteVerdicts, a write).
    const rt = await orch.task.create({ spec: 'review', acceptance: { verdict: true } });
    await orch.worker.write({ id: 'rev-1', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's2', last_event_at: Date.now() });
    const ra = await orch.task.assign({ task_id: rt.id, worker_id: 'rev-1' });
    const rw = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'rev-1', run_id: RUN }), embed: false });
    const closeRw = () => rw.close();
    steps.push(closeRw);
    await rw.lease.release({ lease_id: ra.new_lease.id, reason: 'done', notes: [], result: { summary: 'reviewed', verdict: 'holds' } });
    await rw.close();
    steps.splice(steps.indexOf(closeRw), 1);
    await orch.worker.write({ id: 'rev-1', substrate: 'claude-code', pid: process.pid, state: 'dead', session_id: 's2', task_id: rt.id });
    await orch.close();
    steps.splice(steps.indexOf(closeOrch), 1);
    const state = { calls: [], shutDown: false };
    let reached; const atStall = new Promise((r) => { reached = r; });
    const held = new Promise((r) => { release = r; });
    steps.push(() => tail); // the tail is awaited last-but-one: its own failure is a teardown error unless the body already failed
    steps.push(() => release()); // a failed assertion below must not leave the stalled call, and so the tail, waiting forever (runs first)
    const view = op.harness();
    const wrap = (group) => Object.fromEntries(Object.entries(view[group]).map(([name, fn]) => [name, async (a) => {
      state.calls.push({ call: `${group}.${name}`, afterShutdown: state.shutDown });
      if (`${group}.${name}` === 'memory.noteVerdicts') { reached(); await held; }
      return fn(a);
    }]));
    const out = { ...view, worker: wrap('worker'), task: wrap('task'), memory: wrap('memory'), usage: wrap('usage') };
    const heldCore = { harness: () => out };
    const ce = { bound: async () => { await atStall; return TIMED_OUT; } };
    const jobs = { runEndJobs: (args) => { tail = MJ.runEndJobs(args); return tail; } };
    const got = await memoryRunEnd({ core: heldCore, runId: RUN, levers: { memory_levers: LEVERS }, ce, jobs, late: () => {} });
    assert.deepStrictEqual(got, { outcome: 'cut' });
    await op.shutdownOwner();
    state.shutDown = true;
    release();
    await tail;
    const late = state.calls.filter((c) => c.afterShutdown);
    assert.deepStrictEqual(late.filter((c) => !/\.(list|get|events|reviewBrief)$/.test(c.call)), [], 'no write after the shutdown');
    assert.strictEqual(op.isOwner(), false, 'no stray owner');
  } catch (e) {
    bodyError = e === undefined ? new Error('undefined was thrown') : e;
    throw bodyError;
  } finally {
    release();
    await teardown(bodyError, steps.slice().reverse());
  }
});
