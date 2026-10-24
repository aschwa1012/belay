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
  assert.deepStrictEqual(await holdsOf(a, t.id), [true, 'run_live']);
});

test('a task of a run with no run row still holds (drivers and tests that never attach)', async () => {
  const c = await open('run-norow');
  const t = await c.task.create({ spec: 'norow', files_owned: ['norow/x'] });
  await overlapOf(a.task.create({ spec: 'clash', files_owned: ['norow/x'] }));
  assert.deepStrictEqual(await holdsOf(a, t.id), [true, 'run_live']);
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
  assert.deepStrictEqual(await holdsOf(a, d.id), [true, 'run_live']);
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
  assert.deepStrictEqual(await holdsOf(c, old.id), [true, 'run_live']);
  await overlapOf(c.task.assign({ task_id: old.id, worker_id: 'wr' }));
  await overlapOf(c.task.assign({ task_id: old.id, check_only: true }));
  assert.strictEqual((await c.task.get({ task_id: old.id })).state, 'open', 'a refused assign wrote nothing');
  // The run that is live now keeps the paths: the incumbent's task is not refused by the resumed run's, and the two
  // runs are not deadlocked. The resumed run's task is still refused after the incumbent's is assigned.
  await a.worker.write({ id: 'wa', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
  assert.deepStrictEqual(await a.task.assign({ task_id: mine.id, check_only: true }), { assignable: true, task_id: mine.id });
  const got = await a.task.assign({ task_id: mine.id, worker_id: 'wa' });
  assert.strictEqual(got.task.state, 'assigned');
  await overlapOf(c.task.assign({ task_id: old.id, worker_id: 'wr' }));
});

test('a later attach of a live run does not make its tasks yield to a run that resumed before it', async () => {
  const c = await open('run-late-a');
  await c.run.attach({ adapter_pid: process.pid });
  const r = await open('run-late-r');
  await r.run.attach({ adapter_pid: process.pid });
  const theirs = await r.task.create({ spec: 'theirs', files_owned: ['late/y'] });
  await r.run.end({ exit_reason: 'test' });
  const thief = await c.task.create({ spec: 'thief', files_owned: ['late/y'] });
  const op = await open('run-late-r', 'operator');
  await op.run.attach({ adapter_pid: process.pid });
  // c's orchestrator adapter attaches again (a second epoch of a life that never ended) after r came back
  await c.run.attach({ adapter_pid: process.pid });
  assert.deepStrictEqual(await c.task.assign({ task_id: thief.id, check_only: true }), { assignable: true, task_id: thief.id });
  await overlapOf(r.task.assign({ task_id: theirs.id, check_only: true }));
});

test('a run that lapsed with no run.end and re-attaches queues behind the run that took its paths meanwhile, and a later attach of the same life keeps that order (D36)', async () => {
  const la = await open('run-lapse-a');
  await la.run.attach({ adapter_pid: deadPid() }); // the first adapter dies; run.end never comes
  const mine = await la.task.create({ spec: 'lapsed', files_owned: ['lapse/x'] });
  const lb = await open('run-lapse-b');
  await lb.run.attach({ adapter_pid: process.pid });
  await lb.worker.write({ id: 'wlb', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
  const theirs = await lb.task.create({ spec: 'took it meanwhile', files_owned: ['lapse/x'] }); // allowed: the lapsed run held nothing
  assert.strictEqual(theirs.state, 'open');
  await lb.task.assign({ task_id: theirs.id, worker_id: 'wlb' });
  const r = await la.run.attach({ adapter_pid: process.pid }); // a new adapter over an unended row: the run is live again
  assert.deepStrictEqual(r.overlaps, [{ task_id: mine.id, other_task_id: theirs.id, files: ['lapse/x'] }]);
  await overlapOf(la.task.assign({ task_id: mine.id, check_only: true }));
  await overlapOf(la.task.assign({ task_id: mine.id, worker_id: 'wlb' }));
  assert.deepStrictEqual(await lb.task.assign({ task_id: theirs.id, check_only: true }), { assignable: true, task_id: theirs.id }, 'the incumbent keeps its paths');
  assert.strictEqual((await lb.task.get({ task_id: theirs.id })).state, 'assigned');
  assert.strictEqual((await la.task.get({ task_id: mine.id })).state, 'open', 'a refused assign wrote nothing');
  // The orchestrator adapter of the revived life attaches while the run process still answers: no new lapse, so the order stays.
  await la.run.attach({ adapter_pid: process.pid });
  await overlapOf(la.task.assign({ task_id: mine.id, check_only: true }));
  assert.deepStrictEqual(await lb.task.assign({ task_id: theirs.id, check_only: true }), { assignable: true, task_id: theirs.id });
});

test('of two runs that lapsed and revived, the later revival queues behind the earlier, and an ordinary attach of the earlier does not change that (D36)', async () => {
  const y = await open('run-cont-y');
  await y.run.attach({ adapter_pid: deadPid() });
  const ty = await y.task.create({ spec: 'y', files_owned: ['cont/x'] });
  const x = await open('run-cont-x');
  await x.run.attach({ adapter_pid: deadPid() });
  const tx = await x.task.create({ spec: 'x', files_owned: ['cont/x'] }); // both runs are lapsed: nobody holds
  await y.run.attach({ adapter_pid: process.pid }); // y revives first
  await x.run.attach({ adapter_pid: process.pid }); // x revives second
  // A pause and an embedder-mode change copy the row before them, revived_epoch included; neither is a new life, so y keeps its priority.
  await y.run.setPaused({ paused: true });
  await y.run.setEmbedderMode({ mode: 'keyword' });
  await y.run.setPaused({ paused: false });
  await overlapOf(x.task.assign({ task_id: tx.id, check_only: true }));
  assert.deepStrictEqual(await y.task.assign({ task_id: ty.id, check_only: true }), { assignable: true, task_id: ty.id });
  await y.run.attach({ adapter_pid: process.pid }); // y's orchestrator adapter: the same life, no lapse
  await overlapOf(x.task.assign({ task_id: tx.id, check_only: true }));
  assert.deepStrictEqual(await y.task.assign({ task_id: ty.id, check_only: true }), { assignable: true, task_id: ty.id });
});

test('a first attach reports no overlaps', async () => {
  const c = await open('run-first');
  const r = await c.run.attach({ adapter_pid: process.pid });
  assert.deepStrictEqual(r.overlaps, []);
});

test('an ended run\'s task does not take the priority a live run\'s task yields: assigning it is refused on the live overlap', async () => {
  const ea = await open('run-ended-a');
  await ea.run.attach({ adapter_pid: process.pid });
  const old = await ea.task.create({ spec: 'old', files_owned: ['endedprio/z'] });
  await ea.run.end({ exit_reason: 'test' });
  const eb = await open('run-ended-b'); // attaches after run-ended-a did, so its liveness is the later one
  await eb.run.attach({ adapter_pid: process.pid });
  const live = await eb.task.create({ spec: 'live', files_owned: ['endedprio/z'] });
  const op = await open('cli', 'operator');
  await eb.worker.write({ id: 'w-ended-prio', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
  await overlapOf(op.task.assign({ task_id: old.id, check_only: true }));
  await overlapOf(op.task.assign({ task_id: old.id, worker_id: 'w-ended-prio' }));
  assert.strictEqual((await op.task.get({ task_id: old.id })).state, 'open', 'a refused assign wrote nothing');
  assert.deepStrictEqual(await holdsOf(op, live.id), [true, 'run_live']);
});

// Activation (ADR 0046 decision 1): every path that makes a task worked must establish its hold for a live run, or refuse.
const orphan = async (tag, files) => {
  const o = await open(`run-orph-${tag}`);
  await o.run.attach({ adapter_pid: process.pid });
  await o.worker.write({ id: `w-orph-${tag}`, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
  const t = await o.task.create({ spec: 'orphan', files_owned: files });
  await o.run.end({ exit_reason: 'test' });
  return t;
};
const liveWorker = async (c, id) => c.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });

test('an operator assigning an ended run\'s task to a live run\'s worker makes the live run hold its files', async () => {
  const t = await orphan('adopt', ['adopt/x']);
  const op = await open('cli', 'operator');
  await liveWorker(b, 'w-adopt');
  assert.deepStrictEqual(await holdsOf(op, t.id), [false, 'run_ended']);
  const r = await op.task.assign({ task_id: t.id, worker_id: 'w-adopt' });
  assert.strictEqual(r.task.run_id, 'run-b');
  assert.strictEqual(r.new_lease.run_id, 'run-b');
  assert.deepStrictEqual(await holdsOf(op, t.id), [true, 'run_live']);
  await overlapOf(b.task.create({ spec: 'clash', files_owned: ['adopt/x'] }));
});

test('assigning an ended run\'s task to a worker whose run is also ended is refused, and nothing is written', async () => {
  const t = await orphan('dead', ['bothended/x']);
  const op = await open('cli', 'operator');
  const before = await op.task.get({ task_id: t.id });
  await assert.rejects(op.task.assign({ task_id: t.id, worker_id: 'w-orph-dead' }), (e) => { assert.strictEqual(e.code, 'E_RUN_NOT_LIVE', e.message); return true; });
  assert.deepStrictEqual(await op.task.get({ task_id: t.id }), before);
});

test('check_only of an ended run\'s task is assignable for a live orchestrator and refused for the operator', async () => {
  const t = await orphan('chk', ['chk/x']);
  const op = await open('cli', 'operator');
  assert.strictEqual((await b.task.assign({ task_id: t.id, check_only: true })).assignable, true);
  await assert.rejects(op.task.assign({ task_id: t.id, check_only: true }), (e) => e.code === 'E_RUN_NOT_LIVE');
});

test('an ended run\'s task that owns no files is assigned as before, in its own run', async () => {
  const t = await orphan('nofiles', null);
  const op = await open('cli', 'operator');
  await liveWorker(b, 'w-nofiles');
  const r = await op.task.assign({ task_id: t.id, worker_id: 'w-nofiles' });
  assert.strictEqual(r.task.run_id, 'run-orph-nofiles');
});

test('take-control of an ended run\'s task that owns files is refused, and nothing is written', async () => {
  const t = await orphan('tc', ['tc/x']);
  const op = await open('cli', 'operator');
  const before = await op.task.get({ task_id: t.id });
  await assert.rejects(op.lease.takeControl({ task_id: t.id }), (e) => { assert.strictEqual(e.code, 'E_RUN_NOT_LIVE', e.message); return true; });
  assert.deepStrictEqual(await op.task.get({ task_id: t.id }), before);
});

test('take-control of a task in a live run still works, and refuses an overlap the live run now holds', async () => {
  const op = await open('cli', 'operator');
  const mine = await b.task.create({ spec: 'tc live', files_owned: ['tclive/x'] });
  assert.strictEqual((await op.lease.takeControl({ task_id: mine.id })).new_lease.holder, 'operator');
});
