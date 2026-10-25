'use strict';
// integration-force.test.cjs — a forced merge (ADR 0061, forced merge): `force` with a `reason` merges a task that is not done or
// whose checks fail, records `forced` on the integration row and shows it on the task. It is about checks only: a conflict still
// stops, and without a reason or without `force` nothing changes. Real git in throwaway repositories under the sandbox.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, write, commit, rejectsCode } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, op;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  op = await openCore({ dataDir: `${dir}/data`, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
});

after(async () => {
  await op.close();
  await orch.shutdownOwner();
  await orch.close();
  cleanup(dir);
});

const exists = (rel) => ({ argv: [process.execPath, '-e', `require('fs').accessSync(${JSON.stringify(rel)})`] });
const integrations = async () => (await orch.integration.list({})).integrations;

// A task in its own worktree with `files` committed; evaluated unless `evaluate` is false.
async function work(repo, files, commands, { evaluate = true } = {}) {
  const t = await orch.task.create({ spec: `write ${Object.keys(files).join(', ')}`, acceptance: { commands } });
  const w = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  for (const [rel, text] of Object.entries(files)) write(w.path, rel, text);
  commit(w.path, `task ${t.id}`);
  return evaluate ? orch.task.evaluate({ task_id: t.id }) : orch.task.get({ task_id: t.id });
}

test('force with a reason merges a task whose check fails, records forced, and task_list shows it', async () => {
  const repo = makeRepo(dir);
  const a = await work(repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  const b = await work(repo, { 'b.txt': 'b\n' }, [exists('later.txt')]);
  assert.strictEqual(a.state, 'done');
  assert.notStrictEqual(b.state, 'done');
  const before = (await integrations()).length;
  await rejectsCode(orch.integration.merge({ task_ids: [a.id, b.id] }), 'E_PRECONDITION');
  assert.strictEqual((await integrations()).length, before, 'the unforced refusal wrote nothing');

  const row = await orch.integration.merge({ task_ids: [a.id, b.id], force: true, reason: 'later.txt comes with task c' });
  assert.strictEqual(row.state, 'evaluated');
  assert.strictEqual(row.passed, false, 'the failing check is still reported as failed');
  assert.deepStrictEqual(row.merged.map((m) => m.task_id), [a.id, b.id]);
  assert.ok(fs.existsSync(path.join(row.worktree, 'b.txt')));
  assert.strictEqual(row.forced.reason, 'later.txt comes with task c');
  assert.strictEqual(row.forced.by, 'orchestrator');
  assert.ok(row.forced.at > 0);
  assert.deepStrictEqual(row.forced.task_ids, [b.id]);
  assert.strictEqual(row.forced.failing.length, 1);
  assert.ok(row.forced.failing[0].includes('later.txt'));
  assert.ok(row.checks.some((c) => !c.passed) && row.checks.some((c) => c.passed), 'every check was run and recorded');

  const tasks = (await orch.task.list({})).tasks;
  const bi = tasks.find((t) => t.id === b.id).integration;
  assert.strictEqual(bi.state, 'merged');
  assert.strictEqual(bi.forced, 'later.txt comes with task c');
  assert.deepStrictEqual(bi.failing, row.forced.failing);
  assert.strictEqual(tasks.find((t) => t.id === a.id).integration.forced, undefined, 'the task that needed no force is not marked');
  assert.strictEqual(tasks.find((t) => t.id === b.id).state, b.state, 'the task row itself is not changed');
});

test('a task never evaluated is merged at its branch head under force', async () => {
  const repo = makeRepo(dir);
  const t = await work(repo, { 'n.txt': 'n\n' }, [exists('n.txt')], { evaluate: false });
  await rejectsCode(orch.integration.merge({ task_ids: [t.id] }), 'E_PRECONDITION');
  const row = await orch.integration.merge({ task_ids: [t.id], force: true, reason: 'evaluated later, by the review' });
  assert.deepStrictEqual(row.merged.map((m) => m.task_id), [t.id]);
  assert.ok(fs.existsSync(path.join(row.worktree, 'n.txt')));
  assert.deepStrictEqual(row.forced.task_ids, [t.id]);
  assert.strictEqual((await orch.task.list({})).tasks.find((x) => x.id === t.id).integration.state, 'merged');
});

test('force without a reason, or with a blank, overlong or mistyped one, is E_ARGS and writes nothing', async () => {
  const repo = makeRepo(dir);
  const t = await work(repo, { 'r.txt': 'r\n' }, [exists('nowhere.txt')]);
  const before = (await integrations()).length;
  for (const extra of [{}, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(301) }, { reason: 7 }]) {
    await rejectsCode(orch.integration.merge({ task_ids: [t.id], force: true, ...extra }), 'E_ARGS');
  }
  await rejectsCode(orch.integration.merge({ task_ids: [t.id], force: 'yes', reason: 'r' }), 'E_ARGS');
  assert.strictEqual((await integrations()).length, before);
});

test('a conflict under force is still stopped: aborted, tree clean', async () => {
  const repo = makeRepo(dir);
  const a = await work(repo, { 'same.txt': 'one\n' }, [exists('same.txt')]);
  const b = await work(repo, { 'same.txt': 'two\n' }, [exists('absent.txt')]);
  assert.strictEqual(a.state, 'done');
  const row = await orch.integration.merge({ task_ids: [a.id, b.id], force: true, reason: 'b is expected to fail' });
  assert.strictEqual(row.state, 'conflict');
  assert.strictEqual(row.conflict.task_id, b.id);
  assert.deepStrictEqual(row.conflict.files, ['same.txt']);
  assert.strictEqual(row.conflict.tree_clean, true);
  assert.deepStrictEqual(row.merged.map((m) => m.task_id), [a.id]);
  assert.strictEqual(row.forced == null, true, 'b did not merge and a needed no force: nothing was forced');
  assert.deepStrictEqual(row.not_merged.map((m) => [m.task_id, m.reason]), [[b.id, 'conflict']]);
});

test('a cancelled task is not taken by force', async () => {
  const repo = makeRepo(dir);
  const t = await work(repo, { 'c.txt': 'c\n' }, [exists('c.txt')], { evaluate: false });
  await orch.task.cancel({ task_id: t.id, reason: 'not wanted' });
  await rejectsCode(orch.integration.merge({ task_ids: [t.id], force: true, reason: 'try' }), 'E_PRECONDITION');
});

test('force given when nothing needs it behaves as without it and records no forced', async () => {
  const repo = makeRepo(dir);
  const a = await work(repo, { 'p.txt': 'p\n' }, [exists('p.txt')]);
  const row = await orch.integration.merge({ task_ids: [a.id], force: true, reason: 'not needed' });
  assert.strictEqual(row.state, 'evaluated');
  assert.strictEqual(row.passed, true);
  assert.strictEqual(row.forced == null, true);
  assert.strictEqual((await orch.task.list({})).tasks.find((t) => t.id === a.id).integration.forced, undefined);
});
