'use strict';
// policy-status.test.cjs — ADR 0071 decision 5: status shows each task's plan back to the user. A run with no plan gains no key, the rows
// come from the run's own tasks, the list is capped with a count, and the text line reads the same tag a task listing shows.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const SP = require('../../src/core/status-plans.cjs');

const { openCore } = core('index.cjs');
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };

let dir, orch;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
});

after(async () => {
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

test('a run whose tasks have no plan adds no plan key to status', async () => {
  await orch.task.create({ id: 'ps-none', spec: 'x', acceptance: PASS });
  const st = await orch.status.get({ run_id: 'test-run' });
  assert.ok(!('plans' in st) && !('plans_more' in st));
  assert.deepStrictEqual(SP.lines(st), []);
});

test('each task with a plan is shown with its tag and revision, at its current revision', async () => {
  await orch.task.create({ id: 'ps-a', spec: 'x', acceptance: PASS, policy: { review: { worker: 'rev-1' }, fix: 'builder' } });
  await orch.task.create({ id: 'ps-b', spec: 'x', acceptance: PASS, policy: { integrate: 'on_hold' } });
  await orch.task.create({ id: 'ps-b', amend: true, policy: { re_review: 'refuter' } });
  await orch.task.create({ id: 'ps-gone', spec: 'x', acceptance: PASS, policy: { fix: 'builder' } });
  await orch.task.create({ id: 'ps-gone', amend: true, policy: null });
  const st = await orch.status.get({ run_id: 'test-run' });
  assert.deepStrictEqual(st.plans, [
    { task_id: 'ps-a', policy_rev: 1, plan: 'r:rev-1 f:builder' },
    { task_id: 'ps-b', policy_rev: 2, plan: 'rr:refuter' },
  ], 'a handed-back task is not listed; the amended one shows its newest revision');
  assert.deepStrictEqual(SP.lines(st), ['plan ps-a: r:rev-1 f:builder (rev 1)', 'plan ps-b: rr:refuter (rev 2)']);
});

test('the list is capped and names how many were left out', () => {
  const plans = Array.from({ length: SP.MAX_PLANS }, (_, i) => ({ task_id: `t${i}`, policy_rev: 1, plan: 'f:builder' }));
  const out = SP.lines({ plans, plans_more: 4 });
  assert.strictEqual(out.length, SP.MAX_PLANS + 1);
  assert.strictEqual(out[out.length - 1], 'plan: 4 more tasks with a plan');
});
