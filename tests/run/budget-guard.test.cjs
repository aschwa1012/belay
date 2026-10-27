'use strict';
// budget-guard.test.cjs — the run process's budget guard against a spy core: the soft threshold, the pause reason, the recorded
// detail, a task breach, idempotence, the orchestrator's cost, the one wake, and what a resume of a budget pause needs.

const test = require('node:test');
const assert = require('node:assert');
const { createBudgetGuard, wakeTextOf } = require('../../src/run/budget-guard.cjs');

function spy({ run = 0, tasks = {}, unknown = 0 } = {}) {
  const s = { run, tasks, unknown, pauses: [], written: [], budgetUsd: [] };
  const core = {
    usage: { spend: async (a) => ({ usd: a.task_id ? (s.tasks[a.task_id] || 0) : s.run, turns: 3, unknown_turns: s.unknown, first_seq: 1, last_seq: 9, per_worker: { w1: s.run }, per_task: s.tasks, unknown_workers: s.unknown ? [{ worker_id: 'cx', turns: s.unknown }] : [] }) },
    run: { setBudget: async (a) => { if (a.budget) s.written.push(JSON.parse(JSON.stringify(a.budget))); if (a.budget_usd) s.budgetUsd.push(a.budget_usd); } },
  };
  const out = { s, core, pauseRun: async (why) => { s.pauses.push(why); return { already: false }; } };
  return out;
}
const mk = (o, extra = {}) => createBudgetGuard({ core: o.core, runId: 'r1', pauseRun: (w) => o.pauseRun(w), ...extra });

test('no limit anywhere: a row costs no query and no pause', async () => {
  const o = spy({ run: 100 });
  let queried = 0; const spend = o.core.usage.spend; o.core.usage.spend = async (a) => { queried += 1; return spend(a); };
  const g = mk(o);
  assert.strictEqual(g.onUsage({ task_id: 't1' }), undefined);
  assert.strictEqual(queried, 0);
  assert.deepStrictEqual(o.s.pauses, []);
  assert.deepStrictEqual(g.takeWakes(), []);
});

test('the run pauses at 90 percent, with the reason, the detail and one unheld wake; a burst is one pause', async () => {
  const o = spy({ run: 8.9 });
  const g = mk(o, { runLimit: 10 });
  await g.onUsage({ task_id: null });
  assert.deepStrictEqual(o.s.pauses, [], 'under 90 percent');
  o.s.run = 9.2;
  await Promise.all([g.onUsage({}), g.onUsage({}), g.onUsage({})]);
  assert.deepStrictEqual(o.s.pauses, ['budget (run, $9.20 of $10.00 est.)']);
  const ev = o.s.written.pop().events.find((e) => e.type === 'pause');
  assert.strictEqual(ev.scope, 'run');
  assert.strictEqual(ev.estimate, true);
  assert.strictEqual(ev.last_seq, 9);
  assert.strictEqual(ev.spent_after_parks, 9.2);
  assert.ok(ev.per_worker && ev.unknown_turns === 0);
  const wakes = g.takeWakes();
  assert.strictEqual(wakes.length, 1);
  assert.strictEqual(wakes[0].unheld, true);
  assert.match(wakes[0].text, /run budget reached \(\$9\.20 of \$10\.00 est\.\)/);
  assert.deepStrictEqual(g.takeWakes(), [], 'taken once');
});

test('Codex turns make the figure "at least", and the wake text fits the interactive cap', async () => {
  const o = spy({ run: 9.5, unknown: 4 });
  const g = mk(o, { runLimit: 10 });
  await g.onUsage({});
  assert.match(g.takeWakes()[0].text, /at least \$9\.50 of \$10\.00 est\./);
  const long = wakeTextOf({ runId: 'a-very-long-run-identifier-0123456789', scope: 'task', taskId: 'task-with-a-long-id-0123456789', spent: 123.456, limit: 200, unknown: 1 });
  assert.ok(Buffer.byteLength(long) <= 221);
});

test('a task breach pauses the whole run, naming the task', async () => {
  const o = spy({ run: 1, tasks: { t1: 1.9 } });
  const g = mk(o, { runLimit: 100 });
  g.onTaskBudget({ task_id: 't1', budget_usd: 2 });
  await g.onUsage({ task_id: 't2' });
  assert.deepStrictEqual(o.s.pauses, [], 'an unbudgeted task is not checked');
  await g.onUsage({ task_id: 't1' });
  assert.deepStrictEqual(o.s.pauses, ['budget (task t1, $1.90 of $2.00 est.)']);
});

test('the orchestrator counts when headless, and never when interactive', async () => {
  const a = spy({ run: 5 });
  await mk(a, { runLimit: 10 }).noteOrchestratorCost(4);
  assert.strictEqual(a.s.pauses.length, 1);
  const b = spy({ run: 5 });
  assert.strictEqual(mk(b, { runLimit: 10, interactive: true }).noteOrchestratorCost(40), undefined);
  assert.deepStrictEqual(b.s.pauses, []);
});

test('a pause someone else holds is not ours: no record, no wake', async () => {
  const o = spy({ run: 9.5 });
  o.pauseRun = async () => ({ already: true });
  const g = mk(o, { runLimit: 10 });
  await g.onUsage({});
  assert.deepStrictEqual(g.takeWakes(), []);
  assert.deepStrictEqual(o.s.written, []);
});

test('a resume of a budget pause needs a raise above the spend or an override; each is recorded', async () => {
  const paused = { paused_by: 'operator:1 [budget (run, $9.20 of $10.00 est.)]' };
  const op = (extra) => ({ caller: { role: 'operator', pid: 7 }, ...extra });
  const fresh = async () => { const o = spy({ run: 9.2 }); const g = mk(o, { runLimit: 10 }); await g.onUsage({}); return { o, g }; };
  let { o, g } = await fresh();
  await assert.rejects(g.authorizeResume(paused, op({})), (e) => e.code === 'E_ARGS' && /--over-budget/.test(e.message));
  await assert.rejects(g.authorizeResume(paused, op({ budget: 9 })), (e) => /not above the current limit/.test(e.message));
  await assert.rejects(g.authorizeResume(paused, op({ budget: 10.1 })), (e) => /below the estimated spend/.test(e.message));
  await assert.rejects(g.authorizeResume(paused, op({ task_budget: { task_id: 't', usd: 50 } })), (e) => e.code === 'E_ARGS');
  const raise = await g.authorizeResume(paused, op({ budget: 20 }));
  assert.deepStrictEqual([raise.type, raise.old, raise.new, raise.by], ['raise', 10, 20, 'operator:7']);
  assert.deepStrictEqual(o.s.budgetUsd, [20]);
  o.s.pauses.length = 0;
  o.s.run = 15;
  await g.onUsage({});
  assert.deepStrictEqual(o.s.pauses, [], '15 is under 90 percent of 20');
  ({ o, g } = await fresh());
  const ov = await g.authorizeResume(paused, op({ over_budget: true }));
  assert.strictEqual(ov.override, true);
  o.s.pauses.length = 0;
  o.s.run = 500;
  await g.onUsage({});
  assert.strictEqual(o.s.pauses.length, 0, 'no second pause once overridden');
  assert.strictEqual(await g.authorizeResume({ paused_by: 'operator:1' }, op({})), null, 'not a budget pause: nothing to decide');
});
