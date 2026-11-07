'use strict';
require('../helpers/tmp.cjs');
// policy-relaunch.test.cjs — a dead builder is relaunched once by the plan, and the orchestrator is woken (E4) only if that did not work
// (ADR 0074 amendment 9). The executor over the REAL core; the wake side over the rows a poll reads.

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
const relStep = (seq, outcome, extra = {}) => ({ seq, run_id: 'r', step: 'relaunch', task_id: 'T', outcome, worker_id: 'b1', trigger_table: 'task', trigger_id: 'T', trigger_seq: 5, ...extra });
const leased = () => task('T', { state: 'assigned', lease: { holder: 'b1', expired: false } });
const D = require('../../src/run/run-digest.cjs');
const KM = require('../../src/core/kill-mark.cjs');
const tmpDir = () => require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'belay-rl-')).split('\\').join('/');
function wakeSide(initialSteps) {
  const byId = new Map([['T', task('T')]]);
  const w = { steps: initialSteps, clock: 1000, byId, seen: { policyArmed: true }, dataDir: tmpDir() };
  w.call = (events) => RL.holdDeaths({ core: { policy: { list: async () => ({ rows: w.steps.slice() }) } }, runId: 'r', events, seen: w.seen, tasks: [...byId.values()], byId, polOf: (t) => PW.policyOf(t, byId), rootOf: (t) => PW.rootOf(t, byId), workers: [{ id: 'b1', pid: 4242 }], dataDir: w.dataDir, now: () => w.clock });
  w.isClaimed = (ev) => D.isClaimed({ dataDir: w.dataDir, runId: 'r', uid: D.wakeUid(ev) });
  return w;
}
const death = (extra = {}) => ({ event: 'death', worker_id: 'b1', turn: 1, seq: 9, life: '4242:1', ...extra });

test('holdDeaths: a death the plan will relaunch waits, is dropped and claimed when the relaunch is done, and is sent when it is not or takes too long', async () => {
  const w = wakeSide([built('T')]);
  const ev = death();
  assert.deepStrictEqual(await w.call([ev]), [], 'held: the orchestrator is not woken yet');
  assert.deepStrictEqual(await w.call([]), [], 'still waiting for the step');
  w.steps = [built('T'), relStep(2, 'started')];
  assert.deepStrictEqual(await w.call([]), [], 'in flight');
  w.byId.set('T', task('T', { seq: 8 })); // an unrelated write to the task row between the death and the claim changes nothing
  w.steps = [built('T'), relStep(2, 'started', { trigger_seq: 8 })];
  assert.deepStrictEqual(await w.call([]), [], 'still in flight');
  w.byId.set('T', leased()); w.steps = [built('T'), relStep(2, 'done', { trigger_seq: 8, row_ref: 'lease:l1' })];
  assert.deepStrictEqual(await w.call([]), [], 'done: dropped');
  assert.strictEqual(w.seen.deathHeld.size, 0);
  assert.ok(w.isClaimed(ev), 'and claimed, so a later worker_wait does not return it');
  const w2 = wakeSide([built('T')]);
  const ev2 = death({ seq: 12, life: '4242:2' });
  assert.deepStrictEqual(await w2.call([ev2]), []);
  w2.steps = [built('T'), relStep(3, 'skipped', { error: 'relaunch refused: x' })];
  assert.deepStrictEqual(await w2.call([]), [ev2], 'the relaunch did not work: the wake goes');
  const w3 = wakeSide([built('T')]);
  const ev3 = death({ seq: 15, life: '4242:3' });
  assert.deepStrictEqual(await w3.call([ev3]), []);
  w3.clock += RL.HOLD_MAX_MS;
  assert.deepStrictEqual(await w3.call([]), [ev3], 'no step within the bound: the wake goes');
});

test('holdDeaths: a claim the executor reopens (a pause, a moved plan) is a wait, not a failed relaunch', async () => {
  const w = wakeSide([built('T')]);
  assert.deepStrictEqual(await w.call([death()]), []);
  w.steps = [built('T'), relStep(2, 'skipped', { error: 'E_PAUSED: the run is paused; the claim is reopened and the step retaken after the resume' })];
  assert.deepStrictEqual(await w.call([]), [], 'the retake follows the resume');
  w.steps = [built('T'), relStep(2, 'skipped', { error: 'E_NOT_NOW: the plan moved' })];
  assert.deepStrictEqual(await w.call([]), []);
});

