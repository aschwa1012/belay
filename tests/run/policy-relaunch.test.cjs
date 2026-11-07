'use strict';
require('../helpers/tmp.cjs');
// policy-relaunch.test.cjs — a dead builder is relaunched once by the plan, and the orchestrator is woken (E4) only if that did not work
// (ADR 0074 amendment 5). The executor over the REAL core; the wake side over the rows a poll reads.

const { test } = require('node:test');
const assert = require('node:assert');
const { deadPid } = require('../core/helpers.cjs');
const PW = require('../../src/run/policy-wakes.cjs');
const RL = require('../../src/run/policy-relaunch.cjs');
const { due } = require('../../src/run/policy-exec.cjs');
const { env, stepRows, wakesOf, PASS, REST, RUN } = require('./policy-review-env.cjs');

const die = (e, id) => e.orch.worker.write({ id, state: 'dead', pid: deadPid(), exit_code: 1, death_established_by: 'exit-event' });

// A plan task built by b1 (a named worker) and then b1 dies: the task is open and unleased again.
async function builtThenDead(e) {
  const t = await e.orch.task.create({ spec: 'write b.txt', acceptance: PASS, policy: { build: { worker: 'b1' }, ...REST } });
  await e.worker('b1');
  assert.deepStrictEqual((await e.exec().tick()).steps.map((s) => [s.step, s.outcome]), [['build', 'done']]);
  await die(e, 'b1');
  const row = (await e.h.task.list({})).tasks.find((x) => x.id === t.id);
  assert.deepStrictEqual([row.state, row.lease], ['open', null]);
  return t;
}
// The run manager's restart reduced to its effect: the same worker is up again and holds its task.
const restarter = (e, taskId, calls) => async (id) => {
  calls.push(id);
  await e.orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, last_event_at: Date.now() });
  await e.orch.task.assign({ task_id: taskId, worker_id: id });
};

test('a dead builder is relaunched once with no exception and no wake; a second death is the orchestrator\'s', async () => {
  const e = await env('relaunch-once');
  try {
    const t = await builtThenDead(e);
    const calls = [];
    const x = e.exec({ restartWorker: restarter(e, t.id, calls) });
    const out = await x.tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.task_id, s.outcome]), [['relaunch', t.id, 'done']]);
    assert.deepStrictEqual(calls, ['b1'], 'the same worker, restarted');
    const [, step] = stepRows(e);
    assert.match(step.row_ref, /^lease:/, 'the claim names the lease the builder holds again');
    assert.deepStrictEqual((await wakesOf(e)).map((w) => w.exception), [], 'belay raised no exception for the death');
    // It dies again: the bound is used, so no step is taken and the death is left to the E4 wake.
    await die(e, 'b1');
    assert.deepStrictEqual((await x.tick()).steps, []);
    assert.strictEqual(stepRows(e).filter((s) => s.step === 'relaunch').length, 1);
  } finally { await e.close(); }
});

test('a relaunch that cannot be done ends skipped with its reason: no E8, and the death is released to the orchestrator', async () => {
  const e = await env('relaunch-refused');
  try {
    const t = await builtThenDead(e);
    const x = e.exec({ restartWorker: async () => { throw Object.assign(new Error('no such worker here'), { code: 'E_NOT_FOUND' }); } });
    const out = await x.tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['relaunch', 'skipped']]);
    assert.match(stepRows(e)[1].error, /relaunch refused: restart: E_NOT_FOUND/);
    assert.deepStrictEqual((await wakesOf(e)).map((w) => w.exception), [], 'a skipped step is not an exception');
    // The wake side: the held death is sent once the step ended without a relaunch.
    const tasks = (await e.h.task.list({})).tasks; const byId = new Map(tasks.map((r) => [r.id, r]));
    const ev = { event: 'death', worker_id: 'b1', turn: 1, seq: 9, life: 'p:1' };
    const seen = { policyArmed: true };
    const args = { core: e.h, runId: RUN, seen, tasks, byId, polOf: (r) => PW.policyOf(r, byId), rootOf: (r) => PW.rootOf(r, byId) };
    const sent = await RL.holdDeaths({ ...args, events: [ev] });
    assert.deepStrictEqual(sent, [ev], `the relaunch step is over and did not relaunch: ${t.id}`);
  } finally { await e.close(); }
});

test('a task the orchestrator assigned itself, or a builder that is alive, is never relaunched', async () => {
  const e = await env('relaunch-skip');
  try {
    const t = await e.orch.task.create({ spec: 'mine', acceptance: PASS, policy: { build: { worker: 'b1' } } });
    await e.worker('w-own');
    await e.orch.task.assign({ task_id: t.id, worker_id: 'w-own' });
    await die(e, 'w-own');
    const calls = [];
    assert.deepStrictEqual((await e.exec({ restartWorker: restarter(e, t.id, calls) }).tick()).steps.filter((s) => s.step === 'relaunch'), [], 'no build step took it');
    assert.deepStrictEqual(calls, []);
  } finally { await e.close(); }
});

// The pure side: which relaunch is due, under which cap.
const task = (id, extra = {}) => ({ id, run_id: 'r', state: 'open', lease: null, seq: 5, depends_on: [], policy: { build: { worker: 'b1' } }, ...extra });
const built = (id, worker = 'b1') => ({ seq: 1, run_id: 'r', step: 'build', task_id: id, outcome: 'done', worker_id: worker, trigger_table: 'task', trigger_id: id, trigger_seq: 1 });
const dead = (id = 'b1') => ({ id, state: 'dead' });

