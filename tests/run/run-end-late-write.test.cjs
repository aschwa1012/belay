'use strict';
// run-end-late-write.test.cjs — a run-end memory job that a fast close cut off must not write after the store owner is
// gone. The cut leaves the job running behind it (run-interactive.cjs `within`); a call that stalls past the cut returns
// after `belay run` has shut the owner down, and the next step used to write through the retired Core, which elected a
// stray owner in this process (invariant 2). The interleaving is forced with a stalled call, no load and no sleeps. Each
// stall point runs with the notes lever off and on: the notes sweep (note-review.cjs) is part of the run-end jobs when it is on.

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
const BASE = { ...DEFAULTS, capture: true, observations: true, summaries: 'mechanical', wrapup: true };
const leversFor = (notes) => (notes ? { ...BASE, notes: true, project: 'p' } : BASE);

// `belay run`'s core is the owner; a done task and its dead worker give the run-end jobs something to write. With notes on, an
// ended review task gives the sweep a hand-back to apply.
async function setup(notes) {
  const dir = sandbox();
  const op = await openCore({ dataDir: dir, caller: { role: 'operator', run_id: RUN, pid: process.pid }, embed: false });
  await op.becomeOwner();
  const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, memory_levers: JSON.stringify(leversFor(notes)), ...(notes ? { project: 'p' } : {}) });
  const t = await orch.task.create({ spec: 'build the parser' });
  await orch.worker.write({ id: 'coder-1', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's1', last_event_at: Date.now(), task_id: t.id });
  const a = await orch.task.assign({ task_id: t.id, worker_id: 'coder-1' });
  const w = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'coder-1', run_id: RUN }), embed: false });
  await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { summary: 'parser built', verdict: 'holds' }, ...(notes ? { notes: [] } : {}) });
  await w.close();
  await orch.worker.write({ id: 'coder-1', substrate: 'claude-code', pid: process.pid, state: 'dead', session_id: 's1', task_id: t.id });
  if (notes) {
  // An ended review task gives the notes sweep a hand-back to apply (memory.noteVerdicts, a write).
  const rt = await orch.task.create({ spec: 'review', acceptance: { verdict: true } });
  await orch.worker.write({ id: 'rev-1', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's2', last_event_at: Date.now() });
  const ra = await orch.task.assign({ task_id: rt.id, worker_id: 'rev-1' });
  const rw = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'rev-1', run_id: RUN }), embed: false });
  await rw.lease.release({ lease_id: ra.new_lease.id, reason: 'done', notes: [], result: { summary: 'reviewed', verdict: 'holds' } });
  await rw.close();
  await orch.worker.write({ id: 'rev-1', substrate: 'claude-code', pid: process.pid, state: 'dead', session_id: 's2', task_id: rt.id });
  }
  await orch.close();
  return { dir, op };
}

// The harness view with the `target` call held until `release()`, and every call logged against the shutdown flag. 'sweep.events'
// is the notes sweep's own memory.noteVerdicts (a review task's hand-back).
function stalled(op, state, target) {
  const view = op.harness();
  let release;
  const held = new Promise((r) => { release = r; });
  const wrap = (group) => Object.fromEntries(Object.entries(view[group]).map(([name, fn]) => [name, async (a) => {
    const id = `${group}.${name}`;
    state.calls.push({ call: id, afterShutdown: state.shutDown });
    const hit = id === target || (target === 'sweep.verdicts' && id === 'memory.noteVerdicts');
    if (hit) { state.reached(); await held; }
    return fn(a);
  }]));
  const out = { ...view, worker: wrap('worker'), task: wrap('task'), memory: wrap('memory'), usage: wrap('usage') };
  return { harness: () => out, release };
}

