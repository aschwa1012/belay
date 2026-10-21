'use strict';
// The reviewer's repro of a cut during the run-end notes sweep: every store call the sweep makes goes through the run-end gate (gated-core.cjs).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { openCore } = core('index.cjs');
const { memoryRunEnd } = require('../../src/cli/run-memory-end.cjs');
const MJ = require('../../src/run/memory-jobs.cjs');
const { TIMED_OUT } = require('../../src/run/orchestrator-interactive.cjs');
const { DEFAULTS } = require('../../src/run/memory-levers.cjs');
const RUN = 'late-sweep-1';
const LEVERS = { ...DEFAULTS, notes: true, project: 'p', summaries: 'off', wrapup: false };

test('a cut during the notes sweep writes nothing after the shutdown', async () => {
  const dir = sandbox();
  const op = await openCore({ dataDir: dir, caller: { role: 'operator', run_id: RUN, pid: process.pid }, embed: false });
  await op.becomeOwner();
  const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, memory_levers: JSON.stringify(LEVERS), project: 'p' });
  const t = await orch.task.create({ spec: 'x' });
  // An ended review task gives the notes sweep a hand-back to apply (memory.noteVerdicts, a write).
  const rt = await orch.task.create({ spec: 'review', acceptance: { verdict: true } });
  await orch.worker.write({ id: 'rev-1', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's2', last_event_at: Date.now() });
  const ra = await orch.task.assign({ task_id: rt.id, worker_id: 'rev-1' });
  const rw = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'rev-1', run_id: RUN }), embed: false });
  await rw.lease.release({ lease_id: ra.new_lease.id, reason: 'done', notes: [], result: { summary: 'reviewed', verdict: 'holds' } });
  await rw.close();
  await orch.worker.write({ id: 'rev-1', substrate: 'claude-code', pid: process.pid, state: 'dead', session_id: 's2', task_id: rt.id });
  await orch.close();
  const state = { calls: [], shutDown: false };
  let reached; const atStall = new Promise((r) => { reached = r; });
  let release; const held = new Promise((r) => { release = r; });
  const view = op.harness();
  const wrap = (group) => Object.fromEntries(Object.entries(view[group]).map(([name, fn]) => [name, async (a) => {
    state.calls.push({ call: `${group}.${name}`, afterShutdown: state.shutDown });
    if (`${group}.${name}` === 'memory.noteVerdicts') { reached(); await held; }
    return fn(a);
  }]));
  const out = { ...view, worker: wrap('worker'), task: wrap('task'), memory: wrap('memory'), usage: wrap('usage') };
  const heldCore = { harness: () => out };
  let tail = null;
  try {
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
  } finally {
    if (tail) await tail.catch(() => {});
    if (op.isOwner()) await op.shutdownOwner();
    await op.close();
    cleanup(dir);
  }
});