test('holdDeaths: an operator kill, a second death, and a death the plan cannot relaunch pass straight through', async () => {
  const w = wakeSide([built('T')]);
  assert.ok(KM.mark(w.dataDir, 'b1', 4242));
  const ev = death();
  assert.deepStrictEqual(await w.call([ev]), [ev], 'a human killed it: the orchestrator is told, nothing is undone');
  assert.strictEqual(KM.isKilled(w.dataDir, 'b1', 9999), false, 'another life of the same id is not covered');
  const passes = async (setup, steps) => {
    const x = wakeSide(steps); setup(x.byId);
    const e = death();
    const out = await x.call([e]);
    return out.length === 1 && out[0] === e;
  };
  assert.ok(await passes(() => {}, []), 'no build step: the orchestrator assigned it');
  assert.ok(await passes(() => {}, [built('T'), relStep(2, 'done')]), 'the one relaunch is used: this is the second death');
  assert.ok(await passes((m) => m.set('T', task('T', { policy: { review: { worker: 'r' } } })), [built('T')]), 'a plan with no build step');
  assert.ok(await passes((m) => m.set('T', leased()), [built('T')]), 'a task held by someone: nothing to relaunch');
});

test('the run wait does not return a death a relaunch is handling, and claims it once the relaunch is done', async () => {
  const { createRunWait } = require('../../src/run/run-wait.cjs');
  const dataDir = tmpDir();
  let tasks = [task('T')]; let steps = [built('T')];
  const core = { task: { list: async () => ({ tasks }) }, policy: { list: async () => ({ rows: steps.slice() }) }, integration: { list: async () => ({ integrations: [] }) } };
  const clock = { t: 0, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } };
  const rw = createRunWait({ core, runId: 'r', dataDir, claimant: { pid: process.pid, created: 'x' }, watcher: { poll: async () => [] }, pollMs: 10, clock });
  const dead1 = [{ id: 'b1', settled: true, state: 'dead', pid: 4242, pidCreated: '1', exitCode: 1, turns: 1, deathEstablishedBy: 'exit' }];
  const first = await rw.wait({ ms: 50, t0: 0, workers: dead1 });
  assert.strictEqual(first.event, null, `a relaunch is due: the death is not told ${JSON.stringify(first)}`);
  tasks = [task('T', { state: 'assigned', lease: { holder: 'b1', expired: false } })]; steps = [built('T'), relStep(2, 'done')];
  const second = await rw.wait({ ms: 50, t0: clock.t, workers: dead1 });
  assert.strictEqual(second.event, null, 'the relaunch is done: still not told');
  tasks = [task('T', { state: 'done' })];
  const third = await rw.wait({ ms: 50, t0: clock.t, workers: dead1 });
  assert.strictEqual(third.event, null, 'claimed when it was handled: not told later either, even when the task has moved on');
  assert.ok(D.isClaimed({ dataDir, runId: 'r', uid: D.deathUid('b1', 'death', D.lifeOf(4242, '1')) }));
});

test('a restart that leaves the task with someone else stops the restarted worker, and says so', async () => {
  const stopped = [];
  let n = 0;
  const get = async () => (n++ === 0 ? { id: 'T', state: 'open', lease: null } : { id: 'T', state: 'assigned', lease: { id: 'l9', holder: 'someone-else' } });
  const env = {
    core: { task: { get }, worker: { list: async () => ({ workers: [{ id: 'b1', state: 'dead', pid: 4242 }] }) } },
    restart: async () => {}, stop: async (id) => { stopped.push(id); },
    assign: async () => { throw Object.assign(new Error('held by someone else'), { code: 'E_LEASED' }); },
  };
  const out = await RL.run({ task_id: 'T', worker: 'b1', build: { worker: 'b1' } }, env);
  assert.strictEqual(out.outcome, 'skipped');
  assert.deepStrictEqual(stopped, ['b1'], 'the worker with no task is not left running in the tree');
  assert.match(out.error, /held by someone-else.*b1 was stopped/);
});

