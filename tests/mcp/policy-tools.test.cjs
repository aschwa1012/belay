'use strict';
require('../helpers/tmp.cjs');
// policy-tools.test.cjs — the plan surface at the MCP boundary (ADR 0071, ADR 0072 decision 3). The stamps a policy step writes (acted_by,
// trigger, policy_rev) are the harness's, so every tool that can write a task, a lease or an integration refuses them by name; a worker can
// neither set nor amend a plan; the orchestrator can, and sees the change shown back; the listings stay inside their budgets.

const test = require('node:test');
const assert = require('node:assert');

const tools = require('../../src/mcp/tools.cjs');
const views = require('../../src/mcp/views.cjs');
const { launch, sandboxDir } = require('./rpc.cjs');

const real = (o) => launch({ ...o, fake: false, noEmbed: true });
const STAMPS = ['acted_by', 'trigger', 'policy_rev'];
const STAMP_VALUE = { acted_by: 'policy', trigger: { table: 'task', id: 'x', seq: 1 }, policy_rev: 4 };
const REQUIRED = { task_create: { spec: 's' }, task_assign: { task_id: 't', worker_id: 'w' }, fix_from_review: { review_id: 'r' }, integrate: { task_ids: ['t'] } };

for (const [tool, base] of Object.entries(REQUIRED)) {
  for (const k of STAMPS) {
    test(`${tool} refuses ${k} from either role as a harness field, by name`, () => {
      assert.ok(tools.HARNESS_ONLY[tool].includes(k));
      for (const role of ['orchestrator', 'worker']) {
        assert.throws(() => tools.validateArgs(tool, { ...base, [k]: STAMP_VALUE[k] }, { role }),
          (e) => e.code === 'E_ARGS' && e.detail.reason === 'harness_only' && e.detail.field === k, `${tool} ${k} ${role}`);
      }
    });
  }
}

test('task_create refuses a stamp on a batch item and names the item', () => {
  for (const k of STAMPS) {
    assert.throws(() => tools.validateArgs('task_create', { tasks: [{ spec: 'a' }, { spec: 'b', [k]: STAMP_VALUE[k] }] }, { role: 'orchestrator' }),
      (e) => e.code === 'E_ARGS' && e.detail.reason === 'harness_only' && e.detail.field === k && e.detail.item === 1);
  }
});

test('task_create takes a policy, a batch item\'s policy and policy: null on an amend through the boundary', () => {
  const o = { role: 'orchestrator' };
  assert.doesNotThrow(() => tools.validateArgs('task_create', { spec: 's', policy: { fix: 'builder' } }, o));
  assert.doesNotThrow(() => tools.validateArgs('task_create', { tasks: [{ spec: 's', policy: { fix: 'builder' } }] }, o));
  assert.doesNotThrow(() => tools.validateArgs('task_create', { id: 't', amend: true, policy: null }, o));
  assert.throws(() => tools.validateArgs('task_create', { spec: 's', policy: 'builder' }, o), /policy/); // not an object
});

test('the plan is on the orchestrator\'s task_create only; the worker listing is unchanged', () => {
  const orch = tools.toolsFor('orchestrator'), worker = tools.toolsFor('worker');
  assert.ok(orch.find((t) => t.name === 'task_create').inputSchema.properties.policy);
  assert.ok(!JSON.stringify(worker).includes('policy'), 'no policy in a worker\'s listing');
  assert.ok(!worker.some((t) => ['task_create', 'task_assign', 'fix_from_review', 'integrate'].includes(t.name)));
  for (const t of ['task_create', 'task_assign', 'fix_from_review', 'integrate']) assert.strictEqual(tools.allows('worker', t), false, t);
  assert.strictEqual(tools.listingBytes('worker'), 3557, 'the worker listing is byte for byte what 0.3.3 listed');
});

test('the orchestrator listing stays inside its 20,480 B cap, and the field costs what the commit says', () => {
  const bytes = tools.listingBytes('orchestrator');
  const without = Buffer.byteLength(JSON.stringify(tools.toolsFor('orchestrator').map((t) => {
    if (t.name !== 'task_create') return t;
    const { policy, ...props } = t.inputSchema.properties;
    return { ...t, inputSchema: { ...t.inputSchema, properties: props } };
  })), 'utf8');
  console.log(`orchestrator listing ${bytes} B (${bytes - without} B for policy), cap ${tools.BUDGET.orchestrator}`);
  assert.ok(bytes <= tools.BUDGET.orchestrator, `${bytes} B`);
  assert.ok(bytes - without <= 820, `policy costs ${bytes - without} B`); // 806 B with the follow_up field, 776 B with the build field, 421 B for the fields, 565 B with the clause on what the plan saves, 651 B with the directive for every work task
});

