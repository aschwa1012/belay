'use strict';
// assign-check-only.test.cjs — ADR 0030 decisions 2 and 4. task.assign with check_only runs only the
// task-side checks and writes nothing; a dependency that is a refuted review says so. Real core, sandbox store.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, operator, judge;
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  operator = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
  await orch.worker.write({ id: 'judge-c', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-judge-c', last_event_at: Date.now() });
  judge = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'judge-c' }), embed: false });
});

after(async () => {
  await judge.close();
  await operator.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

const rejects = async (p, code, re) => {
  let got;
  await assert.rejects(p, (e) => {
    assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (re) assert.match(e.message, re);
    got = e;
    return true;
  });
  return got;
};

// What a refused or checked call must leave alone: the task row's seq and lease, and the worker list.
async function snapshot(taskId) {
  const t = await orch.task.get({ task_id: taskId });
  return { seq: t.seq, state: t.state, lease: t.lease ? t.lease.id : null, workers: (await orch.worker.list({})).workers.length };
}

test('check_only on an assignable task returns assignable and writes nothing, with no worker_id', async () => {
  const t = await orch.task.create({ spec: 'c1 work' });
  const before = await snapshot(t.id);
  const out = await orch.task.assign({ task_id: t.id, check_only: true });
  assert.deepStrictEqual(out, { assignable: true, task_id: t.id });
  assert.deepStrictEqual(await snapshot(t.id), before);
  // a worker_id that has no row is not looked at either
  assert.deepStrictEqual(await orch.task.assign({ task_id: t.id, worker_id: 'no-such-worker', check_only: true }), { assignable: true, task_id: t.id });
  assert.deepStrictEqual(await snapshot(t.id), before);
  // and the real assign still works afterwards
  const a = await orch.task.assign({ task_id: t.id, worker_id: 'judge-c' });
  assert.strictEqual(a.task.state, 'assigned');
  await judge.lease.release({ lease_id: a.new_lease.id, reason: 'done' });
});

test('check_only must be a boolean, and a real assign still needs a worker_id', async () => {
  const t = await orch.task.create({ spec: 'c2 work' });
  await rejects(orch.task.assign({ task_id: t.id, check_only: 'yes' }), 'E_ARGS', /boolean/);
  await rejects(orch.task.assign({ task_id: t.id }), 'E_ARGS', /worker_id/);
  await rejects(orch.task.assign({ check_only: true }), 'E_ARGS', /task_id/);
});

test('check_only returns each task-side refusal and writes nothing', async () => {
  await rejects(orch.task.assign({ task_id: 'no-such-task', check_only: true }), 'E_NOT_FOUND');

  const done = await orch.task.create({ spec: 'c3 done', acceptance: PASS });
  assert.strictEqual((await orch.task.evaluate({ task_id: done.id, worktree: dir })).state, 'done');
  const sDone = await snapshot(done.id);
  await rejects(orch.task.assign({ task_id: done.id, check_only: true }), 'E_TASK_DONE');
  assert.deepStrictEqual(await snapshot(done.id), sDone);

  const held = await orch.task.create({ spec: 'c3 held' });
  await operator.lease.takeControl({ task_id: held.id });
  const sHeld = await snapshot(held.id);
  await rejects(orch.task.assign({ task_id: held.id, check_only: true }), 'E_OPERATOR_HOLDS');
  assert.deepStrictEqual(await snapshot(held.id), sHeld);

  const dep = await orch.task.create({ spec: 'c3 dep' });
  const blocked = await orch.task.create({ spec: 'c3 blocked', depends_on: [dep.id] });
  const sBlocked = await snapshot(blocked.id);
  const e = await rejects(orch.task.assign({ task_id: blocked.id, check_only: true }), 'E_DEPENDENCY_OPEN');
  assert.strictEqual(e.detail.blocked_by, dep.id);
  assert.deepStrictEqual(await snapshot(blocked.id), sBlocked);
});

test('a non-review open dependency keeps the old message and has no dependency_verdict', async () => {
  const dep = await orch.task.create({ spec: 'c4 dep', acceptance: PASS });
  const next = await orch.task.create({ spec: 'c4 next', depends_on: [dep.id] });
  const e = await rejects(orch.task.assign({ task_id: next.id, worker_id: 'judge-c' }), 'E_DEPENDENCY_OPEN', /assign this task again once .* is done/);
  assert.strictEqual(e.detail.dependency_state, 'open');
  assert.ok(!('dependency_verdict' in e.detail));
  assert.doesNotMatch(e.message, /refuted/);
});

test('a refuted review dependency is named for what it is, and a review that has not been judged is not', async () => {
  const work = await orch.task.create({ spec: 'c5 work', acceptance: PASS });
  await orch.task.evaluate({ task_id: work.id, worktree: dir });
  const review = await orch.task.create({ spec: 'c5 review', depends_on: [work.id], acceptance: { verdict: true } });
  const fixBad = await orch.task.create({ spec: 'c5 fix on the review', depends_on: [review.id] });

  // Not yet judged: the old message.
  const early = await rejects(orch.task.assign({ task_id: fixBad.id, check_only: true }), 'E_DEPENDENCY_OPEN', /assign this task again once/);
  assert.ok(!('dependency_verdict' in early.detail));

  const a = await orch.task.assign({ task_id: review.id, worker_id: 'judge-c' });
  await judge.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { verdict: 'refuted', summary: 'the change does not do what the brief says', findings: ['f1'] } });
  const ev = await orch.task.evaluate({ task_id: review.id, worktree: dir });
  assert.notStrictEqual(ev.state, 'done');

  for (const call of [
    () => orch.task.assign({ task_id: fixBad.id, check_only: true }),
    () => orch.task.assign({ task_id: fixBad.id, worker_id: 'judge-c' }),
  ]) {
    const e = await rejects(call(), 'E_DEPENDENCY_OPEN', /a review whose last evaluation returned refuted/);
    assert.match(e.message, /re-judged and holds/);
    assert.match(e.message, /depends on the work it fixes/);
    assert.strictEqual(e.detail.dependency_verdict, 'refuted');
    assert.strictEqual(e.detail.blocked_by, review.id);
    assert.strictEqual(e.detail.task_id, fixBad.id);
  }

  // The fix task that depends on the work it repairs is assignable.
  const fixGood = await orch.task.create({ spec: 'c5 fix on the work', depends_on: [work.id] });
  assert.deepStrictEqual(await orch.task.assign({ task_id: fixGood.id, check_only: true }), { assignable: true, task_id: fixGood.id });
});