test('a budget refusal ends the relaunch skipped, not an exception', async () => {
  const e = await env('relaunch-budget');
  try {
    const t = await builtThenDead(e);
    await require('./policy-review-env.cjs').budgeted(e, 10);
    const out = await e.exec({ restartWorker: async () => { throw new Error('must not be reached'); } }).tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['relaunch', 'skipped']]);
    assert.match(stepRows(e)[1].error, /budget/i);
    assert.deepStrictEqual((await wakesOf(e)).map((w) => w.exception), [], `no E8 for ${t.id}`);
  } finally { await e.close(); }
});

test('a worker an operator killed is not relaunched: the mark stops the step, and the death stays the orchestrator\'s', async () => {
  const e = await env('relaunch-killed');
  try {
    const t = await e.orch.task.create({ spec: 'write b.txt', acceptance: PASS, policy: { build: { worker: 'b1' }, ...REST } });
    await e.worker('b1');
    await e.exec().tick();
    const dd = `${e.dir}/data`;
    const pid = deadPid();
    await e.orch.worker.write({ id: 'b1', state: 'dead', pid, exit_code: 1, death_established_by: 'exit-event' });
    KM.mark(dd, 'b1', pid);
    const calls = [];
    const out = await e.exec({ dataDir: dd, restartWorker: restarter(e, t.id, calls) }).tick();
    assert.deepStrictEqual(out.steps.filter((s) => s.step === 'relaunch'), []);
    assert.deepStrictEqual(calls, []);
  } finally { await e.close(); }
});

test('a held death holds the headless idle close, and the stall notice, so a crashed builder is neither named as unassigned nor closed under a due relaunch', async () => {
  const { idleClose } = require('../../src/run/orchestrator-idle-close.cjs');
  const wrote = []; let stallAsked = 0; let closed = null; const holds = [];
  const state = { pendingWrites: [], evalSeen: new Map(), finishing: false, idle: true, wakesSuppressed: [] };
  state.evalSeen.deathHeld = new Map([['b1:4242:1', { ev: death(), since: 1 }]]);
  const out = await idleClose({
    state, rows: [], runId: 'r', pending_deaths: [], turnAtCall: 1, hold: { isPaused: () => false }, awaitingWakeIds: () => [],
    callWatcher: { holds: () => [] }, preClose: { check: async () => ({ ran: false }) }, recordHold: (...a) => holds.push(a), writeWake: (e) => wrote.push(e),
    closeThenKillOnDeadline: (why) => { closed = why; }, stall: { atClose: async () => { stallAsked += 1; return { event: 'stalled', worker_id: 'stall:r', turn: 0, text: 'belay: open tasks nobody is assigned: T.', task_ids: ['T'] }; } },
  });
  assert.strictEqual(out, false);
  assert.strictEqual(stallAsked, 0, 'the stall notice is not asked for');
  assert.deepStrictEqual([wrote.length, closed], [0, null], 'nothing written, nothing closed');
  assert.ok(holds.length === 1 && JSON.stringify(holds[0]).includes('relaunch:b1:4242:1'), `the hold is named: ${JSON.stringify(holds)}`);
});

test('the kill mark matches the process by pid and creation time, reports a failed write, and goes with the row', () => {
  const dir = tmpDir();
  assert.strictEqual(KM.mark(dir, 'b1', 7, '100'), true);
  assert.strictEqual(KM.isKilled(dir, 'b1', 7, '100'), true);
  assert.strictEqual(KM.isKilled(dir, 'b1', 7, '101'), false, 'the same pid reused by a later process is not the killed one');
  assert.strictEqual(KM.isKilled(dir, 'b1', 7), false);
  assert.strictEqual(KM.clear(dir, 'b1'), true);
  assert.strictEqual(KM.isKilled(dir, 'b1', 7, '100'), false);
  const blocker = `${dir}/file`; require('node:fs').writeFileSync(blocker, 'x');
  assert.strictEqual(KM.mark(blocker, 'b1', 7, '100'), false, 'a write that cannot be made says so (the kill receipt carries mark_written: false)');
});

