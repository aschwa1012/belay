// task-evaluate.test.cjs — build step S3, ADR 0010 amendment 3. `task_evaluate` through the real
// adapter binary against a real core: the tool that lets an orchestrator over MCP write `done` and so
// clear a dependency. The owner is elected in this test process (as permit.test.cjs does), the adapter
// is a child process, and every child is stopped by its exact pid in teardown.
'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run

const test = require('node:test');
const assert = require('node:assert');

const { launch, sandboxDir } = require('./rpc.cjs');
const { openCore } = require('../../src/core/index.cjs');

const real = (o) => launch({ ...o, fake: false, noEmbed: true });

test('task_evaluate: over stdio as the orchestrator, returns the row; a done task lets its dependent be assigned', async (t) => {
  const data = `${sandboxDir('task-eval')}/store`;
  const owner = await openCore({ dataDir: data, caller: { role: 'orchestrator', run_id: 'run-te', pid: process.pid }, embed: false });
  t.after(async () => { if (owner.isOwner()) await owner.shutdownOwner().catch(() => {}); await owner.close(); });
  await owner.run.attach({ adapter_pid: process.pid });
  await owner.worker.write({ id: 'wk-te', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-te', last_event_at: Date.now() });

  const a = real({ role: 'orchestrator', run: 'run-te', data });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();
  assert.ok((await a.list()).some((x) => x.name === 'task_evaluate'), 'the orchestrator lists task_evaluate');

  const first = (await a.call('task_create', {
    spec: 'the first task', files_owned: ['te-first'],
    acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] },
  })).structuredContent;
  const second = (await a.call('task_create', { spec: 'waits on the first', files_owned: ['te-second'], depends_on: [first.id] })).structuredContent;
  assert.strictEqual(first.state, 'open');

  const before = await a.call('task_assign', { task_id: second.id, worker_id: 'wk-te' });
  assert.strictEqual(before.isError, true);
  assert.strictEqual(before.structuredContent.error, 'E_DEPENDENCY_OPEN');
  assert.strictEqual(before.structuredContent.detail.blocked_by, first.id);

  const ev = await a.call('task_evaluate', { task_id: first.id, worktree: data });
  assert.strictEqual(ev.isError, false, JSON.stringify(ev.structuredContent));
  const row = ev.structuredContent;
  assert.strictEqual(row.id, first.id);
  assert.strictEqual(row.state, 'done');
  assert.strictEqual(row.written_by, 'orchestrator');
  assert.strictEqual(row.results.passed, true);
  assert.strictEqual(row.results.checks[0].exit_code, 0);

  const after = await a.call('task_assign', { task_id: second.id, worker_id: 'wk-te' });
  assert.strictEqual(after.isError, false, JSON.stringify(after.structuredContent));
  assert.strictEqual(after.structuredContent.task.state, 'assigned');
  assert.strictEqual(after.structuredContent.new_lease.holder, 'wk-te');

  // (d3) F1: the adapter passes the core's code through unchanged, so a done task is refused E_TASK_DONE.
  const again = await a.call('task_assign', { task_id: first.id, worker_id: 'wk-te' });
  assert.strictEqual(again.isError, true);
  assert.strictEqual(again.structuredContent.error, 'E_TASK_DONE');
  assert.deepStrictEqual(again.structuredContent.detail, { task_id: first.id, state: 'done' });

  // SF4 (e13): a present base that is not a non-empty string is refused, null included, over stdio.
  for (const base of [null, '', 7]) {
    const bad = await a.call('task_evaluate', { task_id: first.id, worktree: data, base });
    assert.strictEqual(bad.isError, true, `base ${JSON.stringify(base)} must be refused`);
    assert.strictEqual(bad.structuredContent.error, 'E_ARGS');
    assert.match(bad.structuredContent.message, /base/);
    if (base !== '') { // an empty string is a string, so the core refuses that one
      assert.deepStrictEqual([bad.structuredContent.detail.tool, bad.structuredContent.detail.field], ['task_evaluate', 'base'],
        'refused at the adapter boundary, which names the tool and field, before the core');
    }
  }

  const missing = await a.call('task_evaluate', { task_id: 'no-such-task', worktree: data });
  assert.strictEqual(missing.isError, true);
  assert.strictEqual(missing.structuredContent.error, 'E_NOT_FOUND');
});

