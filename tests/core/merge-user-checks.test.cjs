'use strict';
// merge-user-checks.test.cjs — a merge into a branch the user owns, beyond the approval itself: the call's `checks` run before the branch
// moves and are part of what an approval is for; the temporary tree does not outlive a call that throws; and a task row only claims a
// branch for belay while it is that repository's branch and still holds the commit the task was cut from. Throwaway repositories only.

const { test, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, git, write, commit } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');
const G = core('git.cjs');
const W = core('methods-worktree.cjs');
const dir = sandbox();
const opened = [];
let seq = 0;

after(async () => {
  for (const s of opened) { await s.op.close(); await s.opRun.close(); await s.orch.shutdownOwner(); await s.orch.close(); }
  cleanup(dir);
});

async function scenario({ setting } = {}) {
  const data = `${dir}/data${++seq}`;
  const orch = await openCore({ dataDir: data, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  const opRun = await openCore({ dataDir: data, caller: callerFor('operator'), embed: false });
  await opRun.run.attach({ adapter_pid: process.pid, ...(setting ? { merge_into: setting } : {}) });
  const op = await openCore({ dataDir: data, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
  const s = { orch, op, opRun };
  opened.push(s);
  return s;
}

const ok = { argv: [process.execPath, '-e', '0'] };
const marker = (rel) => ({ argv: [process.execPath, '-e', `process.exit(require('fs').existsSync(${JSON.stringify(rel)}) ? 0 : 1)`] });

async function doneTask(s, repo, files, commands = [ok]) {
  const t = await s.orch.task.create({ spec: `write ${Object.keys(files).join(', ')}`, acceptance: { commands } });
  const w = (await s.op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  for (const [rel, text] of Object.entries(files)) write(w.path, rel, text);
  commit(w.path, `task ${t.id}`);
  const row = await s.orch.task.evaluate({ task_id: t.id });
  assert.strictEqual(row.state, 'done', JSON.stringify(row.results));
  return { id: row.id, branch: w.branch, path: w.path };
}
const trees = (repo) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;

test('the call\'s checks run on the merged head before a user branch moves: a failing one leaves it, a passing one lets it move', async () => {
  const s = await scenario({ setting: 'allowed' });
  const repo = makeRepo(dir);
  const t = await doneTask(s, repo, { 'a.txt': 'a\n' });
  git(repo, 'branch', 'feature/c');
  const before = git(repo, 'rev-parse', 'feature/c');
  const bad = await s.orch.integration.merge({ task_ids: [t.id], into: 'feature/c', checks: [marker('missing.txt')] });
  assert.strictEqual(bad.passed, false);
  assert.strictEqual(bad.applied, 'none');
  assert.strictEqual(git(repo, 'rev-parse', 'feature/c'), before, 'a failed check leaves the branch where it was');
  assert.ok(bad.checks.some((c) => c.source === 'integrate' && c.passed === false));
  const good = await s.orch.integration.merge({ task_ids: [t.id], into: 'feature/c', checks: [marker('a.txt')] });
  assert.strictEqual(good.passed, true);
  assert.strictEqual(good.applied, 'ref');
  assert.notStrictEqual(git(repo, 'rev-parse', 'feature/c'), before);
});

test('evaluate false with checks runs only the checks, on the user path too', async () => {
  const s = await scenario({ setting: 'allowed' });
  const repo = makeRepo(dir);
  const t = await doneTask(s, repo, { 'a.txt': 'a\n' });
  git(repo, 'branch', 'feature/d');
  const before = git(repo, 'rev-parse', 'feature/d');
  const bad = await s.orch.integration.merge({ task_ids: [t.id], into: 'feature/d', evaluate: false, checks: [marker('missing.txt')] });
  assert.strictEqual(bad.applied, 'none');
  assert.strictEqual(git(repo, 'rev-parse', 'feature/d'), before);
  assert.deepStrictEqual([...new Set(bad.checks.map((c) => c.source))], ['integrate'], 'the task\'s own command did not run');
  const good = await s.orch.integration.merge({ task_ids: [t.id], into: 'feature/d', evaluate: false, checks: [marker('a.txt')] });
  assert.strictEqual(good.applied, 'ref');
});

test('an approval is for the checks it was asked with: another list is another request', async () => {
  const s = await scenario();
  const repo = makeRepo(dir);
  const t = await doneTask(s, repo, { 'a.txt': 'a\n' });
  git(repo, 'branch', 'feature/e');
  const one = await s.orch.integration.merge({ task_ids: [t.id], into: 'feature/e', checks: [marker('a.txt')] });
  assert.strictEqual(one.state, 'awaiting_approval');
  assert.deepStrictEqual(one.request.integrate_checks.map((c) => c.argv[2]), [marker('a.txt').argv[2]], 'the request shows the checks');
  const again = await s.orch.integration.merge({ task_ids: [t.id], into: 'feature/e', checks: [marker('a.txt')] });
  assert.strictEqual(again.permission_id, one.permission_id, 'the same call finds the same request');
  const other = await s.orch.integration.merge({ task_ids: [t.id], into: 'feature/e', checks: [marker('b.txt')] });
  assert.notStrictEqual(other.permission_id, one.permission_id);
  await s.op.permission.decide({ id: one.permission_id, verdict: 'allow' });
  const e = await s.orch.integration.merge({ task_ids: [t.id], into: 'feature/e', checks: [marker('b.txt')], approval: one.permission_id }).then(() => null, (x) => x);
  assert.strictEqual(e && e.code, 'E_PRECONDITION', 'an approval given for other checks does not count');
});

test('a throw outside the guarded steps removes the temporary tree and closes the merging row', async () => {
  const s = await scenario({ setting: 'allowed' });
  const repo = makeRepo(dir);
  const t = await doneTask(s, repo, { 'a.txt': 'a\n' });
  git(repo, 'branch', 'feature/f');
  const n = trees(repo), head = git(repo, 'rev-parse', 'feature/f');
  // ownBoot throws after the tree is added and before the row is written; the last worktrees listing throws at the move.
  for (const [obj, name, passFirst] of [[W, 'ownBoot', 0], [G, 'worktrees', 2]]) {
    const keep = obj[name];
    let calls = 0;
    obj[name] = async (...a) => { calls += 1; if (calls !== passFirst + 1) return keep(...a); throw new Error(`injected ${name}`); };
    try {
      const e = await s.orch.integration.merge({ task_ids: [t.id], into: 'feature/f' }).then(() => null, (x) => x);
      assert.ok(e, `${name}: the call threw`);
    } finally { obj[name] = keep; }
    assert.strictEqual(trees(repo), n, `${name}: no temporary tree is left`);
    assert.strictEqual(git(repo, 'rev-parse', 'feature/f'), head);
    const merging = (await s.op.integration.list({})).integrations.filter((r) => r.state === 'merging');
    assert.deepStrictEqual(merging, [], `${name}: no row is left merging`);
  }
});

test('a task branch deleted outside belay and recreated from other history is the user\'s', async () => {
  const s = await scenario();
  const repo = makeRepo(dir);
  const t = await doneTask(s, repo, { 'a.txt': 'a\n' });
  const u = await doneTask(s, repo, { 'u.txt': 'u\n' });
  git(repo, 'worktree', 'remove', '--force', t.path);
  git(repo, 'branch', '-D', t.branch);
  const empty = git(repo, 'mktree');
  const sha = git(repo, 'commit-tree', empty, '-m', 'unrelated');
  git(repo, 'update-ref', `refs/heads/${t.branch}`, sha);
  const re = await s.orch.integration.merge({ task_ids: [u.id], into: t.branch });
  assert.strictEqual(re.state, 'awaiting_approval', 'the recreated name asks first');
});