test('the run wait ends its hold after the same bound as the wake, and a death already reported to the orchestrator is not relaunched', async () => {
  const { createRunWait } = require('../../src/run/run-wait.cjs');
  const dataDir = tmpDir();
  const core = { task: { list: async () => ({ tasks: [task('T')] }) }, policy: { list: async () => ({ rows: [built('T')] }) }, integration: { list: async () => ({ integrations: [] }) } };
  const clock = { t: 0, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } };
  const rw = createRunWait({ core, runId: 'r', dataDir, claimant: { pid: process.pid, created: 'x' }, watcher: { poll: async () => [] }, pollMs: 10, clock });
  const dead1 = [{ id: 'b1', settled: true, state: 'dead', pid: 4242, pidCreated: '1', exitCode: 1, turns: 1, deathEstablishedBy: 'exit' }];
  assert.strictEqual((await rw.wait({ ms: 50, t0: 0, workers: dead1 })).event, null, 'held');
  clock.t += RL.HOLD_MAX_MS;
  const later = await rw.wait({ ms: 50, t0: clock.t, workers: dead1 });
  assert.strictEqual(later.event, 'exception', 'past the bound the death is told');
  // The step: its death was told, so the plan does not restart the worker under the orchestrator.
  const uid = D.deathUid('b1', 'death', D.lifeOf(4242, '1'));
  assert.ok(D.isClaimed({ dataDir, runId: 'r', uid }));
  let restarted = 0;
  const env = { runId: 'r', dataDir, restart: async () => { restarted += 1; }, core: { task: { get: async () => ({ id: 'T', state: 'open', lease: null }) }, worker: { list: async () => ({ workers: [{ id: 'b1', state: 'dead', pid: 4242, pid_created: '1' }] }) } } };
  const out = await RL.run({ task_id: 'T', worker: 'b1', build: { worker: 'b1' } }, env);
  assert.strictEqual(out.outcome, 'skipped');
  assert.match(out.error, /already reported/);
  assert.strictEqual(restarted, 0);
});

test('a coder the relaunch spawned in the dead builder\'s place is stopped once its work is cancelled or merged', async () => {
  const { makeRepo } = require('../core/worktree-helpers.cjs');
  const e = await env('relaunch-retire');
  try {
    const repo = makeRepo(e.dir);
    const t = await e.orch.task.create({ spec: 'write c.txt', acceptance: PASS, policy: { build: { spawn: { agent_type: 'coder' } } } });
    await e.op.task.worktreeCreate({ task_id: t.id, repo });
    const spawned = []; const stopped = [];
    const spawnFor = () => async (a) => { spawned.push(a.worker_id); await e.worker(a.worker_id, a.worktree); await e.orch.task.assign({ task_id: a.task_id, worker_id: a.worker_id }); return { id: a.worker_id }; };
    const x = e.exec({ spawnFor, stopWorker: async (id) => { stopped.push(id); } });
    const b = await x.tick();
    assert.deepStrictEqual(b.steps.map((s) => [s.step, s.outcome]), [['build', 'done']], JSON.stringify(stepRows(e).map((r) => r.error)));
    const first = spawned[0];
    await die(e, first);
    const out = await x.tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['relaunch', 'done']], 'no restart path in this run: a fresh coder in the same tree');
    assert.strictEqual(spawned.length, 2);
    const fresh = spawned[1];
    assert.deepStrictEqual(stopped.filter((id) => id === fresh), [], 'not while its work stands');
    await e.orch.task.cancel({ task_id: t.id });
    await x.tick();
    assert.ok(stopped.includes(fresh), `retired: ${JSON.stringify(stopped)}`);
  } finally { await e.close(); }
});

// R4: the fix tasks the round steps make are the plan's builders' work too.
const fixTask = (id, extra = {}) => task(id, { repairs: 'T', depends_on: ['T'], policy: null, policy_made: true, ...extra });
const fixStep = (step, id, worker = 'b1', seq = 3) => ({ seq, run_id: 'r', step, task_id: 'T', outcome: 'done', worker_id: worker, row_ref: `task:${id}`, trigger_table: 'integration', trigger_id: 'i1', trigger_seq: 1 });
for (const name of ['fix', 'fix_conflict', 'fix_checks', 'fix_commit']) {
  test(`due: a fix task the ${name} step made is relaunched when its builder dies, and the bound still holds`, () => {
    const tasks = [task('T', { state: 'done' }), fixTask('F')];
    const base = { runId: 'r', tasks, steps: [built('T'), fixStep(name, 'F')], workers: [dead()] };
    assert.deepStrictEqual(due(base).filter((c) => c.step === 'relaunch').map((c) => [c.task_id, c.worker, c.role]), [['F', 'b1', 'build']]);
    assert.deepStrictEqual(due({ ...base, steps: [...base.steps, { ...built('F'), seq: 9, step: 'relaunch', task_id: 'F', outcome: 'done', trigger_seq: 5 }] }).filter((c) => c.step === 'relaunch'), [], 'one relaunch a task');
    assert.deepStrictEqual(due({ ...base, steps: [fixStep(name, 'F')] }).filter((c) => c.step === 'relaunch'), [], 'the work the plan did not build');
  });
}