for (const notes of [false, true]) {
  const targets = ['task.list', 'worker.list', 'memory.events', ...(notes ? ['sweep.verdicts'] : [])];
  for (const target of targets) {
    test(`a run-end job cut by the fast close (notes ${notes ? 'on' : 'off'}) while ${target} stalls writes nothing once the owner is shut down, and elects no stray owner`, async () => {
      const { dir, op } = await setup(notes);
      const state = { calls: [], shutDown: false, reached: null };
      const atStall = new Promise((r) => { state.reached = r; });
      let tail = null;
      try {
        const held = stalled(op, state, target);
        // A console whose budget is spent as soon as the stalled call is reached: whatever is awaited then is cut.
        const ce = { bound: async () => { await atStall; return TIMED_OUT; } };
        const jobs = { runEndJobs: (args) => { tail = MJ.runEndJobs(args); return tail; } };
        const got = await memoryRunEnd({ core: held, runId: RUN, levers: { memory_levers: leversFor(notes) }, ce, jobs, late: () => {} });
        assert.deepStrictEqual(got, { outcome: 'cut' }, 'the fast close cut the run-end jobs');
        await op.shutdownOwner();
        state.shutDown = true;
        assert.ok(!fs.existsSync(path.join(dir, 'owner.lock')), 'the owner is gone');
        held.release(); // the stalled call now returns, after the shutdown
        await tail;
        const late = state.calls.filter((c) => c.afterShutdown && !/\.(list|get|events|reviewBrief)$/.test(c.call));
        assert.deepStrictEqual(late, [], `no write reached the store after the shutdown: ${JSON.stringify(late.map((c) => c.call))}`);
        assert.strictEqual(op.isOwner(), false, 'no stray owner was elected');
        assert.ok(!fs.existsSync(path.join(dir, 'owner.lock')), 'no owner.lock came back');
      } finally {
        if (tail) await tail.catch(() => {});
        if (op.isOwner()) await op.shutdownOwner();
        await op.close();
        cleanup(dir);
      }
    });
  }
}

test('a Core that has shut its owner down refuses a write instead of electing a stray owner, and says which call', async () => {
  const { dir, op } = await setup(false);
  try {
    await op.shutdownOwner();
    await assert.rejects(() => op.memory.recordEvent({ kind: 'wrapup', key: 'late', ok: true, message: 'x' }), (e) => {
      assert.strictEqual(e.code, 'E_SHUTDOWN', e.message);
      assert.match(e.message, /memory\.recordEvent was refused/);
      return true;
    });
    assert.strictEqual(op.isOwner(), false);
    assert.ok(!fs.existsSync(path.join(dir, 'owner.lock')), 'nothing was elected');
    // A different Core (another command, another process) is not affected, and neither is an explicit election here.
    const other = await openCore({ dataDir: dir, caller: { role: 'operator', run_id: RUN, pid: process.pid }, embed: false });
    await other.becomeOwner();
    assert.ok(other.isOwner());
    await other.shutdownOwner();
    await other.close();
    const again = await op.becomeOwner();
    assert.strictEqual(again.owner, true, 'becomeOwner() elects on purpose');
    await op.shutdownOwner();
  } finally {
    if (op.isOwner()) await op.shutdownOwner();
    await op.close();
    cleanup(dir);
  }
});

test('gatedCore works over the real, frozen harness view: calls pass until the gate is set, then are refused E_TIMEOUT', async () => {
  const { gatedCore } = require('../../src/run/gated-core.cjs');
  const { dir, op } = await setup(false);
  try {
    const view = op.harness();
    assert.ok(Object.isFrozen(view));
    const gate = { aborted: false };
    const g = gatedCore(view, gate, 'the test step');
    assert.ok(Array.isArray((await g.task.list({})).tasks));
    assert.strictEqual(g.caller.channel, 'harness');
    gate.aborted = true;
    await assert.rejects(() => g.task.list({}), (e) => e.code === 'E_TIMEOUT' && /the test step gave up/.test(e.message));
  } finally { await op.shutdownOwner(); await op.close(); cleanup(dir); }
});
