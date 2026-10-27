'use strict';
// merge-user-names.test.cjs — a merge into a user's branch, the second half: branch names that git treats as one (case), a staging
// name that is only a prefix, what an approval binds (the checks), what the operator reads in `belay pending`, and the prepared refs.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, git, write, commit, rejectsCode, stageRuns } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');
const dir = sandbox();
const opened = [];
let seq = 0;

after(async () => {
  for (const s of opened) { await s.op.close(); await s.opRun.close(); await s.orch.shutdownOwner(); await s.orch.close(); }
  cleanup(dir);
});

async function scenario({ setting, mode } = {}) {
  const data = `${dir}/data${++seq}`;
  const orch = await openCore({ dataDir: data, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  const opRun = await openCore({ dataDir: data, caller: callerFor('operator'), embed: false });
  await opRun.run.attach({ adapter_pid: process.pid, ...(setting ? { merge_into: setting } : {}), ...(mode ? { run_mode: mode } : {}) });
  const op = await openCore({ dataDir: data, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
  const s = { orch, op, opRun, data };
  opened.push(s);
  return s;
}

const exists = (rel) => ({ argv: [process.execPath, '-e', `require('fs').accessSync(${JSON.stringify(rel)})`] });

async function doneTask(s, repo, files, commands) {
  const t = await s.orch.task.create({ spec: `write ${Object.keys(files).join(', ')}`, acceptance: { commands } });
  const w = (await s.op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  for (const [rel, text] of Object.entries(files)) write(w.path, rel, text);
  commit(w.path, `task ${t.id}`);
  const row = await s.orch.task.evaluate({ task_id: t.id });
  assert.strictEqual(row.state, 'done', JSON.stringify(row.results));
  return row;
}

const names = (repo) => git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter((n) => n && !n.startsWith('belay/'));

for (const packed of [false, true]) {
  test(`a case variant of the checked-out branch is refused, and the branch is not moved (${packed ? 'packed' : 'loose'} refs)`, async () => {
    const s = await scenario({ setting: 'allowed' });
    const repo = makeRepo(dir);
    git(repo, 'config', 'core.ignorecase', 'true'); // refs fold case on this repository whatever the host
    const t = await doneTask(s, repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
    if (packed) git(repo, 'pack-refs', '--all');
    const before = git(repo, 'rev-parse', 'HEAD');
    const e = await rejectsCode(s.orch.integration.merge({ task_ids: [t.id], into: 'MAIN' }), 'E_ARGS');
    assert.match(e.message, /another spelling of the existing branch main/);
    assert.strictEqual(e.detail.existing, 'main');
    assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), before, 'the user checkout did not move');
    assert.deepStrictEqual(names(repo), ['main'], 'no second spelling was created beside it');
    assert.deepStrictEqual((await s.orch.integration.list({})).integrations, []);
    const op = await rejectsCode(s.op.integration.merge({ task_ids: [t.id], into: 'Main' }), 'E_ARGS');
    assert.strictEqual(op.detail.existing, 'main');
    // The exact spelling still works and is prepared, not merged in place.
    const row = await s.orch.integration.merge({ task_ids: [t.id], into: 'main' });
    assert.strictEqual(row.applied, 'prepared');
    assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), before);
  });
}

test('a staging name is belay\'s only for this run or a run the store knows; any other belay/integrate/ name is the user\'s', async () => {
  const s = await scenario({});
  const repo = makeRepo(dir);
  const t = await doneTask(s, repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  const mine = await s.orch.integration.merge({ task_ids: [t.id], into: 'belay/integrate/test-run' });
  assert.strictEqual(mine.state, 'evaluated');
  assert.strictEqual(mine.target, null, 'this run\'s staging branch needs nothing');
  await stageRuns(s.data, ['other-run']);
  const known = await s.orch.integration.merge({ task_ids: [t.id], into: 'belay/integrate/other-run' });
  assert.notStrictEqual(known.state, 'awaiting_approval', 'a run the store knows has its staging branch');
  const theirs = await s.orch.integration.merge({ task_ids: [t.id], into: 'belay/integrate/release' });
  assert.strictEqual(theirs.state, 'awaiting_approval', 'a user\'s belay/integrate/release is theirs');
});

test('a task branch whose branch was deleted is the user\'s again', async () => {
  const s = await scenario({});
  const repo = makeRepo(dir);
  const gone = await s.orch.task.create({ spec: 'gone', acceptance: { commands: [exists('x')] } });
  const wt = (await s.op.task.worktreeCreate({ task_id: gone.id, repo })).worktree;
  const removed = await s.op.task.worktreeRemove({ task_id: gone.id, delete_branch: true });
  assert.strictEqual(removed.worktree.branch_deleted, true);
  const t = await doneTask(s, repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  const r = await s.orch.integration.merge({ task_ids: [t.id], into: wt.branch });
  assert.strictEqual(r.state, 'awaiting_approval');
});

test('an approval binds evaluate and the exact checks: replaying it with evaluate false, or after the acceptance changed, is another request', async () => {
  const s = await scenario({});
  const repo = makeRepo(dir);
  const t = await doneTask(s, repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  git(repo, 'branch', 'feature/s1');
  const ask = await s.orch.integration.merge({ task_ids: [t.id], into: 'feature/s1' });
  assert.strictEqual(ask.request.evaluate, true);
  assert.deepStrictEqual(ask.request.checks, [{ argv: exists('a.txt').argv, cwd: null }]);
  await s.op.permission.decide({ id: ask.permission_id, verdict: 'allow' });
  const replay = await rejectsCode(s.orch.integration.merge({ task_ids: [t.id], into: 'feature/s1', evaluate: false, approval: ask.permission_id }), 'E_PRECONDITION');
  assert.match(replay.message, /another merge/);
  assert.strictEqual(git(repo, 'rev-parse', 'feature/s1'), git(repo, 'rev-parse', 'main'), 'the branch did not move');
  const row = await s.orch.integration.merge({ task_ids: [t.id], into: 'feature/s1', approval: ask.permission_id });
  assert.strictEqual(row.applied, 'ref');
  assert.strictEqual(row.checked, true);
  assert.strictEqual(row.note, undefined);
});

test('a user-branch merge that ran no check says so in the answer, under any setting', async () => {
  const s = await scenario({ setting: 'allowed' });
  const repo = makeRepo(dir);
  const t = await doneTask(s, repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  git(repo, 'branch', 'feature/s2');
  const row = await s.orch.integration.merge({ task_ids: [t.id], into: 'feature/s2', evaluate: false });
  assert.strictEqual(row.applied, 'ref');
  assert.strictEqual(row.checked, false);
  assert.strictEqual(row.note, 'no checks ran');
  const o = await scenario({});
  const t2 = await doneTask(o, repo, { 'b.txt': 'b\n' }, [exists('b.txt')]);
  git(repo, 'branch', 'feature/s3');
  const ask = await o.orch.integration.merge({ task_ids: [t2.id], into: 'feature/s3', evaluate: false });
  assert.deepStrictEqual([ask.request.evaluate, ask.request.checks], [false, []], 'the operator sees that no check will run');
  await o.op.permission.decide({ id: ask.permission_id, verdict: 'allow' });
  const done = await o.orch.integration.merge({ task_ids: [t2.id], into: 'feature/s3', evaluate: false, approval: ask.permission_id });
  assert.strictEqual(done.checked, false);
  assert.strictEqual(done.note, 'no checks ran');
});

test('belay pending shows a merge request whole: kind, branch, tasks with short commits, head before and the checks', async () => {
  const PEND = require('../../src/cli/cmd-pending.cjs');
  const s = await scenario({});
  const repo = makeRepo(dir);
  const t = await doneTask(s, repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  git(repo, 'branch', 'feature/p');
  const ask = await s.orch.integration.merge({ task_ids: [t.id], into: 'feature/p' });
  const [req] = (await s.op.permission.list({})).requests;
  assert.ok(req.input.length > 120, 'the raw input is longer than the table cell');
  const m = PEND.mergeOf(req);
  assert.strictEqual(m.kind, 'merge');
  assert.strictEqual(m.into, 'feature/p');
  assert.strictEqual(m.into_head, git(repo, 'rev-parse', 'feature/p'));
  assert.strictEqual(m.tasks[0].id, t.id);
  assert.strictEqual(m.tasks[0].sha.length, 12);
  const text = PEND.renderText([{ ...req, digest: 'merge into feature/p', merge: m }], false);
  for (const want of [ask.permission_id, 'kind: merge', 'into: feature/p', `head before: ${m.into_head}`, `${t.id}@${m.tasks[0].sha}`, 'checks:', 'accessSync("a.txt")']) assert.ok(text.includes(want), `${want}\n${text}`);
});

test('a prepared merge keeps a ref; a newer merge into the branch or removing the integration deletes it; the receipt lists what is left', async () => {
  const s = await scenario({ setting: 'allowed' });
  const repo = makeRepo(dir);
  const a = await doneTask(s, repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  const b = await doneTask(s, repo, { 'b.txt': 'b\n' }, [exists('b.txt')]);
  const has = (ref) => require('node:child_process').spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: repo, windowsHide: true }).status === 0;
  const first = await s.orch.integration.merge({ task_ids: [a.id], into: 'main' });
  assert.ok(has(first.prepared.ref));
  const second = await s.orch.integration.merge({ task_ids: [b.id], into: 'main' });
  assert.ok(has(second.prepared.ref));
  assert.ok(has(first.prepared.ref), 'a prepared merge that the newer one does not contain is kept: the user may still take it');
  assert.ok(!(await s.orch.integration.get({ id: first.id })).prepared.deleted_at);
  git(repo, 'merge', '--ff-only', first.prepared.sha); // the user takes the first
  const c = await doneTask(s, repo, { 'c.txt': 'c\n' }, [exists('c.txt')]);
  const third = await s.orch.integration.merge({ task_ids: [c.id], into: 'main' });
  assert.ok(has(third.prepared.ref));
  assert.ok(!has(first.prepared.ref), 'a merge that contains the first one drops its ref');
  assert.ok((await s.orch.integration.get({ id: first.id })).prepared.deleted_at);
  assert.ok(has(second.prepared.ref), 'the second is not contained, so it stays');
  assert.strictEqual((await s.orch.integration.get({ id: first.id })).prepared.deleted_at !== undefined, true);
  const left = await require('../../src/cli/run-prepared.cjs').left(s.orch, 'test-run');
  assert.deepStrictEqual(left.prepared_left.map((p) => p.integration_id).sort(), [second.id, third.id].sort());
  for (const r of [second, third]) {
    const removed = await s.op.integration.remove({ id: r.id });
    assert.strictEqual(removed.prepared_ref_deleted, true);
    assert.ok(!has(r.prepared.ref));
  }
  assert.deepStrictEqual(await require('../../src/cli/run-prepared.cjs').left(s.orch, 'test-run'), {});
  assert.ok(!fs.existsSync(second.worktree));
});
