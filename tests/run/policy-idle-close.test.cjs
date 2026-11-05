'use strict';
require('../helpers/tmp.cjs');
// policy-idle-close.test.cjs — the headless idle close holds for a plan's step due or in flight (policy-close-hold.cjs). A work task under a
// plan is handed back and judged done by the release evaluation, its named reviewer live and idle, nobody mid-turn: the executor's due()
// lists the review, and before this hold the close rule closed the run in its second idle pass (the pre-close read is the first), leaving the
// step untaken. The REAL core, the REAL policy watcher reading it, and the REAL idleClose; only the close itself is a recorder.
// A due step on a halted task does not hold, a due step that is never claimed stops holding after DUE_HOLD_MS, and a claim in flight
// holds while its claimant's pid is alive.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { guarded } = require('../core/worktree-helpers.cjs');
const { env, workDone, RUN, REST } = require('./policy-review-env.cjs');
const { due } = require('../../src/run/policy-exec.cjs');
const PW = require('../../src/run/policy-wakes.cjs');
const { idleClose } = require('../../src/run/orchestrator-idle-close.cjs');
const { policyHolds, DUE_HOLD_MS } = require('../../src/run/policy-close-hold.cjs');

const test = guarded(nodeTest);

// Two idle passes of the real close rule over the store's own worker rows: the pre-close read, then the close. -> { closed, holds }.
async function idlePasses(e, watcher) {
  const rows = (await e.orch.worker.list({})).workers;
  const state = { pendingWrites: [], evalSeen: new Map(), finishing: false, idle: true };
  let closed = null; const holds = [];
  for (let pass = 1; pass <= 2 && !closed; pass++) {
    await watcher.poll(state.evalSeen);
    await idleClose({
      state, rows, runId: RUN, pending_deaths: [], turnAtCall: 1, hold: { isPaused: () => false }, awaitingWakeIds: () => [],
      callWatcher: { holds: () => [] }, preClose: { check: async () => (pass === 1 ? { ran: true, wake: null } : { ran: false }) },
      recordHold: (turn, busy, awaiting, by, pd, pk, live) => holds.push(live), writeWake() {}, closeThenKillOnDeadline: (why) => { closed = why; },
      policyWatcher: watcher,
    });
  }
  return { closed, holds };
}

test('a review step that is due holds the idle close, and the hold names it', async () => {
  const e = await env('idle-close-due');
  try {
    const { work } = await workDone(e, { review: { worker: 'rv' }, ...REST });
    await e.worker('rv');
    assert.deepStrictEqual(due({ runId: RUN, tasks: (await e.orch.task.list({})).tasks, integrations: [] }).map((c) => [c.step, c.task_id]), [['review', work.id]]);
    const { closed, holds } = await idlePasses(e, PW.createPolicyWatcher({ core: e.orch, runId: RUN, enabled: true }));
    assert.strictEqual(closed, null, 'the run did not close with the review due');
    assert.ok(holds.length && holds.every((live) => live.includes(`policy:review:${work.id}`)), JSON.stringify(holds));
  } finally { await e.close(); }
});

test('a due step on a task an exception halts does not hold the close', async () => {
  const e = await env('idle-close-halted');
  try {
    // A check that fails once and passes on its retry: the work is done, flaky, and E6 halts it, while its review is still due by the plan.
    const script = `${e.dir}/flaky.cjs`.split('\\').join('/');
    fs.writeFileSync(script, "const fs = require('fs'); const m = __filename + '.ran'; if (fs.existsSync(m)) process.exit(0); fs.writeFileSync(m, '1'); process.exit(1);\n");
    const { work } = await workDone(e, { review: { worker: 'rv' }, ...REST }, { create: { acceptance: { commands: [{ argv: [process.execPath, script], timeout_ms: 20000, retries_on_fail: 1 }] } } });
    await e.worker('rv');
    const tasks = (await e.orch.task.list({})).tasks;
    assert.deepStrictEqual(due({ runId: RUN, tasks, integrations: [] }).map((c) => c.step), ['review'], 'the review is due by the plan');
    const ex = PW.derive({ runId: RUN, tasks, integrations: [], steps: [], failures: [] });
    assert.ok(PW.haltedIds(ex, tasks).has(work.id), `the work is halted: ${JSON.stringify(ex.map((x) => x.exception))}`);
    const { closed } = await idlePasses(e, PW.createPolicyWatcher({ core: e.orch, runId: RUN, enabled: true }));
    assert.ok(closed, 'the run closed: a halted task waits for the orchestrator, not for belay');
  } finally { await e.close(); }
});

test('a due step that is never claimed stops holding after DUE_HOLD_MS', async () => {
  const e = await env('idle-close-bound');
  try {
    const { work } = await workDone(e, { review: { worker: 'rv' }, ...REST });
    const w = PW.createPolicyWatcher({ core: e.orch, runId: RUN, enabled: true });
    await w.poll(new Map());
    const since = new Map();
    assert.deepStrictEqual(policyHolds(w.snapshot(), since, { nowMs: 1000 }), [`policy:review:${work.id}`]);
    assert.deepStrictEqual(policyHolds(w.snapshot(), since, { nowMs: 1000 + DUE_HOLD_MS - 1 }), [`policy:review:${work.id}`]);
    assert.deepStrictEqual(policyHolds(w.snapshot(), since, { nowMs: 1000 + DUE_HOLD_MS }), [], 'past the bound it holds nothing');
  } finally { await e.close(); }
});

test('a claim in flight holds while its claimant lives; a dead or unnamed claimant holds nothing; no snapshot holds nothing', () => {
  const step = (seq, pid) => ({ run_id: RUN, seq, step: 'integrate', outcome: 'started', trigger_table: 'task', trigger_id: 'r', trigger_seq: 1, ...(pid ? { claimant_pid: pid } : {}) });
  const snap = { runId: RUN, tasks: [], integrations: [], steps: [step(5, 111), step(6, 222), step(7, null), { ...step(8, 111), outcome: 'done' }] };
  assert.deepStrictEqual(policyHolds(snap, new Map(), { alive: (pid) => pid === 111 }), ['policy-step:5']);
  assert.deepStrictEqual(policyHolds(null, new Map()), []);
});