// R3: the reviewer a review step gave a review task.
const reviewTask = (extra = {}) => ({ id: 'R', run_id: 'r', state: 'open', lease: null, seq: 7, depends_on: ['T'], repairs: null, policy: null, policy_made: true, acceptance: { verdict: true }, ...extra });
const reviewStep = (step = 'review', worker = 'rv1') => ({ seq: 4, run_id: 'r', step, task_id: 'T', outcome: 'done', worker_id: worker, row_ref: 'task:R', trigger_table: 'task', trigger_id: 'T', trigger_seq: 5 });
const workDoneTask = () => task('T', { state: 'done', policy: { build: { worker: 'b1' }, review: { spawn: { agent_type: 'reviewer' } } } });

test('due: a dead reviewer of a plan-made review is relaunched once; a live one, a used bound, an unplanned review and an operator kill are not', () => {
  for (const step of ['review', 're_review']) {
    const base = { runId: 'r', tasks: [workDoneTask(), reviewTask()], steps: [built('T'), reviewStep(step)], workers: [dead('rv1')] };
    assert.deepStrictEqual(due(base).filter((c) => c.step === 'relaunch').map((c) => [c.task_id, c.worker, c.role, c.tree_task]), [['R', 'rv1', 'review', 'T']], step);
    assert.deepStrictEqual(due({ ...base, workers: [{ id: 'rv1', state: 'running' }] }).filter((c) => c.step === 'relaunch'), []);
    assert.deepStrictEqual(due({ ...base, steps: [built('T'), reviewStep(step), { ...built('R'), seq: 9, step: 'relaunch', task_id: 'R', outcome: 'skipped', error: 'relaunch refused: x', trigger_seq: 7 }] }).filter((c) => c.step === 'relaunch'), [], 'the bound');
    assert.deepStrictEqual(due({ ...base, steps: [built('T')] }).filter((c) => c.step === 'relaunch'), [], 'a review the orchestrator made and assigned');
    assert.deepStrictEqual(due({ ...base, isKilled: () => true }).filter((c) => c.step === 'relaunch'), [], 'an operator killed it');
  }
});

test('a dead reviewer\'s death waits for its relaunch, like a builder\'s; the step falls back to a fresh reviewer in the work\'s tree', async () => {
  const w = wakeSide([built('T'), reviewStep()]);
  w.byId.set('T', workDoneTask()); w.byId.set('R', reviewTask());
  assert.deepStrictEqual(await w.call([death({ worker_id: 'rv1' })]), [], 'held');
  const spawned = []; const asked = [];
  let n = 0;
  const get = async ({ task_id }) => (task_id === 'T' ? { id: 'T', worktree: { path: 'C:/trees/T' } } : (n++ < 1 ? { id: 'R', state: 'open', lease: null } : { id: 'R', state: 'assigned', lease: { id: 'l2', holder: spawned[0] } }));
  const env = {
    runId: 'r', core: { task: { get }, worker: { list: async () => ({ workers: [{ id: 'rv1', state: 'dead', pid: 1 }] }) } },
    spawn: async (a) => { spawned.push(a.worker_id); asked.push(a); return { id: a.worker_id }; },
  };
  const out = await RL.run({ task_id: 'R', worker: 'rv1', role: 'review', tree_task: 'T', cfg: { spawn: { agent_type: 'reviewer' } } }, env);
  assert.strictEqual(out.outcome, 'done');
  assert.match(asked[0].worker_id, /^rev-/);
  assert.deepStrictEqual([asked[0].worktree, asked[0].task_id, asked[0].agent_type], ['C:/trees/T', 'R', 'reviewer']);
  assert.strictEqual(out.spawned, spawned[0]);
});
