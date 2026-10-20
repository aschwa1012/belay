'use strict';
// task-holds.test.cjs — a task holds its files only while its run is live (ADR 0046 decisions 1 and 4; audit D08).
// Two runs share one store. Liveness is the run row: no ended_at and an adapter_pid that answers. A dead run is a
// planted dead adapter_pid (a child that already exited), never a real kill.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor, deadPid } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, a, b, cores = [];

const open = async (runId, role = 'orchestrator') => {
  const c = await openCore({ dataDir: dir, caller: callerFor(role, { run_id: runId }), embed: false });
  cores.push(c);
  return c;
};

before(async () => {
  dir = sandbox();
  a = await open('run-a');
  await a.run.attach({ adapter_pid: process.pid });
  b = await open('run-b');
  await b.run.attach({ adapter_pid: process.pid });
});

after(async () => {
  for (const c of cores.slice(1)) await c.close();
  await cores[0].shutdownOwner(); // the only way to stop an owner; never a signal
  await cores[0].close();
  cleanup(dir);
});

const overlapOf = (p) => assert.rejects(p, (e) => { assert.strictEqual(e.code, 'E_FILES_OVERLAP', e.message); return true; });
const holdsOf = async (core, id) => { const t = await core.task.get({ task_id: id }); return [t.holds_files, t.holds_reason]; };

test('another live run\'s unfinished task still holds its files, and the refusal names that run', async () => {
  const t = await b.task.create({ spec: 'live', files_owned: ['live/x'] });
  await assert.rejects(a.task.create({ spec: 'clash', files_owned: ['live/x/y.js'] }), (e) => {
    assert.strictEqual(e.code, 'E_FILES_OVERLAP');
    assert.strictEqual(e.detail.other_task_id, t.id);
    assert.strictEqual(e.detail.other_run_id, 'run-b');
    return true;
  });
  assert.deepStrictEqual(await holdsOf(a, t.id), [true, 'live']);
});

test('a task of a run with no run row still holds (drivers and tests that never attach)', async () => {
  const c = await open('run-norow');
  const t = await c.task.create({ spec: 'norow', files_owned: ['norow/x'] });
  await overlapOf(a.task.create({ spec: 'clash', files_owned: ['norow/x'] }));
  assert.deepStrictEqual(await holdsOf(a, t.id), [true, 'live']);
});

test('an ended run\'s open, assigned and released tasks stop holding, and the view says run_ended', async () => {
  const c = await open('run-ended');
  await c.run.attach({ adapter_pid: process.pid });
  await c.worker.write({ id: 'we', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
  const open1 = await c.task.create({ spec: 'open', files_owned: ['ended/open'] });
  const asg = await c.task.create({ spec: 'assigned', files_owned: ['ended/asg'] });
  const rel = await c.task.create({ spec: 'released', files_owned: ['ended/rel'] });
  await c.task.assign({ task_id: asg.id, worker_id: 'we' });
  const leaseId = (await c.task.assign({ task_id: rel.id, worker_id: 'we' })).new_lease.id;
  const w = await openCore({ dataDir: dir, caller: callerFor('worker', { run_id: 'run-ended', worker_id: 'we' }), embed: false });
  cores.push(w);
  await w.lease.release({ lease_id: leaseId });
  await overlapOf(a.task.create({ spec: 'clash', files_owned: ['ended/open'] })); // the run is still live
  await c.run.end({ exit_reason: 'test' });
  for (const [p, task] of [['ended/open', open1], ['ended/asg', asg], ['ended/rel', rel]]) {
    assert.deepStrictEqual(await holdsOf(a, task.id), [false, 'run_ended'], p);
    const n = await a.task.create({ spec: `again ${p}`, files_owned: [p] });
    assert.strictEqual(n.state, 'open', p);
  }
  const listed = (await a.task.list({})).tasks.find((t) => t.id === open1.id);
  assert.strictEqual(listed.holds_files, false);
  assert.strictEqual(listed.holds_reason, 'run_ended');
  assert.strictEqual((await a.task.get({ task_id: open1.id })).state, 'open', 'run.end wrote nothing to the task');
});

test('a run whose adapter pid is dead stops holding with no run.end, and the view says run_dead', async () => {
  const c = await open('run-dead');
  await c.run.attach({ adapter_pid: deadPid() });
  const t = await c.task.create({ spec: 'dead', files_owned: ['dead/x'] });
  assert.deepStrictEqual(await holdsOf(a, t.id), [false, 'run_dead']);
  const n = await a.task.create({ spec: 'takes it', files_owned: ['dead/x'] });
  assert.strictEqual(n.state, 'open');
});

test('a done task and a task owning no files hold nothing, and say why', async () => {
  const t = await a.task.create({ spec: 'nofiles' });
  assert.deepStrictEqual(await holdsOf(a, t.id), [false, 'no_files']);
  const d = await a.task.create({ spec: 'done', files_owned: ['done/x'], acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] } });
  assert.deepStrictEqual(await holdsOf(a, d.id), [true, 'live']);
  assert.strictEqual((await a.task.evaluate({ task_id: d.id, worktree: dir })).state, 'done');
  assert.deepStrictEqual(await holdsOf(a, d.id), [false, 'done']);
  assert.strictEqual((await b.task.create({ spec: 'reuse', files_owned: ['done/x'] })).state, 'open');
});

test('a re-attached run holds again: attach names the overlap and assign refuses it, check_only included', async () => {
  const c = await open('run-resume');
  await c.run.attach({ adapter_pid: process.pid });
  await c.worker.write({ id: 'wr', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
  const old = await c.task.create({ spec: 'old', files_owned: ['resume/x'] });
  await c.run.end({ exit_reason: 'test' });
  const mine = await a.task.create({ spec: 'took it meanwhile', files_owned: ['resume/x'] });
  const op = await open('run-resume', 'operator'); // only the run process (role operator) opens a new epoch over an ended run
  const r = await op.run.attach({ adapter_pid: process.pid });
  assert.deepStrictEqual(r.overlaps, [{ task_id: old.id, other_task_id: mine.id, files: ['resume/x'] }]);
  assert.deepStrictEqual(await holdsOf(c, old.id), [true, 'live']);
  await overlapOf(c.task.assign({ task_id: old.id, worker_id: 'wr' }));
  await overlapOf(c.task.assign({ task_id: old.id, check_only: true }));
  assert.strictEqual((await c.task.get({ task_id: old.id })).state, 'open', 'a refused assign wrote nothing');
});

test('a first attach reports no overlaps', async () => {
  const c = await open('run-first');
  const r = await c.run.attach({ adapter_pid: process.pid });
  assert.deepStrictEqual(r.overlaps, []);
});