test('due: a dead builder\'s open task is a relaunch; a live one, a used bound, a missing build step or no worker rows are not', () => {
  const base = { runId: 'r', tasks: [task('T')], steps: [built('T')], workers: [dead()] };
  assert.deepStrictEqual(due(base).map((c) => [c.step, c.task_id, c.worker, c.trigger.seq]), [['relaunch', 'T', 'b1', 5]]);
  assert.deepStrictEqual(due({ ...base, workers: [{ id: 'b1', state: 'running' }] }).filter((c) => c.step === 'relaunch'), []);
  assert.deepStrictEqual(due({ ...base, steps: [built('T'), { ...built('T'), seq: 2, step: 'relaunch', outcome: 'done', trigger_seq: 3 }] }).filter((c) => c.step === 'relaunch'), [], 'one relaunch a task');
  assert.deepStrictEqual(due({ ...base, steps: [built('T'), { ...built('T'), seq: 2, step: 'relaunch', outcome: 'skipped', error: 'E_PAUSED: x', trigger_seq: 5 }] }).map((c) => c.step), ['relaunch'], 'a retake after a pause is not a used relaunch');
  assert.deepStrictEqual(due({ ...base, steps: [] }).filter((c) => c.step === 'relaunch'), [], 'the plan did not build it');
  assert.deepStrictEqual(due({ ...base, workers: undefined }).filter((c) => c.step === 'relaunch'), [], 'no worker rows read');
});

test('due: a relaunch takes a build slot, and past max_parallel_builds it is listed capped', () => {
  const busy = task('B', { state: 'assigned', lease: { holder: 'b2', expired: false } });
  const rows = due({ runId: 'r', tasks: [task('T'), busy], steps: [built('T')], workers: [dead()], maxBuilds: 1 }).filter((c) => c.step === 'relaunch');
  assert.deepStrictEqual(rows.map((c) => c.capped), [true]);
  assert.deepStrictEqual(due({ runId: 'r', tasks: [task('T'), busy], steps: [built('T')], workers: [dead()], maxBuilds: 2 }).filter((c) => c.step === 'relaunch').map((c) => c.capped), [undefined]);
});

// The wake side, on the rows a poll reads.
test('holdDeaths: a death the plan will relaunch waits, is dropped when the relaunch is done, and is sent when it is not or takes too long', async () => {
  const byId = new Map([['T', task('T')]]);
  let steps = [built('T')];
  const core = { policy: { list: async () => ({ rows: steps.slice() }) } };
  const ev = { event: 'death', worker_id: 'b1', turn: 1, seq: 9, life: 'p:1' };
  let clock = 1000;
  const seen = { policyArmed: true };
  const call = (events) => RL.holdDeaths({ core, runId: 'r', events, seen, tasks: [...byId.values()], byId, polOf: (t) => PW.policyOf(t, byId), rootOf: (t) => PW.rootOf(t, byId), now: () => clock });
  assert.deepStrictEqual(await call([ev]), [], 'held: the orchestrator is not woken yet');
  assert.deepStrictEqual(await call([]), [], 'still waiting for the step');
  steps = [built('T'), { seq: 2, run_id: 'r', step: 'relaunch', task_id: 'T', outcome: 'started', worker_id: 'b1', trigger_table: 'task', trigger_id: 'T', trigger_seq: 5 }];
  assert.deepStrictEqual(await call([]), [], 'in flight');
  steps = [built('T'), { ...steps[1], outcome: 'done', row_ref: 'lease:l1' }];
  assert.deepStrictEqual(await call([]), [], 'done: dropped');
  assert.deepStrictEqual(seen.relaunched, [{ worker_id: 'b1', task_ids: ['T'] }]);
  assert.strictEqual(seen.deathHeld.size, 0);
  // not done: sent
  steps = [built('T')]; seen.relaunched = [];
  const ev2 = { ...ev, seq: 12, life: 'p:2' };
  assert.deepStrictEqual(await call([ev2]), [], 'held again (a fresh task row would be a fresh claim)');
  steps = [built('T'), { seq: 3, run_id: 'r', step: 'relaunch', task_id: 'T', outcome: 'skipped', error: 'relaunch refused: x', worker_id: 'b1', trigger_table: 'task', trigger_id: 'T', trigger_seq: 5 }];
  assert.deepStrictEqual(await call([]), [ev2], 'the relaunch did not work: the wake goes');
  // too slow: sent
  steps = [built('T')];
  const ev3 = { ...ev, seq: 15, life: 'p:3' };
  assert.deepStrictEqual(await call([ev3]), []);
  clock += RL.HOLD_MAX_MS;
  assert.deepStrictEqual(await call([]), [ev3], 'no step within the bound: the wake goes');
});

test('holdDeaths: a death the plan cannot relaunch passes straight through', async () => {
  const mk = (t, steps) => {
    const byId = new Map([[t.id, t]]);
    const ev = { event: 'death', worker_id: 'b1', turn: 1, seq: 9, life: 'p:1' };
    return RL.holdDeaths({ core: { policy: { list: async () => ({ rows: steps }) } }, runId: 'r', events: [ev], seen: { policyArmed: true }, tasks: [t], byId, polOf: (x) => PW.policyOf(x, byId), rootOf: (x) => PW.rootOf(x, byId) }).then((out) => out.length === 1 && out[0] === ev);
  };
  assert.ok(await mk(task('T'), []), 'no build step: the orchestrator\'s own assignment');
  assert.ok(await mk(task('T', { state: 'assigned', lease: { holder: 'b1', expired: false } }), [built('T')]), 'the task is still leased');
  assert.ok(await mk(task('T'), [built('T'), { ...built('T'), seq: 2, step: 'relaunch', outcome: 'done', trigger_seq: 3 }]), 'the one relaunch is used');
  assert.ok(await mk(task('T', { policy: { review: { worker: 'r' } } }), [built('T')]), 'a plan with no build step');
});