test('lease_release: a worker\'s result over MCP lands as handoff, and the orchestrator\'s task_list shows it', async (t) => {
  const data = `${sandboxDir('release-result')}/store`;
  const owner = await openCore({ dataDir: data, caller: { role: 'orchestrator', run_id: 'run-lr', pid: process.pid }, embed: false });
  t.after(async () => { if (owner.isOwner()) await owner.shutdownOwner().catch(() => {}); await owner.close(); });
  await owner.run.attach({ adapter_pid: process.pid });
  await owner.worker.write({ id: 'wk-lr', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-lr', last_event_at: Date.now() });
  const task = await owner.task.create({ spec: 'hand something back' });
  const lease = (await owner.task.assign({ task_id: task.id, worker_id: 'wk-lr' })).new_lease;

  const w = real({ role: 'worker', run: 'run-lr', workerId: 'wk-lr', data });
  t.after(async () => { await w.close(); w.kill(); });
  await w.initialize();
  const schema = (await w.list()).find((x) => x.name === 'lease_release').inputSchema;
  assert.strictEqual(schema.properties.result.type, 'object');

  // the adapter boundary refuses an array before the core sees it
  const arr = await w.call('lease_release', { lease_id: lease.id, result: ['holds'] });
  assert.strictEqual(arr.isError, true);
  assert.strictEqual(arr.structuredContent.error, 'E_ARGS');
  assert.deepStrictEqual([arr.structuredContent.detail.tool, arr.structuredContent.detail.field], ['lease_release', 'result']);

  const result = { branch: 'step/lr', head: 'deadbeef', verdict: 'holds', summary: 'nothing to add' };
  const rel = await w.call('lease_release', { lease_id: lease.id, result });
  assert.strictEqual(rel.isError, false, JSON.stringify(rel.structuredContent));
  assert.strictEqual(rel.structuredContent.state, 'released');
  assert.deepStrictEqual(rel.structuredContent.handoff.result, result);
  assert.strictEqual(rel.structuredContent.handoff.by, 'wk-lr');

  const a = real({ role: 'orchestrator', run: 'run-lr', data });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();
  // ADR 0058 amendment 3: a listing names the hand-back's fields; task_ids answers that task with the hand-back whole.
  const summary = (await a.call('task_list', {})).structuredContent.tasks.find((x) => x.id === task.id);
  assert.deepStrictEqual([summary.handoff.by, summary.handoff.fields, summary.handoff.result], ['wk-lr', Object.keys(result), undefined]);
  const listed = (await a.call('task_list', { task_ids: [task.id] })).structuredContent.tasks;
  assert.deepStrictEqual(listed.map((x) => x.id), [task.id], 'task_ids narrows the listing to that task');
  assert.deepStrictEqual(listed[0].handoff.result, result);
  assert.strictEqual(listed[0].handoff.lease_id, lease.id);
});

test('task_evaluate: not listed for a worker, and a worker call is refused', async (t) => {
  const data = `${sandboxDir('task-eval-w')}/store`;
  const w = real({ role: 'worker', run: 'run-tw', workerId: 'wk-tw', data });
  t.after(async () => { await w.close(); w.kill(); });
  await w.initialize();
  assert.ok(!(await w.list()).some((x) => x.name === 'task_evaluate'), 'a worker is not shown task_evaluate');
  const r = await w.call('task_evaluate', { task_id: 'anything', worktree: data });
  assert.strictEqual(r.isError, true);
  assert.strictEqual(r.structuredContent.error, 'E_ROLE');
  assert.match(r.structuredContent.message, /orchestrator/, 'the refusal names the role that can');
});