test('a listing row shows the plan as a tag; the task\'s own detail shows it whole; a plan-less task shows nothing', () => {
  const policy = { review: { worker: 'w1' }, fix: 'builder', integrate: 'on_hold' };
  const row = { id: 'a', seq: 2, state: 'open', spec: 'x', policy, policy_rev: 3, acted_by: null, trigger: null };
  const list = views.compactTask(row);
  assert.strictEqual(list.policy, 'r:w1 f:builder i:on_hold');
  assert.strictEqual(list.policy_rev, 3);
  assert.ok(!('acted_by' in list) && !('trigger' in list), 'a null stamp says nothing');
  assert.deepStrictEqual(views.compactTask(row, { detail: true }).policy, policy);
  const none = views.compactTask({ id: 'b', seq: 1, state: 'open', spec: 'x', policy: null, policy_rev: null });
  assert.ok(!('policy' in none) && !('policy_rev' in none));
});

test('task_create\'s answer shows the plan back with its revision, a hand-back as policy null, and no plan as nothing', async () => {
  const row = (extra) => ({ id: 'a', seq: 2, state: 'open', spec: 's', run_id: 'r', written_at: 1, written_by: 'x', acted_by: null, trigger: null, ...extra });
  const planned = await views.viewed('task_create', {}, async () => row({ policy: { fix: 'builder' }, policy_rev: 2 }));
  assert.deepStrictEqual([planned.policy, planned.policy_rev, 'acted_by' in planned, 'trigger' in planned], [{ fix: 'builder' }, 2, false, false]);
  const handed = await views.viewed('task_create', {}, async () => row({ policy: null, policy_rev: 3 }));
  assert.deepStrictEqual([handed.policy, handed.policy_rev], [null, 3]);
  const plain = await views.viewed('task_create', {}, async () => row({ policy: null, policy_rev: null }));
  assert.ok(!('policy' in plain) && !('policy_rev' in plain));
});

test('end to end: the orchestrator sets, amends and hands back a plan and sees each change; a worker cannot, and a stamp never lands', { timeout: 60000 }, async (t) => {
  const data = sandboxDir('policy-e2e');
  const orch = real({ role: 'orchestrator', data });
  t.after(async () => { await orch.close(); orch.kill(); });
  await orch.initialize();

  const made = (await orch.call('task_create', { id: 'pol-1', spec: 'plan me', acceptance: { commands: [{ argv: ['node', '-e', '0'] }] }, policy: { fix: 'builder', review: { spawn: { agent_type: 'reviewer' } } } })).structuredContent;
  assert.deepStrictEqual([made.policy, made.rev ?? made.seq], [{ fix: 'builder', review: { spawn: { agent_type: 'reviewer' } } }, made.rev ?? made.seq]);
  assert.strictEqual(made.policy_rev, 1);
  const listed = (await orch.call('task_list', {})).structuredContent.tasks.find((r) => r.id === 'pol-1');
  assert.strictEqual(listed.policy, 'r:spawn(reviewer) f:builder');

  const amended = (await orch.call('task_create', { id: 'pol-1', amend: true, policy: { integrate: 'on_hold' } })).structuredContent;
  assert.deepStrictEqual([amended.policy, amended.policy_rev], [{ integrate: 'on_hold' }, 2], 'the change is shown back');
  assert.strictEqual((await orch.call('task_list', {})).structuredContent.tasks.find((r) => r.id === 'pol-1').policy, 'i:on_hold');

  const handed = (await orch.call('task_create', { id: 'pol-1', amend: true, policy: null })).structuredContent;
  assert.deepStrictEqual([handed.policy, handed.policy_rev], [null, 3]);
  assert.ok(!('policy' in (await orch.call('task_list', {})).structuredContent.tasks.find((r) => r.id === 'pol-1')));

  for (const k of STAMPS) {
    const r = await orch.call('task_create', { id: 'pol-1', amend: true, policy: { fix: 'builder' }, [k]: STAMP_VALUE[k] });
    assert.strictEqual(r.isError, true);
    assert.strictEqual(r.structuredContent.error, 'E_ARGS');
    assert.strictEqual(r.structuredContent.detail.reason, 'harness_only');
  }
  const after = (await orch.call('task_create', { id: 'pol-1', amend: true, policy: { fix: 'builder' } })).structuredContent;
  assert.strictEqual(after.policy_rev, 4, 'the refused calls wrote no revision');

  const worker = real({ role: 'worker', data, workerId: 'pol-worker', run: 'run-1' });
  t.after(async () => { await worker.close(); worker.kill(); });
  await worker.initialize();
  for (const args of [{ spec: 'mine', policy: { fix: 'builder' } }, { id: 'pol-1', amend: true, policy: null }, { spec: 'mine', acted_by: 'policy' }]) {
    const r = await worker.call('task_create', args);
    assert.strictEqual(r.isError, true, JSON.stringify(args));
    assert.strictEqual(r.structuredContent.error, 'E_ROLE', JSON.stringify(args));
  }
  const still = (await orch.call('task_list', { task_ids: ['pol-1'], view: 'debug' })).structuredContent.tasks[0];
  assert.deepStrictEqual([still.policy, still.policy_rev], [{ fix: 'builder' }, 4], 'a worker\'s call changed nothing');
});
