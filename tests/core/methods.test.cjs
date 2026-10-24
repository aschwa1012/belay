'use strict';
// methods.test.cjs — Core run and worker methods: row shapes and refusal codes (api.md §3, §6); task, lease and memory live in methods-task-lease and methods-memory.
// The orchestrator core elects an owner in-process; the worker and operator cores in the same test
// reach it over the pipe, so each method is exercised on both dispatch paths.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor, deadPid } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const { teardown } = require('../helpers/teardown.cjs');

let dir, orch, worker, operator, wid = 'w1';

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  await orch.worker.write({ id: wid, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-1', last_event_at: Date.now() });
  worker = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: wid }), embed: false });
  operator = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
});

after(async () => {
  // Every step runs even if an earlier one fails (a before hook that failed part-way leaves some unset); the first failure is thrown.
  await teardown(null, [
    () => worker && worker.close(),
    () => operator && operator.close(),
    () => orch && orch.shutdownOwner(),
    () => orch && orch.close(),
    () => cleanup(dir),
  ]);
});

const rejects = async (p, code) => {
  await assert.rejects(p, e => {
    assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    assert.ok(e.message.length > 10, 'the message must name the reason, not be a status word');
    return true;
  });
};

// ---- run -------------------------------------------------------------------
test('run.attach returns a row, an epoch and a reattach fact', async () => {
  const r = await orch.run.get({});
  assert.strictEqual(r.run.id, 'test-run');
  assert.strictEqual(r.run.epoch, 1);
  assert.strictEqual(r.run.adapter_pid, process.pid);
  assert.ok(Number.isInteger(r.run.seq));
  assert.strictEqual(r.run.written_by, 'orchestrator');
  assert.strictEqual(r.epochs.length, 1);
});

test('run.attach a second time raises the epoch, names the previous row and marks dead workers', async () => {
  const dead = deadPid();
  await orch.worker.write({ id: 'w-dead', substrate: 'codex', pid: dead, state: 'starting' });
  // A Codex worker between turns is `idle` with a pid that is gone by design (api.md §2). Across a new
  // epoch that is not a resting worker, it is a worker with no process and no adapter, and skipping it
  // here was the one way a row could claim a life for ever without a pid to back it.
  await orch.worker.write({ id: 'w-idle', substrate: 'codex', pid: deadPid(), state: 'idle' });
  const r = await orch.run.attach({ adapter_pid: process.pid });
  assert.strictEqual(r.reattached, true);
  assert.strictEqual(r.epoch, 2);
  assert.strictEqual(r.previous.epoch, 1);
  assert.deepStrictEqual(r.workers_marked_dead, ['w-dead', 'w-idle']);
  assert.strictEqual((await orch.worker.get({ worker_id: 'w-dead' })).state, 'dead');
  const wasIdle = await orch.worker.get({ worker_id: 'w-idle' });
  assert.strictEqual(wasIdle.state, 'dead');
  assert.ok(wasIdle.exited_at, 'the row that says dead also says when, derived from the attach');
  assert.strictEqual((await orch.worker.list({ states: ['idle'] })).workers.length, 0);
  assert.strictEqual((await orch.run.get({})).epochs.length, 2);
});

test('run.attach without an adapter_pid is refused', () => rejects(orch.run.attach({}), 'E_ARGS'));
test('run.end needs a reason', () => rejects(orch.run.end({}), 'E_ARGS'));

// ---- worker ----------------------------------------------------------------
test('worker.write appends: a second write for one id makes a second row and get returns the highest seq', async () => {
  const first = await orch.worker.get({ worker_id: wid });
  const second = await orch.worker.write({ id: wid, turns: 7, input_tokens: 100 });
  assert.ok(second.seq > first.seq, 'the second write must produce a higher seq, never an update');
  assert.strictEqual(second.state, 'running', 'an absent field inherits from the current row');
  assert.strictEqual(second.turns, 7);
  const now = await orch.worker.get({ worker_id: wid });
  assert.strictEqual(now.seq, second.seq);
  assert.strictEqual(now.pid_alive, true);
  assert.ok(typeof now.last_event_age_ms === 'number');
});

test('worker.write refuses running with a pid that is not alive', () =>
  rejects(orch.worker.write({ id: 'w-ghost', substrate: 'codex', pid: deadPid(), state: 'running' }), 'E_WORKER_NOT_LIVE'));

test('worker.write refuses a state outside the enum', () =>
  rejects(orch.worker.write({ id: 'w-bad', state: 'busy' }), 'E_ARGS'));

test('worker.get on an unknown id is E_NOT_FOUND', () => rejects(orch.worker.get({ worker_id: 'nope' }), 'E_NOT_FOUND'));

test('worker.list filters by state and carries derived liveness', async () => {
  // The worker role reaches this over the pipe, the orchestrator in-process: both must agree.
  const r = await worker.worker.list({ states: ['running'] });
  assert.ok(r.workers.every(w => w.state === 'running'));
  assert.ok(r.workers.some(w => w.id === wid));
  assert.strictEqual(r.workers.find(w => w.id === wid).pid_alive, true);
  const mine = await orch.worker.list({});
  assert.ok(mine.workers.length > r.workers.length, 'an unfiltered list includes the states the filter dropped');
});

test('a row written back to running or starting carries no exit fields from its previous life', async () => {
  await orch.worker.write({ id: 'w-recycled', substrate: 'codex', pid: process.pid, state: 'dead', exited_at: 111, exit_code: 7, exit_signal: 'SIGKILL' });
  const live = await orch.worker.write({ id: 'w-recycled', state: 'running', pid: process.pid });
  assert.strictEqual(live.state, 'running');
  assert.strictEqual(live.exited_at, null, 'a running row cannot also claim to have exited');
  assert.strictEqual(live.exit_code, null);
  assert.strictEqual(live.exit_signal, null);
  // The dead row is still in history: superseding is not rewriting.
  const dead = await orch.worker.write({ id: 'w-recycled', state: 'dead', exited_at: 222, exit_code: 0 });
  assert.strictEqual(dead.exited_at, 222);
  // api.md §3 names `starting` beside `running` here. It makes the same claim about a life, and clears
  // the same three fields; unlike `running` it claims nothing about a pid, so a dead one is allowed.
  const restarting = await orch.worker.write({ id: 'w-recycled', state: 'starting', pid: deadPid() });
  assert.strictEqual(restarting.exited_at, null, 'a starting row cannot also claim to have exited');
  assert.strictEqual(restarting.exit_code, null);
  assert.strictEqual(restarting.exit_signal, null);
});

test('worker.write inherits what a call leaves out and clears what it passes as null', async () => {
  const first = await orch.worker.write({ id: 'w-merge', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-merge', task_id: 't-merge', worktree: 'wt' });
  const inherited = await orch.worker.write({ id: 'w-merge', turns: 2 });
  assert.ok(inherited.seq > first.seq);
  assert.strictEqual(inherited.state, 'running', 'an absent field inherits from the current row');
  assert.strictEqual(inherited.session_id, 's-merge');
  assert.strictEqual(inherited.task_id, 't-merge');
  assert.strictEqual(inherited.worktree, 'wt');
  assert.strictEqual(inherited.turns, 2);
  const cleared = await orch.worker.write({ id: 'w-merge', task_id: null });
  assert.strictEqual(cleared.task_id, null, 'an explicit null clears the field');
  assert.strictEqual(cleared.session_id, 's-merge', 'and clears nothing else');
  assert.strictEqual(cleared.turns, 2);
});
