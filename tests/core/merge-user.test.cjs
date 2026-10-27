'use strict';
// merge-user.test.cjs — a merge into a branch the user owns: who may ask, how approval is given and used, where the merge is built,
// and when the branch moves. Throwaway repositories and stores under the sandbox only; the user's checkout is the repository's own.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, git, write, commit, rejectsCode } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');
const MUG = core('merge-user-gate.cjs');
const dir = sandbox();
const opened = [];
let seq = 0;

after(async () => {
  for (const s of opened) { await s.op.close(); await s.opRun.close(); await s.orch.shutdownOwner(); await s.orch.close(); }
  cleanup(dir);
});

// One run in its own store: `setting` and `mode` are what the launching process (operator role) states on the attach.
async function scenario({ setting, mode } = {}) {
  const data = `${dir}/data${++seq}`;
  const orch = await openCore({ dataDir: data, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  const opRun = await openCore({ dataDir: data, caller: callerFor('operator'), embed: false });
  await opRun.run.attach({ adapter_pid: process.pid, ...(setting ? { merge_into: setting } : {}), ...(mode ? { run_mode: mode } : {}) });
  const op = await openCore({ dataDir: data, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
  const s = { orch, op, opRun };
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

const branch = (repo, name) => { git(repo, 'branch', name); return git(repo, 'rev-parse', name); };
const head = (repo, ref) => git(repo, 'rev-parse', ref);
const trees = (repo) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;

test('allowed: a branch that is not checked out is moved forward by a compare-and-swap, with the proof on the row', async () => {
  const s = await scenario({ setting: 'allowed' });
  const repo = makeRepo(dir);
  const t = await doneTask(s, repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  const before = branch(repo, 'feature/a');
  const trees0 = trees(repo);
  const row = await s.orch.integration.merge({ task_ids: [t.id], into: 'feature/a' });
  assert.strictEqual(row.state, 'evaluated');
  assert.strictEqual(row.passed, true);
  assert.strictEqual(row.target, 'user');
  assert.strictEqual(row.applied, 'ref');
  assert.strictEqual(row.head_before, before);
  assert.strictEqual(row.head_after, head(repo, 'feature/a'));
  assert.notStrictEqual(row.head_after, before);
  assert.deepStrictEqual(row.approver, { kind: 'setting', setting: 'merge_into=allowed' });
  assert.deepStrictEqual(row.merge_commits, [row.head_after]);
  assert.strictEqual(git(repo, 'rev-parse', `${row.head_after}^1`), before, 'a merge on top of the old head: a fast-forward, never a rewrite');
  assert.ok(row.removed_at && !fs.existsSync(row.worktree), 'the temporary tree is gone');
  assert.strictEqual(trees(repo), trees0);
  assert.strictEqual(head(repo, 'main'), head(repo, 'HEAD'), 'main did not move');
});

test('ask, headless: the first call writes a merge request and no ref; the operator decides it; the second call carries the id, once', async () => {
  const s = await scenario({ setting: 'ask', mode: 'headless' });
  const repo = makeRepo(dir);
  const t = await doneTask(s, repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  const before = branch(repo, 'feature/h');
  const first = await s.orch.integration.merge({ task_ids: [t.id], into: 'feature/h' });
  assert.strictEqual(first.state, 'awaiting_approval');
  assert.strictEqual(head(repo, 'feature/h'), before, 'no ref was touched');
  assert.strictEqual((await s.orch.integration.list({})).integrations.length, 0, 'no integration row yet');
  const again = await s.orch.integration.merge({ task_ids: [t.id], into: 'feature/h' });
  assert.strictEqual(again.permission_id, first.permission_id, 'asking again finds the same request');
  const [req] = (await s.op.permission.list({})).requests;
  assert.strictEqual(req.id, first.permission_id);
  assert.strictEqual(req.kind, 'merge');
  assert.strictEqual(req.tool, 'integrate');
  assert.strictEqual(req.worker_id, null);
  await rejectsCode(s.orch.integration.merge({ task_ids: [t.id], into: 'feature/h', approval: first.permission_id }), 'E_PRECONDITION'); // not decided
  await rejectsCode(s.orch.permission.decide({ id: first.permission_id, verdict: 'allow' }), 'E_ROLE');
  await rejectsCode(s.orch.permission.decide({ id: first.permission_id, verdict: 'deny' }), 'E_ROLE');
  const decided = await s.op.permission.decide({ id: first.permission_id, verdict: 'allow' });
  assert.strictEqual(decided.verdict.state, 'allowed');
  const row = await s.orch.integration.merge({ task_ids: [t.id], into: 'feature/h', approval: first.permission_id });
  assert.strictEqual(row.applied, 'ref');
  assert.deepStrictEqual(row.approver, { kind: 'permission', id: first.permission_id, verdict_by: decided.verdict.verdict_by });
  assert.ok(row.approver.verdict_by.startsWith('operator:'));
  const reuse = await rejectsCode(s.orch.integration.merge({ task_ids: [t.id], into: 'feature/h', approval: first.permission_id }), 'E_PRECONDITION');
  assert.match(reuse.message, /has been used/);
});

test('an approval is matched exactly: another task set, another branch, or a branch that moved is refused; a denial is final', async () => {
  const s = await scenario({});
  const repo = makeRepo(dir);
  const a = await doneTask(s, repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  const b = await doneTask(s, repo, { 'b.txt': 'b\n' }, [exists('b.txt')]);
  branch(repo, 'feature/m');
  branch(repo, 'feature/n');
  const ask = await s.orch.integration.merge({ task_ids: [a.id], into: 'feature/m' });
  await s.op.permission.decide({ id: ask.permission_id, verdict: 'allow' });
  for (const wrong of [{ task_ids: [a.id, b.id], into: 'feature/m' }, { task_ids: [a.id], into: 'feature/n' }, { task_ids: [b.id], into: 'feature/m' }]) {
    const e = await rejectsCode(s.orch.integration.merge({ ...wrong, approval: ask.permission_id }), 'E_PRECONDITION');
    assert.match(e.message, /another merge/);
  }
  const other = git(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'moved');
  git(repo, 'update-ref', 'refs/heads/feature/m', other);
  const moved = await rejectsCode(s.orch.integration.merge({ task_ids: [a.id], into: 'feature/m', approval: ask.permission_id }), 'E_PRECONDITION');
  assert.match(moved.message, /another merge/);
  assert.strictEqual(head(repo, 'feature/m'), other, 'the branch is as the user left it');
  const second = await s.orch.integration.merge({ task_ids: [a.id], into: 'feature/m' });
  assert.notStrictEqual(second.permission_id, ask.permission_id, 'the moved branch is a new request');
  await s.op.permission.decide({ id: second.permission_id, verdict: 'deny', reason: 'not now' });
  const denied = await rejectsCode(s.orch.integration.merge({ task_ids: [a.id], into: 'feature/m', approval: second.permission_id }), 'E_PRECONDITION');
  assert.match(denied.message, /denied/);
  await rejectsCode(s.orch.integration.merge({ task_ids: [a.id], into: 'feature/m', approval: 'no-such-id' }), 'E_NOT_FOUND');
});

test('ask, interactive: the call must say it was approved in chat, and the row says so; a headless run ignores that claim', async () => {
  const s = await scenario({ setting: 'ask', mode: 'interactive' });
  const repo = makeRepo(dir);
  const t = await doneTask(s, repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  const before = branch(repo, 'feature/i');
  const e = await rejectsCode(s.orch.integration.merge({ task_ids: [t.id], into: 'feature/i' }), 'E_PRECONDITION');
  assert.match(e.message, /approved_in_chat/);
  assert.strictEqual(head(repo, 'feature/i'), before);
  const row = await s.orch.integration.merge({ task_ids: [t.id], into: 'feature/i', approved_in_chat: true });
  assert.strictEqual(row.applied, 'ref');
  assert.strictEqual(row.approver.kind, 'chat');
  assert.match(row.approver.established_by, /orchestrator/);
  const h = await scenario({ setting: 'ask', mode: 'headless' });
  const repo2 = makeRepo(dir);
  const t2 = await doneTask(h, repo2, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  branch(repo2, 'feature/i');
  const r = await h.orch.integration.merge({ task_ids: [t2.id], into: 'feature/i', approved_in_chat: true });
  assert.strictEqual(r.state, 'awaiting_approval', 'a headless run derives its mode from its row, not from what a call claims');
});

test('belay branches need nothing; a name under belay/ that no task records is still the user\'s', async () => {
  const s = await scenario({});
  const repo = makeRepo(dir);
  const t = await doneTask(s, repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  const row = await s.orch.integration.merge({ task_ids: [t.id] });
  assert.strictEqual(row.state, 'evaluated');
  assert.strictEqual(row.target, null, 'staging is not a merge into the user\'s branch');
  assert.strictEqual(row.approver, null);
});

test('what counts as a user branch is read from the task rows and the integration name', async () => {
  const s = await scenario({});
  const repo = makeRepo(dir);
  const open = await s.orch.task.create({ spec: 'x', acceptance: { commands: [exists('x')] } });
  const wt = (await s.op.task.worktreeCreate({ task_id: open.id, repo })).worktree;
  const done = await doneTask(s, repo, { 'q.txt': 'q\n' }, [exists('q.txt')]);
  // A branch some task row records as its own is belay's: merging into it needs no approval.
  const staged = await s.orch.integration.merge({ task_ids: [done.id], into: wt.branch });
  assert.notStrictEqual(staged.state, 'awaiting_approval');
  assert.strictEqual(staged.target, null);
  const named = await s.orch.integration.merge({ task_ids: [done.id], into: 'belay/not-an-integration-branch' });
  assert.strictEqual(named.state, 'awaiting_approval', 'a prefix is a name anyone can type');
  const E = { store: { p: () => ({ all: () => [] }) } };
  assert.strictEqual(MUG.isUserBranch(E, repo, 'belay/integrate/any-run'), false);
  assert.strictEqual(MUG.isUserBranch(E, repo, 'main'), true);
});

test('a checked-out dirty branch is refused before any request is raised', async () => {
  const s = await scenario({});
  const repo = makeRepo(dir);
  const t = await doneTask(s, repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  write(repo, 'loose.txt', 'dirty\n');
  const e = await rejectsCode(s.orch.integration.merge({ task_ids: [t.id], into: 'main' }), 'E_PRECONDITION');
  assert.deepStrictEqual(e.detail.dirty, ['loose.txt']);
  assert.strictEqual(e.detail.path, repo);
  assert.deepStrictEqual((await s.op.permission.list({ states: ['pending', 'allowed', 'denied'] })).requests, []);
  assert.strictEqual((await s.orch.integration.list({})).integrations.length, 0);
});

test('a clean checked-out branch is not merged in: the merge is prepared, the checkout is untouched, and the line works', async () => {
  const s = await scenario({ setting: 'allowed' });
  const repo = makeRepo(dir);
  const t = await doneTask(s, repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  const snap = () => [git(repo, 'rev-parse', 'HEAD'), git(repo, 'ls-files', '-s'), git(repo, 'status', '--porcelain'), fs.readdirSync(repo).sort().join(','), fs.readFileSync(path.join(repo, 'base/keep.txt'), 'utf8')];
  const before = snap();
  const row = await s.orch.integration.merge({ task_ids: [t.id], into: 'main' });
  assert.strictEqual(row.state, 'evaluated');
  assert.strictEqual(row.applied, 'prepared');
  assert.deepStrictEqual(snap(), before, 'HEAD, index and files are as the user left them');
  assert.strictEqual(row.head_after, row.head_before);
  assert.strictEqual(row.prepared.checkout, repo);
  assert.strictEqual(row.prepared.sha, row.head_sha);
  assert.strictEqual(row.prepared.ff_command, `git merge --ff-only ${row.prepared.sha}`);
  assert.strictEqual(head(repo, row.prepared.ref), row.prepared.sha, 'the commit is kept under a ref of belay\'s own');
  assert.deepStrictEqual(row.merged, [], 'nothing has landed yet');
  assert.deepStrictEqual((await s.orch.task.get({ task_id: t.id })).integration.state, 'prepared');
  assert.ok(!fs.existsSync(row.worktree));
  git(repo, 'merge', '--ff-only', row.prepared.sha);
  assert.ok(fs.existsSync(path.join(repo, 'a.txt')), 'the user takes it with the line belay gave');
});

test('a branch that moves while the merge is built is left as the user has it', async () => {
  const s = await scenario({ setting: 'allowed' });
  const repo = makeRepo(dir);
  branch(repo, 'feature/race');
  const racer = git(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'racer');
  const mover = { argv: [process.execPath, '-e', `const c=process.cwd().split(String.fromCharCode(92)).join('/');if(c.includes('/merge-'))require('child_process').execFileSync('git',['-C',${JSON.stringify(repo)},'update-ref','refs/heads/feature/race','${racer}'])`] };
  const t = await doneTask(s, repo, { 'a.txt': 'a\n' }, [exists('a.txt'), mover]);
  assert.strictEqual(head(repo, 'feature/race'), head(repo, 'main'), 'the mover ran only in the merge tree');
  const row = await s.orch.integration.merge({ task_ids: [t.id], into: 'feature/race' });
  assert.strictEqual(head(repo, 'feature/race'), racer, 'the compare-and-swap refused, so the branch is as the user left it');
  assert.strictEqual(row.state, 'failed');
  assert.strictEqual(row.applied, 'none');
  assert.match(row.error.message, /moved while the merge was built/);
  assert.strictEqual(row.error.unapplied[0].task_id, t.id);
  assert.ok(!fs.existsSync(row.worktree));
});

test('a conflict aborts: the branch is untouched, the tree is gone, and the row names the task and the files', async () => {
  const s = await scenario({ setting: 'allowed' });
  const repo = makeRepo(dir);
  const a = await doneTask(s, repo, { 'base/keep.txt': 'from a\n' }, [exists('base/keep.txt')]);
  const b = await doneTask(s, repo, { 'base/keep.txt': 'from b\n' }, [exists('base/keep.txt')]);
  const before = branch(repo, 'feature/c');
  const row = await s.orch.integration.merge({ task_ids: [a.id, b.id], into: 'feature/c' });
  assert.strictEqual(row.state, 'conflict');
  assert.strictEqual(row.conflict.task_id, b.id);
  assert.deepStrictEqual(row.conflict.files, ['base/keep.txt']);
  assert.strictEqual(row.conflict.aborted, true);
  assert.strictEqual(row.applied, 'none');
  assert.strictEqual(head(repo, 'feature/c'), before);
  assert.strictEqual(row.head_after, before);
  assert.ok(!fs.existsSync(row.worktree));
  assert.deepStrictEqual(row.merged, []);
});

test('a failed check leaves the branch untouched, and says which merge it did not apply', async () => {
  const s = await scenario({ setting: 'allowed' });
  const repo = makeRepo(dir);
  const notBoth = { argv: [process.execPath, '-e', "const f=require('fs');process.exit(f.existsSync('a.txt')&&f.existsSync('b.txt')?1:0)"] };
  const a = await doneTask(s, repo, { 'a.txt': 'a\n' }, [notBoth]);
  const b = await doneTask(s, repo, { 'b.txt': 'b\n' }, [notBoth]);
  const before = branch(repo, 'feature/k');
  const row = await s.orch.integration.merge({ task_ids: [a.id, b.id], into: 'feature/k' });
  assert.strictEqual(row.passed, false);
  assert.strictEqual(row.applied, 'none');
  assert.strictEqual(head(repo, 'feature/k'), before);
  assert.strictEqual(row.head_after, before);
  assert.strictEqual(row.error.merge_head, row.head_sha);
  assert.deepStrictEqual(row.error.unapplied.map((m) => m.task_id), [a.id, b.id]);
  assert.deepStrictEqual(row.merged, []);
  assert.ok(!fs.existsSync(row.worktree));
});

test('force is refused for a user branch, and a new user branch is a request like any other', async () => {
  const s = await scenario({ setting: 'allowed' });
  const repo = makeRepo(dir);
  const open = await s.orch.task.create({ spec: 'open', acceptance: { commands: [exists('x')] } });
  await s.op.task.worktreeCreate({ task_id: open.id, repo });
  const e = await rejectsCode(s.orch.integration.merge({ task_ids: [open.id], into: 'feature/f', force: true, reason: 'expected' }), 'E_PRECONDITION');
  assert.match(e.message, /force is not accepted/);
  const h = await scenario({ setting: 'ask', mode: 'headless' });
  const t = await doneTask(h, repo, { 'n.txt': 'n\n' }, [exists('n.txt')]);
  const ask = await h.orch.integration.merge({ task_ids: [t.id], into: 'feature/new' });
  assert.strictEqual(ask.state, 'awaiting_approval');
  assert.strictEqual(ask.request.into_head, null);
  assert.strictEqual(spawnOk(repo, 'feature/new'), false, 'asking creates no branch');
  await h.op.permission.decide({ id: ask.permission_id, verdict: 'allow' });
  const row = await h.orch.integration.merge({ task_ids: [t.id], into: 'feature/new', approval: ask.permission_id });
  assert.strictEqual(row.applied, 'ref');
  assert.strictEqual(row.head_before, null);
  assert.strictEqual(head(repo, 'feature/new'), row.head_after);
  assert.ok(!fs.existsSync(row.worktree));
});

function spawnOk(repo, name) { const r = require('node:child_process').spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd: repo, windowsHide: true }); return r.status === 0; }

test('the operator needs no approval for their own merge; the orchestrator cannot state the setting or the mode', async () => {
  const s = await scenario({});
  const repo = makeRepo(dir);
  const t = await doneTask(s, repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  branch(repo, 'feature/o');
  const row = await s.op.integration.merge({ task_ids: [t.id], into: 'feature/o' });
  assert.deepStrictEqual(row.approver, { kind: 'operator' });
  assert.strictEqual(row.applied, 'ref');
  await rejectsCode(s.orch.run.attach({ adapter_pid: process.pid, merge_into: 'allowed' }), 'E_ROLE');
  await rejectsCode(s.orch.run.attach({ adapter_pid: process.pid, run_mode: 'interactive' }), 'E_ROLE');
  await rejectsCode(s.opRun.run.attach({ adapter_pid: process.pid, merge_into: 'sometimes' }), 'E_ARGS');
  const run = await s.orch.run.attach({ adapter_pid: process.pid });
  assert.strictEqual(run.run.merge_into, null, 'an attach that states nothing carries the run\'s setting (here, none stated: ask)');
});

test('the new modules require no embedder, and the spec key is known and checked', () => {
  const src = path.join(__dirname, '..', '..', 'src');
  for (const f of ['core/merge-user.cjs', 'core/merge-user-gate.cjs']) {
    const reqs = [...fs.readFileSync(path.join(src, f), 'utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    assert.ok(!reqs.some((r) => /embedder/.test(r)), f);
  }
  const { KNOWN_KEYS } = require('../../src/cli/run-spec.cjs');
  const { parseLevers } = require('../../src/cli/run-levers.cjs');
  assert.ok(KNOWN_KEYS.has('merge_into'));
  assert.ok(!('merge_into' in parseLevers({})), 'unset: the levers are as they always were');
  assert.strictEqual(parseLevers({ merge_into: 'allowed' }).merge_into, 'allowed');
  assert.strictEqual(parseLevers({ merge_into: 'ask' }).merge_into, 'ask');
  assert.match(parseLevers({ merge_into: 'yes' }).error, /merge_into must be/);
});
