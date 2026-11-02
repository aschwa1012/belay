'use strict';
// run-budget.test.cjs — the store half of run and task budgets: off by default, the ledger sums, the task a turn is charged to,
// Codex turns as unknown, the status block, and the hooks the run process sets. A real Engine over a real store.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const rows = core('rows.cjs');
const RB = core('run-budget.cjs');

let dir, store, E;
const seen = { usage: [], tasks: [] };
const operator = callerFor('operator');
const orch = callerFor('orchestrator');
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const fakeOwner = { opts: { onUsageRecorded: (r) => seen.usage.push(r), onTaskBudget: (t) => seen.tasks.push(t) }, noteWrite() {} };

before(() => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: fakeOwner, establishedBy: 'test' });
});
after(() => { store.close(); cleanup(dir, { skipInvariants: 'the test writes task and lease rows by hand, so the store is not one the methods made' }); });

const attach = (extra = {}) => call('run.attach', operator, { adapter_pid: process.pid, ...extra });
const lease = (id, task, holder, granted, released = null) => rows.append(store, 'lease', {
  id, task_id: task, run_id: 'test-run', holder, holder_role: 'worker', granted_at: granted, expires_at: granted + 600000, released_at: released, ttl_ms: 600000,
}, 'test', granted);
const usage = (args) => call('usage.record', operator, { worker_id: 'w1', substrate: 'claude-code', ...args });

test('off by default: no limit on the run row, no status block, no budget on a task, nothing recorded', async () => {
  await attach();
  const run = rows.current(store, 'run', 'test-run');
  assert.strictEqual(run.budget_usd, null);
  assert.strictEqual(run.budget, null);
  assert.strictEqual((await call('status.get', operator, {})).run.budget, undefined);
  const t = await call('task.create', orch, { spec: 'plain' });
  assert.strictEqual(t.budget_usd, null);
  assert.strictEqual(seen.tasks.length, 0, 'the task hook is not called for a task without a limit');
});

test('a task limit is refused while the run writes no usage ledger, and nothing is written', async () => {
  const n = rows.currentAll(store, 'task').length;
  await assert.rejects(call('task.create', orch, { spec: 'x', budget_usd: 1 }), (e) => e.code === 'E_ARGS' && /usage ledger/.test(e.message));
  assert.strictEqual(rows.currentAll(store, 'task').length, n);
});

test('with a run limit: attach records it, status shows the block, task limits are accepted and reported to the hook', async () => {
  await attach({ budget_usd: 10 });
  assert.strictEqual(rows.current(store, 'run', 'test-run').budget_usd, 10);
  await assert.rejects(attach({ budget_usd: -1 }), (e) => e.code === 'E_ARGS');
  const t = await call('task.create', orch, { id: 'tb', spec: 'capped', budget_usd: 2 });
  assert.strictEqual(t.budget_usd, 2);
  assert.deepStrictEqual(seen.tasks.map((x) => [x.task_id, x.budget_usd]), [['tb', 2]]);
  await assert.rejects(call('task.create', orch, { spec: 'bad', budget_usd: 0 }), (e) => e.code === 'E_ARGS');
  const before = seen.tasks.length;
  const batch = await call('task.create', orch, { tasks: [{ id: 'tb1', spec: 'one', budget_usd: 3 }, { id: 'tb2', spec: 'two' }] });
  assert.strictEqual(batch.tasks.length, 2);
  assert.deepStrictEqual(seen.tasks.slice(before).map((x) => [x.task_id, x.budget_usd]), [['tb1', 3]], 'a batch item with a limit reaches the hook once, after the batch is written');
  await assert.rejects(call('task.create', orch, { tasks: [{ id: 'tb3', spec: 'ok', budget_usd: 1 }, { id: 'tb4', spec: 'bad', budget_usd: 0 }] }), (e) => e.code === 'E_ARGS');
  assert.strictEqual(seen.tasks.length, before + 1, 'a refused batch tells the hook nothing');
  const st = (await call('status.get', operator, {})).run.budget;
  assert.deepStrictEqual([st.limit_usd, st.spent_usd, st.state, st.basis], [10, 0, 'under', 'reported']);
});

