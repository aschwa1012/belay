'use strict';
require('../helpers/tmp.cjs');
// policy-idle-close.test.cjs — the headless idle close holds for a plan's step due, in flight or just finished (policy-close-hold.cjs). A work
// task under a plan is handed back and judged done by the release evaluation, its named reviewer live and idle, nobody mid-turn: the executor's
// due() lists the review, and before this hold the close rule closed the run, leaving the step untaken. The REAL core, the REAL policy watcher
// reading it, the REAL executor and the REAL idleClose; only the close itself is a recorder. The read-order race (the worker rows read before
// the step finished, the snapshot after it) is forced by the order of the calls, not by timing.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { guarded } = require('../core/worktree-helpers.cjs');
const { env, workDone, RUN, REST } = require('./policy-review-env.cjs');
const { due } = require('../../src/run/policy-exec.cjs');
const PW = require('../../src/run/policy-wakes.cjs');
const { idleClose } = require('../../src/run/orchestrator-idle-close.cjs');
const { createPolicyCloseHold, DUE_HOLD_MS } = require('../../src/run/policy-close-hold.cjs');

const test = guarded(nodeTest);

// One idle pass of the real close rule (the pre-close read already spent), deciding on `rows` with the watcher's latest snapshot. -> { closed, live }.
async function idlePass(state, rows, watcher) {
  let closed = null; let live = null;
  await idleClose({
    state, rows, runId: RUN, pending_deaths: [], turnAtCall: 1, hold: { isPaused: () => false }, awaitingWakeIds: () => [],
    callWatcher: { holds: () => [] }, preClose: { check: async () => ({ ran: false }) },
    recordHold: (turn, busy, awaiting, by, pd, pk, lv) => { live = { busy, live: lv }; }, writeWake() {}, closeThenKillOnDeadline: (why) => { closed = why; },
    policyWatcher: watcher,
  });
  return { closed, live };
}
const newState = () => ({ pendingWrites: [], evalSeen: new Map(), finishing: false, idle: true });
const rowsOf = async (e) => (await e.orch.worker.list({})).workers;

test('a review step that is due holds the idle close, and the hold names it', async () => {
  const e = await env('idle-close-due');
  try {
    const { work } = await workDone(e, { review: { worker: 'rv' }, ...REST });
    await e.worker('rv');
    assert.deepStrictEqual(due({ runId: RUN, tasks: (await e.orch.task.list({})).tasks, integrations: [] }).map((c) => [c.step, c.task_id]), [['review', work.id]]);
    const w = PW.createPolicyWatcher({ core: e.orch, runId: RUN, enabled: true });
    const state = newState();
    for (let pass = 0; pass < 2; pass++) {
      await w.poll(state.evalSeen);
      const r = await idlePass(state, await rowsOf(e), w);
      assert.strictEqual(r.closed, null, `pass ${pass}: the run did not close with the review due`);
      assert.ok(r.live.live.includes(`policy:review:${work.id}`), JSON.stringify(r.live));
    }
  } finally { await e.close(); }
});

test('rows read before a step assigns and finishes, the snapshot after: the close holds that pass and decides on the next pass\'s rows', async () => {
  const e = await env('idle-close-race');
  try {
    const { work } = await workDone(e, { review: { worker: 'rv' }, ...REST });
    await e.worker('rv');
    const w = PW.createPolicyWatcher({ core: e.orch, runId: RUN, enabled: true });
    const state = newState();
    await w.poll(state.evalSeen);
    assert.strictEqual((await idlePass(state, await rowsOf(e), w)).closed, null, 'the review is due: held');
    // The interleaving: pollPass reads worker.list (nobody mid-turn), then the executor takes the review and finishes its claim, then the
    // watcher reads the snapshot. Nothing is due or in flight in that snapshot, and the rows predate the reviewer's turn.
    const stale = await rowsOf(e);
    const out = await e.exec().tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['review', 'done']]);
    await w.poll(state.evalSeen);
    const seq = out.steps[0].seq;
    const r = await idlePass(state, stale, w);
    assert.strictEqual(r.closed, null, 'the run did not close under the worker the step just gave work to');
    assert.ok(r.live.live.includes(`policy-done:${seq}`), JSON.stringify(r.live));
    // The next pass reads its rows after that snapshot: the reviewer's turn (here written as the message write marks it) holds the close itself.
    const fresh = (await rowsOf(e)).map((x) => (x.id === 'rv' ? { ...x, state: 'running', mid_turn: 1 } : x));
    await w.poll(state.evalSeen);
    const r2 = await idlePass(state, fresh, w);
    assert.strictEqual(r2.closed, null);
    assert.deepStrictEqual([r2.live.busy, r2.live.live.filter((n) => n.startsWith('policy'))], [['rv'], []], 'held by the busy reviewer, not by the step again');
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
    const w = PW.createPolicyWatcher({ core: e.orch, runId: RUN, enabled: true });
    const state = newState();
    await w.poll(state.evalSeen);
    assert.ok((await idlePass(state, await rowsOf(e), w)).closed, 'the run closed: a halted task waits for the orchestrator, whom its exception wakes');
  } finally { await e.close(); }
});

