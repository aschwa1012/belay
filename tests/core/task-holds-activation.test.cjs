'use strict';
// task-holds-activation.test.cjs — every path that makes a task worked holds its files for the run that will own the work,
// or refuses (ADR 0046 decision 1): a task moved to another run is a new claim with no priority, the move happens even when
// the task's own run is live, and a worker launched again is checked with task.ensureHold before any process starts.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir;
const cores = [];
const open = async (runId, role = 'orchestrator') => {
  const c = await openCore({ dataDir: dir, caller: callerFor(role, { run_id: runId }), embed: false });
  cores.push(c);
  return c;
};
const live = async (runId) => { const c = await open(runId); await c.run.attach({ adapter_pid: process.pid }); return c; };
const worker = (c, id) => c.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
const code = (want) => (e) => { assert.strictEqual(e.code, want, e.message); return true; };
const holdsOf = async (c, id) => { const t = await c.task.get({ task_id: id }); return [t.holds_files, t.holds_reason, t.run_id]; };

before(async () => { dir = sandbox(); });
after(async () => {
  for (const c of cores.slice(1)) await c.close();
  await cores[0].shutdownOwner();
  await cores[0].close();
  cleanup(dir);
});

test('moving an ended run\'s task to a live run\'s worker gets no priority from that run being older than the run now holding the paths', async () => {
  const b = await live('act1-b'); // live first: older than c below
  const a = await live('act1-a');
  const t = await a.task.create({ spec: 'old', files_owned: ['act1/x.js'] });
  await a.run.end({ exit_reason: 'test' });
  const c = await live('act1-c');
  const mine = await c.task.create({ spec: 'took it', files_owned: ['act1/x.js'] });
  await worker(b, 'w-act1');
  const op = await open('cli', 'operator');
  const before = await op.task.get({ task_id: t.id });
  await assert.rejects(op.task.assign({ task_id: t.id, worker_id: 'w-act1' }), (e) => { code('E_FILES_OVERLAP')(e); assert.strictEqual(e.detail.other_task_id, mine.id); return true; });
  await assert.rejects(b.task.assign({ task_id: t.id, check_only: true }), code('E_FILES_OVERLAP'));
  assert.deepStrictEqual(await op.task.get({ task_id: t.id }), before, 'a refused assign wrote nothing');
  assert.deepStrictEqual(await holdsOf(op, mine.id), [true, 'live', 'act1-c']);
});

test('a live run\'s task assigned to another live run\'s worker moves to that run, so ending the first run does not free its files', async () => {
  const a = await live('act2-a');
  const b = await live('act2-b');
  const t = await a.task.create({ spec: 'x', files_owned: ['act2/x.js'] });
  await worker(b, 'w-act2');
  const op = await open('cli', 'operator');
  const r = await op.task.assign({ task_id: t.id, worker_id: 'w-act2' });
  assert.strictEqual(r.task.run_id, 'act2-b');
  assert.strictEqual(r.new_lease.run_id, 'act2-b');
  await a.run.end({ exit_reason: 'test' });
  assert.deepStrictEqual(await holdsOf(op, t.id), [true, 'live', 'act2-b']);
  await assert.rejects(b.task.create({ spec: 'clash', files_owned: ['act2/x.js'] }), code('E_FILES_OVERLAP'));
});

test('a live run\'s task is not assigned to a worker whose own run is not live, and nothing is written', async () => {
  const a = await live('act3-a');
  const dead = await live('act3-dead');
  await worker(dead, 'w-act3');
  await dead.run.end({ exit_reason: 'test' });
  const t = await a.task.create({ spec: 'x', files_owned: ['act3/x.js'] });
  const op = await open('cli', 'operator');
  const before = await op.task.get({ task_id: t.id });
  await assert.rejects(op.task.assign({ task_id: t.id, worker_id: 'w-act3' }), code('E_RUN_NOT_LIVE'));
  assert.deepStrictEqual(await op.task.get({ task_id: t.id }), before);
});

