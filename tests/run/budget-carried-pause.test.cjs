'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// A run process that re-attaches while the run is paused by a task budget must resume it as a task pause: the scope comes from the
// recorded pause, not from a default of the run.

const test = require('node:test');
const assert = require('node:assert');
const { createBudgetGuard } = require('../../src/run/budget-guard.cjs');

function mk(runLimit) {
  const s = { budgetUsd: [] };
  const core = {
    usage: { spend: async () => ({ usd: 2.8, turns: 1, unknown_turns: 0 }) },
    task: { list: async () => ({ tasks: [] }) },
    run: { get: async () => ({ run: {} }), setBudget: async (a) => { if (a.budget_usd) s.budgetUsd.push(a.budget_usd); } },
  };
  return { s, g: createBudgetGuard({ core, runId: 'r1', runLimit, pauseRun: async () => ({}) }) };
}
const attach = (runLimit) => ({ budget_usd: runLimit, budget: { events: [{ type: 'pause', scope: 'task', task_id: 't1', limit: 3, spent: 2.8 }], tasks: { t1: 3 } } });
const row = { paused_by: 'operator:1 [budget (task t1, $2.80 of $3.00 reported)]' };

test('a flagless resume of a carried task pause names the task', async () => {
  const { g } = mk(100); await g.loadAttach(attach(100));
  await assert.rejects(() => g.authorizeResume(row, {}), (e) => e.code === 'E_ARGS' && /task t1/.test(e.message) && e.detail.scope === 'task');
});

test('--task-budget raises the carried task limit', async () => {
  const { g } = mk(100); await g.loadAttach(attach(100));
  const ev = await g.authorizeResume(row, { task_budget: { task_id: 't1', usd: 5 } });
  assert.strictEqual(ev.type, 'raise'); assert.strictEqual(ev.scope, 'task'); assert.strictEqual(g.state().tasks.t1, 5);
});

test('--over-budget overrides the task, not the run limit', async () => {
  const { g } = mk(100); await g.loadAttach(attach(100));
  const ev = await g.authorizeResume(row, { over_budget: true });
  assert.strictEqual(ev.scope, 'task'); assert.strictEqual(ev.task_id, 't1');
  assert.deepStrictEqual(g.state().overrides, { run: false, tasks: ['t1'] });
});

test('--budget is refused for a carried task pause and creates no run limit', async () => {
  const { g, s } = mk(null); await g.loadAttach(attach(null));
  await assert.rejects(() => g.authorizeResume(row, { budget: 4 }), (e) => e.code === 'E_ARGS');
  assert.strictEqual(g.state().limit, null); assert.deepStrictEqual(s.budgetUsd, []);
});

test('a carried run pause still resumes as a run pause', async () => {
  const { g } = mk(100);
  await g.loadAttach({ budget_usd: 100, budget: { events: [{ type: 'pause', scope: 'run', limit: 100, spent: 95 }] } });
  const ev = await g.authorizeResume({ paused_by: 'operator:1 [budget (run, $95.00 of $100.00 reported)]' }, { over_budget: true });
  assert.strictEqual(ev.scope, 'run'); assert.strictEqual(g.state().overrides.run, true);
});

test('a stale, resolved task pause event does not outrank a row that says the run reached its budget', async () => {
  const { g } = mk(100);
  await g.loadAttach({ budget_usd: 100, budget: { events: [{ type: 'pause', scope: 'task', task_id: 't1', limit: 3, spent: 2.8 }, { type: 'raise', scope: 'task', task_id: 't1', old: 3, new: 5 }], tasks: { t1: 5 } } });
  const ev = await g.authorizeResume({ paused_by: 'operator:1 [budget (run, $95.00 of $100.00 reported)]' }, { over_budget: true });
  assert.strictEqual(ev.scope, 'run'); assert.deepStrictEqual(g.state().overrides, { run: true, tasks: [] });
});
