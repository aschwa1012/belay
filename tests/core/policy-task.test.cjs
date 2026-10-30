'use strict';
// policy-task.test.cjs — ADR 0071 decisions 1 to 4 on a real store: the plan is stored on the task row with its revision, the user's default
// (stated by the launching process at run.attach) fills what a task leaves unsaid, an amend writes the next revision, `policy: null` hands the
// task back, a refused plan writes nothing, and no caller can name a policy step's stamps.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { rejectsCode } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };
const DEFAULT = { fix: 'builder', integrate: 'on_hold' };

let dir, operator, orch, worker;

before(async () => {
  dir = sandbox();
  operator = await openCore({ dataDir: `${dir}/data`, caller: callerFor('operator'), embed: false });
  await operator.run.attach({ adapter_pid: process.pid, policy_default: DEFAULT });
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid }); // the orchestrator's own adapter states no default and inherits the run's
  worker = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: 'pol-w' }), embed: false });
});

after(async () => {
  try { await orch.shutdownOwner(); } finally { await orch.close(); await worker.close(); await operator.close(); cleanup(dir); }
});

const rowOf = (id) => orch.task.get({ task_id: id });

test('the run keeps the user\'s default; the orchestrator\'s re-attach does not lose it', async () => {
  const run = (await orch.run.get()).run;
  assert.deepStrictEqual(JSON.parse(run.policy_default), DEFAULT);
});

test('a task with no plan takes the default whole, at revision 1', async () => {
  const t = await orch.task.create({ id: 'pt-def', spec: 'work', acceptance: PASS });
  assert.deepStrictEqual([t.policy, t.policy_rev, t.acted_by, t.trigger], [DEFAULT, 1, null, null]);
  assert.deepStrictEqual((await rowOf('pt-def')).policy, DEFAULT, 'stored on the row, read back parsed');
});

test('a task\'s own field beats the default, and the default fills the rest', async () => {
  const t = await orch.task.create({ id: 'pt-own', spec: 'work', acceptance: PASS, policy: { review: { worker: 'rev-a' }, integrate: 'on_hold', re_review: 'refuter' } });
  assert.deepStrictEqual(t.policy, { fix: 'builder', integrate: 'on_hold', review: { worker: 'rev-a' }, re_review: 'refuter' });
});

test('policy: null at create is no plan, and the default does not apply', async () => {
  const t = await orch.task.create({ id: 'pt-none', spec: 'work', acceptance: PASS, policy: null });
  assert.deepStrictEqual([t.policy, t.policy_rev], [null, null]);
});

test('a batch item carries its own plan and takes the default as a single task does', async () => {
  const out = await orch.task.create({ tasks: [{ id: 'pt-b1', spec: 'a', acceptance: PASS, policy: { review: { spawn: { agent_type: 'reviewer' } } } }, { id: 'pt-b2', spec: 'b', acceptance: PASS }] });
  const by = Object.fromEntries(out.tasks.map((t) => [t.id, t]));
  assert.deepStrictEqual(by['pt-b1'].policy, { fix: 'builder', integrate: 'on_hold', review: { spawn: { agent_type: 'reviewer' } } });
  assert.deepStrictEqual(by['pt-b2'].policy, DEFAULT);
});

test('a fix task and a review task do not take the default', async () => {
  const w = await orch.task.create({ id: 'pt-work', spec: 'work', acceptance: PASS });
  const fix = await orch.task.create({ id: 'pt-fix', spec: 'fix', acceptance: PASS, repairs: w.id });
  const rev = await orch.task.create({ id: 'pt-rev', spec: 'review', acceptance: { verdict: true } });
  assert.deepStrictEqual([fix.policy, rev.policy], [null, null]);
});

test('a refused plan writes nothing, whatever shape the refusal takes', async () => {
  for (const policy of [{ cut: { when: 'deps_merged' } }, { review: { pool: ['a'] } }, { fix: 'someone_else' }, 'builder', { integrate: 'before_review' }]) {
    await rejectsCode(orch.task.create({ id: 'pt-bad', spec: 'x', acceptance: PASS, policy }), 'E_ARGS');
    assert.strictEqual(await orch.task.get({ task_id: 'pt-bad' }).then(() => 'row', (e) => e.code), 'E_NOT_FOUND', JSON.stringify(policy));
  }
  await rejectsCode(orch.task.create({ tasks: [{ id: 'pt-ok', spec: 'x', acceptance: PASS }, { id: 'pt-bad2', spec: 'x', acceptance: PASS, policy: { follow_up: 'wake' } }] }), 'E_ARGS');
  assert.strictEqual(await orch.task.get({ task_id: 'pt-ok' }).then(() => 'row', (e) => e.code), 'E_NOT_FOUND', 'all or nothing');
});

test('an amend writes the next revision, replaces the plan, and the old row stays in the history', async () => {
  const t = await orch.task.create({ id: 'pt-am', spec: 'work', acceptance: PASS, policy: { review: { worker: 'rev-a' } } });
  assert.strictEqual(t.policy_rev, 1);
  const a = await orch.task.create({ id: 'pt-am', amend: true, policy: { re_review: 'refuter' } });
  assert.deepStrictEqual([a.policy, a.policy_rev], [{ fix: 'builder', integrate: 'on_hold', re_review: 'refuter' }, 2], 'review is gone; the default refills');
  assert.deepStrictEqual([a.acceptance, a.spec, a.amended || null], [PASS, 'work', null], 'a policy-only amend leaves acceptance, spec and their history alone');
  const h = (await orch.task.get({ task_id: 'pt-am' }));
  assert.strictEqual(h.policy_rev, 2);
});