test('the due bound counts an idle executor only: a claim in flight restarts it, and an untaken step stops holding after DUE_HOLD_MS idle', async () => {
  const e = await env('idle-close-bound');
  try {
    const { work } = await workDone(e, { review: { worker: 'rv' }, ...REST });
    const w = PW.createPolicyWatcher({ core: e.orch, runId: RUN, enabled: true });
    await w.poll(new Map());
    const snap = w.snapshot();
    const name = `policy:review:${work.id}`;
    let t = 0;
    const h = createPolicyCloseHold({ now: () => t, alive: () => true });
    const busySnap = { ...snap, steps: snap.steps.concat({ run_id: RUN, seq: 99, step: 'integrate', outcome: 'started', trigger_table: 'task', trigger_id: 'other', trigger_seq: 1, claimant_pid: 4242 }) };
    assert.ok(h.holds(snap).includes(name));
    t = DUE_HOLD_MS - 1; assert.ok(h.holds(snap).includes(name));
    t = DUE_HOLD_MS + 5; assert.deepStrictEqual(h.holds(busySnap).sort(), [name, 'policy-step:99'].sort(), 'the executor is busy: the step waits its turn');
    t = 2 * DUE_HOLD_MS + 4; assert.ok(h.holds(snap).includes(name), 'aged from the end of the busy spell, not from its first sighting');
    t = 2 * DUE_HOLD_MS + 5; assert.deepStrictEqual(h.holds(snap), [], 'idle for DUE_HOLD_MS with the step untaken: no hold');
  } finally { await e.close(); }
});

test('a failed policy read holds; the watcher off holds nothing', () => {
  const h = createPolicyCloseHold();
  assert.deepStrictEqual(h.holds({ failed: true }), ['policy-read']);
  assert.deepStrictEqual(h.holds({ runId: RUN, tasks: [], steps: [], integrations: [], readFailed: true }), ['policy-read']);
  assert.deepStrictEqual(h.holds(null), []);
});

test('a claim in flight holds while its claimant is alive by pid and creation time; the creation time is read once per claimant', async () => {
  const reads = [];
  const created = { 111: '1000', 222: '9999' };
  const h = createPolicyCloseHold({ alive: (pid) => pid !== 333, createdOf: async (pid) => { reads.push(pid); return { created: created[pid] }; } });
  const step = (seq, pid, c) => ({ run_id: RUN, seq, step: 'integrate', outcome: 'started', trigger_table: 'task', trigger_id: `t${seq}`, trigger_seq: 1, claimant_pid: pid, claimant_created: c });
  const snap = { runId: RUN, tasks: [], integrations: [], steps: [step(5, 111, '1000'), step(6, 222, '2000'), step(7, 333, '3000'), step(8, 444, null), step(9, null, null)] };
  assert.deepStrictEqual(h.holds(snap), ['policy-step:5', 'policy-step:6', 'policy-step:8'], 'before the creation times answer, a live pid counts');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(h.holds(snap), ['policy-step:5', 'policy-step:8'], 'pid 222 is another process now: its claim holds nothing');
  h.holds(snap);
  assert.deepStrictEqual(reads.sort(), [111, 222], 'one read per claimant; a dead pid and a claim without a creation time read none');
});

test('a failed policy read holds for DUE_HOLD_MS of unbroken failures, then no longer (a store that never answers cannot hold a run for ever)', () => {
  let t = 0;
  const h = createPolicyCloseHold({ now: () => t });
  assert.deepStrictEqual(h.holds({ failed: true }), ['policy-read']);
  t = DUE_HOLD_MS - 1; assert.deepStrictEqual(h.holds({ failed: true }), ['policy-read']);
  t = DUE_HOLD_MS; assert.deepStrictEqual(h.holds({ failed: true }), [], 'past the bound');
  assert.deepStrictEqual(h.holds({ runId: RUN, tasks: [], steps: [], integrations: [] }), [], 'a read that works resets it');
  t = DUE_HOLD_MS + 5; assert.deepStrictEqual(h.holds({ failed: true }), ['policy-read'], 'a new run of failures holds again');
});