test('the run hook sees each row; the sums count dollars and keep Codex turns as unknown, never free', async () => {
  await call('task.create', orch, { id: 'ta', spec: 'a' });
  const r1 = await usage({ turn: 1, cost_usd: 1.5, cost_basis: 'delta-of-cumulative', task_id: 'ta' });
  await usage({ worker_id: 'cx', substrate: 'codex', turn: 1, task_id: 'ta' });
  assert.strictEqual(seen.usage.length, 2);
  assert.strictEqual(seen.usage[0].id, r1.id);
  const all = await call('usage.spend', operator, {});
  assert.deepStrictEqual([all.usd, all.turns, all.unknown_turns], [1.5, 2, 1]);
  const d = await call('usage.spend', operator, { detail: true });
  assert.deepStrictEqual(d.unknown_workers, [{ worker_id: 'cx', turns: 1 }]);
  assert.strictEqual(d.per_task.ta, 1.5);
  const st = (await call('status.get', operator, {})).run.budget;
  assert.strictEqual(st.unknown_turns, 1);
  assert.match(RB.textOf(st), /^at least \$1\.50 of \$10\.00 reported \(under\); 1 turn report no dollars$/);
});

test('a turn is charged to the task whose lease the worker held when it ended, one task per turn', async () => {
  await call('task.create', orch, { id: 'tx', spec: 'x' });
  await call('task.create', orch, { id: 'ty', spec: 'y' });
  lease('lx', 'tx', 'w2', 1000, 2000); // released inside turn 1
  lease('ly', 'ty', 'w2', 2500); // held at the end of turn 2
  const t1 = await usage({ worker_id: 'w2', turn: 1, cost_usd: 0.1, cost_basis: 'delta-of-cumulative', turn_window: { since: 900, until: 2100 } });
  assert.strictEqual(t1.task_id, 'tx', 'released within the turn: the lease released last');
  const t2 = await usage({ worker_id: 'w2', turn: 2, cost_usd: 0.2, cost_basis: 'delta-of-cumulative', turn_window: { since: 2100, until: 3000 } });
  assert.strictEqual(t2.task_id, 'ty', 'one worker, two tasks: the second turn goes to the second task');
  lease('lz', 'tx', 'w3', 100, 150); // released before the window opened
  const t3 = await usage({ worker_id: 'w3', turn: 1, cost_usd: 0.3, cost_basis: 'delta-of-cumulative', turn_window: { since: 500, until: 900 } });
  assert.strictEqual(t3.task_id, null, 'no lease held and none released in the window: the run alone');
  const per = await call('usage.spend', operator, { detail: true });
  const sum = Object.values(per.per_task).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - per.usd) < 1e-9, 'task spends sum to the run\'s');
});

test('only the operator (the run process) writes the budget record', async () => {
  await assert.rejects(call('run.setBudget', orch, { budget_usd: 99 }), (e) => e.code === 'E_ROLE');
  const row = await call('run.setBudget', operator, { budget_usd: 12, budget: { events: [{ type: 'raise' }] } });
  assert.strictEqual(row.budget_usd, 12);
  assert.deepStrictEqual(row.budget.events, [{ type: 'raise' }]);
  assert.strictEqual((await call('status.get', operator, {})).run.budget.limit_usd, 12);
});

test('an expired lease nobody renewed is not charged for a later turn', async () => {
  rows.append(store, 'lease', { id: 'lold', task_id: 'tx', run_id: 'test-run', holder: 'w4', holder_role: 'worker', granted_at: 100, expires_at: 200, released_at: null, ttl_ms: 100 }, 'test', 100);
  const t = await usage({ worker_id: 'w4', turn: 1, cost_usd: 0.1, cost_basis: 'delta-of-cumulative', turn_window: { since: 50, until: 5000 } });
  assert.strictEqual(t.task_id, null);
});

