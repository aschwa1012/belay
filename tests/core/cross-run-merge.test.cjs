'use strict';
require('../helpers/git-env.cjs'); // isolated git config for every fixture
// cross-run-merge.test.cjs — a run merges its own tasks into its own integrate branch; another run's task, or another run's
// integrate branch, is refused unless the run's spec set cross_run_merge. Only the launching process (operator role) states it.

const { test, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, write, commit, rejectsCode, stageRuns } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');
const dir = sandbox();
const opened = [];
let seq = 0;

after(async () => {
  for (const c of opened) { try { await c.shutdownOwner(); } catch { /* not the owner, or gone */ } }
  for (const c of opened) { try { await c.close(); } catch { /* closed */ } }
  cleanup(dir);
});

async function open(data, role, run_id) {
  const c = await openCore({ dataDir: data, caller: { role, run_id, pid: process.pid }, embed: false });
  opened.push(c);
  return c;
}

// Run "a" (the caller) and run "b", both registered; `cross` is run a's cross_run_merge as its launching process states it.
async function scenario(cross) {
  const data = `${dir}/data${++seq}`;
  const aOp = await open(data, 'operator', 'a');
  await aOp.run.attach({ adapter_pid: process.pid, ...(cross === undefined ? {} : { cross_run_merge: cross }) });
  await stageRuns(data, ['b']);
  const a = await open(data, 'orchestrator', 'a');
  const b = await open(data, 'orchestrator', 'b');
  const op = await open(data, 'operator', 'cli');
  return { a, b, op, aOp, data };
}

async function doneTask(orch, op, repo, rel) {
  const exists = { argv: [process.execPath, '-e', `require('fs').accessSync(${JSON.stringify(rel)})`] };
  const t = await orch.task.create({ spec: `write ${rel}`, acceptance: { commands: [exists] } });
  const w = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  write(w.path, rel, 'x\n');
  commit(w.path, `task ${t.id}`);
  const row = await orch.task.evaluate({ task_id: t.id });
  assert.strictEqual(row.state, 'done', JSON.stringify(row.results));
  return row;
}

test('a run merges its own task into its own integrate branch with the setting off', async () => {
  const s = await scenario();
  const repo = makeRepo(dir);
  const t = await doneTask(s.a, s.op, repo, 'own.txt');
  const row = await s.a.integration.merge({ task_ids: [t.id] });
  assert.strictEqual(row.into_branch, 'belay/integrate/a');
});

test('a task another run made is refused, naming the ids and the setting; nothing is written', async () => {
  const s = await scenario();
  const repo = makeRepo(dir);
  const t = await doneTask(s.b, s.op, repo, 'theirs.txt');
  const e = await rejectsCode(s.a.integration.merge({ task_ids: [t.id] }), 'E_PRECONDITION');
  assert.ok(e.message.includes(`${t.id} belongs to run b`), e.message);
  assert.match(e.message, /cross_run_merge: true/);
  assert.strictEqual(e.detail.setting, 'cross_run_merge');
  assert.deepStrictEqual((await s.a.integration.list({})).integrations, []);
});

test('another run\'s integrate branch is refused for the caller\'s own task', async () => {
  const s = await scenario();
  const repo = makeRepo(dir);
  const t = await doneTask(s.a, s.op, repo, 'mine.txt');
  const e = await rejectsCode(s.a.integration.merge({ task_ids: [t.id], into: 'belay/integrate/b' }), 'E_PRECONDITION');
  assert.match(e.message, /belay\/integrate\/b is run b's integrate branch/);
  assert.strictEqual(e.detail.into_run, 'b');
  assert.deepStrictEqual((await s.a.integration.list({})).integrations, []);
});

test('cross_run_merge: true lets the run merge a foreign task into another run\'s branch; the row records both runs', async () => {
  const s = await scenario(true);
  const repo = makeRepo(dir);
  const t = await doneTask(s.b, s.op, repo, 'both.txt');
  const row = await s.a.integration.merge({ task_ids: [t.id], into: 'belay/integrate/b' });
  assert.strictEqual(row.run_id, 'a');
  assert.strictEqual(row.into_branch, 'belay/integrate/b');
  assert.deepStrictEqual(row.task_ids, [t.id]);
});

test('the operator\'s own call is not a run\'s and is not refused', async () => {
  const s = await scenario();
  const repo = makeRepo(dir);
  const t = await doneTask(s.b, s.op, repo, 'op.txt');
  const row = await s.op.integration.merge({ task_ids: [t.id], into: 'belay/integrate/b' });
  assert.strictEqual(row.into_branch, 'belay/integrate/b');
});

test('only the launching process states cross_run_merge, and it must be a boolean', async () => {
  const s = await scenario();
  const e = await rejectsCode(s.a.run.attach({ adapter_pid: process.pid, cross_run_merge: true }), 'E_ROLE');
  assert.match(e.message, /never by the orchestrator/);
  await rejectsCode(s.aOp.run.attach({ adapter_pid: process.pid, cross_run_merge: 'yes' }), 'E_ARGS');
});