test('a task that owns no files stays in its own run when a live run\'s worker takes it', async () => {
  const a = await live('act4-a');
  const b = await live('act4-b');
  const t = await a.task.create({ spec: 'nofiles' });
  await worker(b, 'w-act4');
  const op = await open('cli', 'operator');
  assert.strictEqual((await op.task.assign({ task_id: t.id, worker_id: 'w-act4' })).task.run_id, 'act4-a');
});

// task.ensureHold: what a run manager asks before it relaunches a worker, an adopted one most of all.
const parked = async (tag) => {
  const a = await live(`ens-${tag}-a`);
  await worker(a, `w-ens-${tag}`);
  const t = await a.task.create({ spec: 'x', files_owned: [`ens/${tag}/x.js`] });
  await a.task.assign({ task_id: t.id, worker_id: `w-ens-${tag}` });
  await a.run.end({ exit_reason: 'test' });
  return t;
};

test('ensureHold refuses an adopted worker whose ended run\'s task overlaps a task another run took meanwhile, and writes nothing', async () => {
  const t = await parked('clash');
  const b = await live('ens-clash-b');
  const mine = await b.task.create({ spec: 'took it', files_owned: ['ens/clash/x.js'] });
  const before = await b.task.get({ task_id: t.id });
  assert.deepStrictEqual(await holdsOf(b, t.id), [false, 'run_ended', 'ens-clash-a']);
  await assert.rejects(b.task.ensureHold({ task_id: t.id, worker_id: 'w-ens-clash' }), (e) => { code('E_FILES_OVERLAP')(e); assert.strictEqual(e.detail.other_task_id, mine.id); return true; });
  assert.deepStrictEqual(await b.task.get({ task_id: t.id }), before);
});

test('ensureHold moves the ended run\'s task and its lease to the manager\'s live run, once, and the paths are then held', async () => {
  const t = await parked('move');
  const b = await live('ens-move-b');
  const r = await b.task.ensureHold({ task_id: t.id, worker_id: 'w-ens-move' });
  assert.strictEqual(r.rehomed, true);
  assert.strictEqual(r.task.run_id, 'ens-move-b');
  assert.strictEqual(r.new_lease.run_id, 'ens-move-b');
  assert.strictEqual(r.new_lease.holder, 'w-ens-move');
  assert.deepStrictEqual(await holdsOf(b, t.id), [true, 'live', 'ens-move-b']);
  await assert.rejects(b.task.create({ spec: 'clash', files_owned: ['ens/move/x.js'] }), code('E_FILES_OVERLAP'));
  const seq = (await b.task.get({ task_id: t.id })).seq;
  const again = await b.task.ensureHold({ task_id: t.id, worker_id: 'w-ens-move' });
  assert.deepStrictEqual([again.held, again.rehomed, again.reason], [true, false, 'live']);
  assert.strictEqual((await b.task.get({ task_id: t.id })).seq, seq, 'a task already held writes nothing');
});

test('ensureHold writes nothing for a task not leased to the worker and a task owning no files, and says why', async () => {
  const a = await live('ens-skip-a');
  await worker(a, 'w-ens-skip');
  const open1 = await a.task.create({ spec: 'unassigned', files_owned: ['ens/skip/x.js'] });
  const nofiles = await a.task.create({ spec: 'nofiles' });
  const ask = (id) => a.task.ensureHold({ task_id: id, worker_id: 'w-ens-skip' });
  const r1 = await ask(open1.id);
  assert.deepStrictEqual([r1.held, r1.reason], [false, 'not_leased_to_worker']);
  assert.strictEqual((await ask(nofiles.id)).reason, 'no_files');
  await assert.rejects(a.task.ensureHold({ task_id: 'no-such-task', worker_id: 'w-ens-skip' }), code('E_NOT_FOUND'));
  await assert.rejects(a.task.ensureHold({ task_id: open1.id }), code('E_ARGS'));
});
