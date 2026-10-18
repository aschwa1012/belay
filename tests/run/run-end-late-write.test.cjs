'use strict';
// run-end-late-write.test.cjs — a run-end memory job that a fast close cut off must not write after the store owner is
// gone. The cut leaves the job running behind it (run-interactive.cjs `within`); a read that stalls past the cut returns
// after `belay run` has shut the owner down, and the next step used to write through the retired Core, which elected a
// stray owner in this process (invariant 2). The interleaving is forced with a stalled worker.list, no load and no sleeps.

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

const RUN = 'late-write-1';
const LEVERS = { ...DEFAULTS, capture: true, observations: true, summaries: 'mechanical', wrapup: true };

// `belay run`'s core is the owner; a done task and its dead worker give the run-end jobs something to write.
async function setup() {
  const dir = sandbox();
  const op = await openCore({ dataDir: dir, caller: { role: 'operator', run_id: RUN, pid: process.pid }, embed: false });
  await op.becomeOwner();
  const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, memory_levers: JSON.stringify(LEVERS) });
  const t = await orch.task.create({ spec: 'build the parser' });
  await orch.worker.write({ id: 'coder-1', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's1', last_event_at: Date.now(), task_id: t.id });
  const a = await orch.task.assign({ task_id: t.id, worker_id: 'coder-1' });
  const w = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'coder-1', run_id: RUN }), embed: false });
  await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { summary: 'parser built', verdict: 'holds' } });
  await w.close();
  await orch.worker.write({ id: 'coder-1', substrate: 'claude-code', pid: process.pid, state: 'dead', session_id: 's1', task_id: t.id });
  await orch.close();
  return { dir, op };
}

// The harness view with the `target` call held until `release()`, and every call logged against the shutdown flag.
function stalled(op, state, target) {
  const view = op.harness();
  let release;
  const held = new Promise((r) => { release = r; });
  const wrap = (group) => Object.fromEntries(Object.entries(view[group]).map(([name, fn]) => [name, async (a) => {
    state.calls.push({ call: `${group}.${name}`, afterShutdown: state.shutDown });
    if (`${group}.${name}` === target) { state.reached(); await held; }
    return fn(a);
  }]));
  const out = { ...view, worker: wrap('worker'), task: wrap('task'), memory: wrap('memory'), usage: wrap('usage') };
  return { harness: () => out, release };
}

for (const target of ['task.list', 'worker.list', 'memory.events']) test(`a run-end job cut by the fast close while ${target} stalls writes nothing once the owner is shut down, and elects no stray owner`, async () => {
  const { dir, op } = await setup();
  const state = { calls: [], shutDown: false, reached: null };
  const atList = new Promise((r) => { state.reached = r; });
  let tail = null;
  try {
    const held = stalled(op, state, target);
    // A console whose budget is spent as soon as the stalled read is reached: whatever is awaited then is cut.
    const ce = { bound: async () => { await atList; return TIMED_OUT; } };
    const jobs = { runEndJobs: (args) => { tail = MJ.runEndJobs(args); return tail; } };
    const got = await memoryRunEnd({ core: held, runId: RUN, levers: { memory_levers: LEVERS }, ce, jobs, late: () => {} });
    assert.deepStrictEqual(got, { outcome: 'cut' }, 'the fast close cut the run-end jobs');
    await op.shutdownOwner();
    state.shutDown = true;
    assert.ok(!fs.existsSync(path.join(dir, 'owner.lock')), 'the owner is gone');
    held.release(); // the stalled call now returns, after the shutdown
    await tail;
    const late = state.calls.filter((c) => c.afterShutdown);
    assert.deepStrictEqual(late, [], `no call reached the store after the shutdown: ${JSON.stringify(late.map((c) => c.call))}`);
    assert.strictEqual(op.isOwner(), false, 'no stray owner was elected');
    assert.ok(!fs.existsSync(path.join(dir, 'owner.lock')), 'no owner.lock came back');
  } finally {
    if (tail) await tail.catch(() => {});
    if (op.isOwner()) await op.shutdownOwner();
    await op.close();
    cleanup(dir);
  }
});