test('a refuted review that is re-assigned and re-judged holds is done, and its dependent becomes assignable', async () => {
  const work = await orch.task.create({ spec: 'c6 work', acceptance: PASS });
  await orch.task.evaluate({ task_id: work.id, worktree: dir });
  const review = await orch.task.create({ spec: 'c6 review', depends_on: [work.id], acceptance: { verdict: true } });
  const dependent = await orch.task.create({ spec: 'c6 dependent', depends_on: [review.id] });

  const a1 = await orch.task.assign({ task_id: review.id, worker_id: 'judge-c' });
  await judge.lease.release({ lease_id: a1.new_lease.id, reason: 'done', result: { verdict: 'refuted', summary: 'first look: wrong', findings: ['f'] } });
  assert.notStrictEqual((await orch.task.evaluate({ task_id: review.id, worktree: dir })).state, 'done');
  const e1 = await rejects(orch.task.assign({ task_id: dependent.id, check_only: true }), 'E_DEPENDENCY_OPEN', /last evaluation returned refuted/);
  assert.strictEqual(e1.detail.dependency_verdict, 'refuted');

  // Re-assigned, not yet evaluated: the results still carry the old refuted check.
  const a2 = await orch.task.assign({ task_id: review.id, worker_id: 'judge-c' });
  await rejects(orch.task.assign({ task_id: dependent.id, check_only: true }), 'E_DEPENDENCY_OPEN', /last evaluation returned refuted/);
  await judge.lease.release({ lease_id: a2.new_lease.id, reason: 'done', result: { verdict: 'holds', summary: 'second look: right', findings: [] } });
  assert.strictEqual((await orch.task.evaluate({ task_id: review.id, worktree: dir })).state, 'done');
  assert.deepStrictEqual(await orch.task.assign({ task_id: dependent.id, check_only: true }), { assignable: true, task_id: dependent.id });
});
