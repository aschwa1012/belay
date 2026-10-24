'use strict';
process.env.BELAY_TEST_MODE = '1';
// run-close-stages-late.test.cjs — a run-close stage (the scrubber, the archive reviewer) that a fast close cut off keeps running
// behind the cut. Whatever it has not yet sent when the cut is declared must never reach the store: a receipt or an apply sent
// after `belay run` shut the owner down would elect a stray owner in the run process (invariant 2). The interleaving is forced by
// holding one call of the real stage until after the shutdown; no load, no sleeps.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { core, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { openCore } = core('index.cjs');
const { runCloseStages } = require('../../src/cli/run-close-stages.cjs');
const { TIMED_OUT } = require('../../src/run/orchestrator-interactive.cjs');
const { DEFAULTS } = require('../../src/run/memory-levers.cjs');

const RUN = 'late-stage-1';
const LEVERS = { ...DEFAULTS, notes: true, project: 'p' };

async function setup() {
  const dir = sandbox();
  const op = await openCore({ dataDir: dir, caller: { role: 'operator', run_id: RUN, pid: process.pid }, embed: false });
  await op.becomeOwner();
  const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, memory_levers: JSON.stringify(LEVERS), project: 'p' });
  await orch.close();
  return { dir, op };
}

// A harness view that logs each call it receives and holds the first call that matches `hold` until `release()`.
function spy(op, state, hold) {
  const view = op.harness();
  let release;
  const held = new Promise((r) => { release = r; });
  const wrap = (group) => Object.fromEntries(Object.entries(view[group]).map(([name, fn]) => [name, async (a) => {
    const id = `${group}.${name}`;
    state.calls.push({ call: id, afterShutdown: state.shutDown });
    if (hold(id) && !state.reached.done) { state.reached.done = true; state.reached.resolve(); await held; }
    return fn(a);
  }]));
  const out = { ...view };
  for (const g of Object.keys(view)) if (view[g] && typeof view[g] === 'object' && !Array.isArray(view[g]) && g !== 'caller') out[g] = wrap(g);
  return { harness: () => out, release };
}

// Fake stages that do what a real stage does after a stalled read: a receipt, then an apply.
const lateStages = (calls) => ({
  closeStages: async ({ core: c }) => {
    await c.memory.scrubScope({});
    await c.memory.recordEvent({ kind: 'scrub_job', key: 'late', ok: true, message: 'late receipt' }).catch((e) => calls.push({ refused: e.code }));
    return { scrub: { ran: true } };
  },
});

for (const which of ['real stages', 'stage that writes a receipt after the stalled read']) {
  test(`a cut run-close stage (${which}) sends nothing after the owner is shut down`, async () => {
    const { dir, op } = await setup();
    const state = { calls: [], shutDown: false, reached: { done: false, resolve: null } };
    const atStall = new Promise((r) => { state.reached.resolve = r; });
    const held = spy(op, state, (id) => id === 'memory.scrubScope' || id === 'memory.reviewQueue');
    const refusals = [];
    try {
      const ce = { bound: async () => { await atStall; return TIMED_OUT; }, hupSeen: () => false, leftMs: () => 0 };
      const stages = which === 'real stages' ? require('../../src/run/close-stages.cjs') : lateStages(refusals);
      let tailDone = null;
      const wrapped = { closeStages: (a) => { tailDone = stages.closeStages(a); return tailDone; } };
      const got = await runCloseStages({ core: held, runId: RUN, levers: { memory_levers: LEVERS }, dataDir: dir, ce, late: () => {}, stages: wrapped, killPid: async () => [] });
      assert.ok(got && got.cut, 'the fast close cut the stages');
      await op.shutdownOwner();
      state.shutDown = true;
      held.release();
      await tailDone;
      const late = state.calls.filter((c) => c.afterShutdown).map((c) => c.call);
      assert.deepStrictEqual(late, [], `nothing reached the store after the shutdown: ${JSON.stringify(late)}`);
      assert.strictEqual(op.isOwner(), false, 'no stray owner');
      assert.ok(!fs.existsSync(path.join(dir, 'owner.lock')), 'no owner.lock');
      if (which !== 'real stages') assert.deepStrictEqual(refusals, [{ refused: 'E_TIMEOUT' }], 'the stage saw its late receipt refused');
    } finally {
      held.release();
      if (op.isOwner()) await op.shutdownOwner();
      await op.close();
      cleanup(dir);
    }
  });
}