test('policy: null on an amend hands the task back, and it is a revision too', async () => {
  await orch.task.create({ id: 'pt-null', spec: 'work', acceptance: PASS, policy: { fix: 'builder' } });
  const a = await orch.task.create({ id: 'pt-null', amend: true, policy: null });
  assert.deepStrictEqual([a.policy, a.policy_rev], [null, 2]);
  const b = await orch.task.create({ id: 'pt-null', amend: true, policy: { fix: 'builder' } });
  assert.strictEqual(b.policy_rev, 3);
});

test('an amend may carry an acceptance and a plan together, and the plan survives a later acceptance-only amend', async () => {
  await orch.task.create({ id: 'pt-both', spec: 'work', acceptance: PASS });
  const a = await orch.task.create({ id: 'pt-both', amend: true, acceptance: { commands: [] }, policy: { integrate: 'on_hold' } });
  assert.deepStrictEqual([a.policy, a.policy_rev, a.amended.length], [{ fix: 'builder', integrate: 'on_hold' }, 2, 1]);
  const b = await orch.task.create({ id: 'pt-both', amend: true, acceptance: PASS });
  assert.deepStrictEqual([b.policy, b.policy_rev], [a.policy, 2], 'carried, not revised');
});

test('a plan can be amended on a done task (its integrate step may still come), not on a cancelled one', async () => {
  const d = await orch.task.create({ id: 'pt-done', spec: 'work', acceptance: PASS });
  const wt = `${dir}/wt`; fs.mkdirSync(wt);
  await orch.task.evaluate({ task_id: d.id, worktree: wt });
  assert.strictEqual((await rowOf(d.id)).state, 'done');
  const a = await orch.task.create({ id: d.id, amend: true, policy: { integrate: 'on_hold' } });
  assert.strictEqual(a.policy_rev, 2);
  await orch.task.create({ id: 'pt-cx', spec: 'work', acceptance: PASS });
  await orch.task.cancel({ task_id: 'pt-cx' });
  await rejectsCode(orch.task.create({ id: 'pt-cx', amend: true, policy: null }), 'E_ARGS');
});

test('a refused amend writes nothing; an amend with neither acceptance nor policy is refused', async () => {
  await orch.task.create({ id: 'pt-ra', spec: 'work', acceptance: PASS, policy: { fix: 'builder' } });
  await rejectsCode(orch.task.create({ id: 'pt-ra', amend: true, policy: { cut: {} } }), 'E_ARGS');
  assert.strictEqual((await rowOf('pt-ra')).policy_rev, 1);
  await rejectsCode(orch.task.create({ id: 'pt-ra', amend: true }), 'E_ARGS');
  await rejectsCode(orch.task.create({ id: 'pt-ra', amend: true, policy: { fix: 'builder' }, depends_on: ['nope'] }), 'E_ARGS');
});

test('no caller names a policy step\'s stamps: acted_by, trigger and policy_rev are refused on create, in a batch and never reach the row', async () => {
  for (const k of ['acted_by', 'trigger', 'policy_rev']) {
    const v = k === 'trigger' ? { table: 'task', id: 'x', seq: 1 } : k === 'policy_rev' ? 9 : 'policy';
    await rejectsCode(orch.task.create({ id: 'pt-stamp', spec: 'x', acceptance: PASS, [k]: v }), 'E_ARGS');
    await rejectsCode(orch.task.create({ tasks: [{ id: 'pt-stamp', spec: 'x', acceptance: PASS, [k]: v }] }), 'E_ARGS');
    await rejectsCode(orch.task.create({ id: 'pt-am', amend: true, policy: { fix: 'builder' }, [k]: v }), 'E_ARGS');
  }
  assert.strictEqual(await orch.task.get({ task_id: 'pt-stamp' }).then(() => 'row', (e) => e.code), 'E_NOT_FOUND');
});

test('a worker can neither set nor amend a plan: the core refuses the role', async () => {
  await rejectsCode(worker.task.create({ id: 'pt-w', spec: 'x', acceptance: PASS, policy: { fix: 'builder' } }), 'E_ROLE');
  await rejectsCode(worker.task.create({ id: 'pt-am', amend: true, policy: null }), 'E_ROLE');
  assert.strictEqual((await rowOf('pt-am')).policy_rev, 2, 'the amend by a worker changed nothing');
});

test('the run\'s default is the launching process\'s to state: the orchestrator is refused, a bad default is refused', async () => {
  await rejectsCode(orch.run.attach({ adapter_pid: process.pid, policy_default: { fix: 'builder' } }), 'E_ROLE');
  await rejectsCode(operator.run.attach({ adapter_pid: process.pid, policy_default: { follow_up: 'wake' } }), 'E_ARGS');
  assert.deepStrictEqual(JSON.parse((await orch.run.get()).run.policy_default), DEFAULT, 'unchanged');
});