test('a paused run starts no new work for the orchestrator, whatever paused it; the operator still can', async () => {
  await call('task.create', orch, { id: 'tp', spec: 'p' });
  await call('run.setPaused', operator, { paused: true, at: Date.now(), by: 'operator:1 [embedder-failure (x)]' });
  await assert.rejects(call('task.assign', orch, { task_id: 'tp', worker_id: 'wp' }), (e) => e.code === 'E_PAUSED');
  // the operator's assign and the orchestrator's check_only are not refused by the pause (they may fail for other reasons, never E_PAUSED)
  for (const [who, a] of [[operator, { task_id: 'tp', worker_id: 'wp' }], [orch, { task_id: 'tp', worker_id: 'wp', check_only: true }]]) {
    await call('task.assign', who, a).catch((e) => assert.notStrictEqual(e.code, 'E_PAUSED'));
  }
  await call('run.setPaused', operator, { paused: false });
});

test('an interactive run (the owner says it does not gate) leaves the orchestrator assign alone; attachLimit honours an explicit spec value', async () => {
  await call('run.setPaused', operator, { paused: true, at: Date.now(), by: 'operator:1' });
  fakeOwner.opts.gateOnPause = false;
  try { await call('task.assign', orch, { task_id: 'tp', worker_id: 'wp' }).catch((e) => assert.notStrictEqual(e.code, 'E_PAUSED')); }
  finally { delete fakeOwner.opts.gateOnPause; await call('run.setPaused', operator, { paused: false }); }
  const prev = { budget_usd: 20, budget: JSON.stringify({ events: [{ type: 'raise', scope: 'run' }] }) };
  assert.strictEqual(RB.attachLimit({ budget_usd: 10, budget_explicit: true }, prev, true), 10, 'the spec says so');
  assert.strictEqual(RB.attachLimit({ budget_usd: null, budget_explicit: true }, prev, true), null, 'null turns it off');
  assert.strictEqual(RB.attachLimit({ budget_usd: 10 }, prev, true), 20, 'a config default keeps the recorded raise');
  assert.strictEqual(RB.attachLimit({ budget_usd: 10 }, prev, false), 10, 'a new life takes the default');
  assert.strictEqual(RB.attachLimit({}, prev, true), 20, 'an attach that states none keeps it');
});

test('run.assertNotPaused refuses the orchestrator while paused and lets the operator and an ungated run through', async () => {
  await call('run.setPaused', operator, { paused: true, at: Date.now(), by: 'operator:1' });
  try {
    await assert.rejects(call('run.assertNotPaused', orch, {}), (e) => e.code === 'E_PAUSED');
    assert.deepStrictEqual(await call('run.assertNotPaused', operator, {}), { paused: false });
    fakeOwner.opts.gateOnPause = false;
    assert.deepStrictEqual(await call('run.assertNotPaused', orch, {}), { paused: false });
  } finally { delete fakeOwner.opts.gateOnPause; await call('run.setPaused', operator, { paused: false }); }
  assert.deepStrictEqual(await call('run.assertNotPaused', orch, {}), { paused: false });
});

test('the status block shows the figure the guard pauses on: the ledger plus the headless orchestrator, named', () => {
  const row = { budget_usd: 10, budget: JSON.stringify({ orchestrator: { counted: true, usd: 2.5 } }), paused_by: null, paused_at: null };
  const b = RB.blockOf(row, { usd: 6, unknown_turns: 0 });
  assert.deepStrictEqual([b.spent_usd, b.ledger_usd, b.orchestrator.usd], [8.5, 6, 2.5]);
  assert.match(RB.textOf(b), /^\$8\.50 of \$10\.00 reported, \$2\.50 of it the orchestrator's \(under\)$/);
  const i = RB.blockOf({ budget_usd: 10, budget: JSON.stringify({ orchestrator: { counted: false } }) }, { usd: 6, unknown_turns: 0 });
  assert.strictEqual(i.spent_usd, 6);
});
