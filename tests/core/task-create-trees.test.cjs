'use strict';
// task-create-trees.test.cjs — task.create with `worktree` and the `tasks` batch (ADR 0062): the trees are made first, then every
// row is written in one transaction, and a refusal at any point removes every tree the call made. Real git in throwaway
// repositories under the test's sandbox, a real owner, and a seam that stalls the call between the trees and the write.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, git, write, commit, rejectsCode } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');
const BATCH = core('methods-task-batch.cjs');
const W = core('methods-worktree.cjs');
const H = core('git-hooks.cjs');

let dir, orch, repo;
let n = 0;
const spec = () => ({ spec: `work ${++n}`, acceptance: { files_within_owned: true } });
const branches = (r = repo) => git(r, 'branch', '--list', 'belay/*').split('\n').map((s) => s.replace(/^[*+ ]+/, '').trim()).filter(Boolean);
const trees = (r = repo) => git(r, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;
const rowCount = async () => (await orch.task.list({})).tasks.length;
const treePath = (id) => `${path.dirname(repo).split('\\').join('/')}/${path.basename(repo)}.worktrees/${id}`;

before(async () => {
  process.env.BELAY_TEST_SEAMS = '1'; // the batch's seams are honoured only with this set
  dir = sandbox();
  repo = makeRepo(dir);
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, project_dir: repo, max_fix_rounds: 1 });
});

after(async () => {
  delete process.env.BELAY_TEST_SEAMS;
  BATCH.seam.afterTree = null;
  await orch.shutdownOwner();
  await orch.close();
  cleanup(dir);
});

test('worktree: true makes the tree first and the row carries it; a ref cuts the tree from that ref', async () => {
  const head = git(repo, 'rev-parse', 'HEAD');
  write(repo, 'later.txt', 'later\n');
  commit(repo, 'later');
  const a = await orch.task.create({ ...spec(), worktree: true });
  assert.strictEqual(a.worktree.branch, `belay/${a.id}`);
  assert.strictEqual(a.worktree.base_ref, 'HEAD');
  assert.strictEqual(a.worktree.base_sha, git(repo, 'rev-parse', 'HEAD'));
  assert.strictEqual(a.worktree.path, treePath(a.id));
  assert.strictEqual(git(a.worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD'), a.worktree.branch);
  assert.ok(fs.lstatSync(path.join(a.worktree.path, 'node_modules')).isSymbolicLink(), 'the default junction is made');
  assert.strictEqual((await orch.task.get({ task_id: a.id })).worktree.path, a.worktree.path, 'the stored row carries it');
  const b = await orch.task.create({ ...spec(), worktree: head });
  assert.strictEqual(b.worktree.base_sha, head);
  assert.strictEqual(b.worktree.base_ref, head);
  assert.ok(!fs.existsSync(path.join(b.worktree.path, 'later.txt')), 'cut from the older commit');
});

test('a bad argument is refused before any git: no tree, no branch, no row', async () => {
  const before0 = [trees(), branches().length, await rowCount()];
  for (const bad of [{ worktree: 'x', tree_of: 'whatever' }, { worktree: '' }, { worktree: 5 }, { worktree: true, amend: true, id: 'a' }]) {
    await rejectsCode(orch.task.create({ ...spec(), ...bad }), 'E_ARGS');
  }
  await rejectsCode(orch.task.create({ tasks: [] }), 'E_ARGS');
  await rejectsCode(orch.task.create({ tasks: Array.from({ length: 11 }, spec) }), 'E_ARGS');
  await rejectsCode(orch.task.create({ tasks: [spec()], spec: 'beside' }), 'E_ARGS');
  await rejectsCode(orch.task.create({ tasks: [{ ...spec(), amend: true }] }), 'E_ARGS');
  await rejectsCode(orch.task.create({ tasks: [{ ...spec(), worktree: true }, { acceptance: {} , worktree: true }] }), 'E_ARGS');
  await rejectsCode(orch.task.create({ tasks: [{ ...spec(), id: 'dup-1', worktree: true }, { ...spec(), id: 'dup-1', worktree: true }] }), 'E_ARGS');
  await rejectsCode(orch.task.create({ tasks: Array.from({ length: BATCH.MAX_BATCH_TREES + 1 }, () => ({ ...spec(), worktree: true })) }), 'E_ARGS');
  assert.deepStrictEqual([trees(), branches().length, await rowCount()], before0);
});

test('a batch writes every row with its tree and answers each one in order', async () => {
  const out = await orch.task.create({ tasks: [{ ...spec(), id: 'ok-1', files_owned: ['ok/a'], worktree: true }, { ...spec(), id: 'ok-2', worktree: true }, { ...spec(), id: 'ok-3', depends_on: ['ok-1'] }] });
  assert.deepStrictEqual(out.tasks.map((t) => t.id), ['ok-1', 'ok-2', 'ok-3']);
  assert.ok(out.tasks[0].worktree.path && out.tasks[1].worktree.path);
  assert.ok(!out.tasks[2].worktree, 'an item without worktree has no tree');
  for (const t of out.tasks.slice(0, 2)) assert.strictEqual((await orch.task.get({ task_id: t.id })).worktree.path, t.worktree.path);
  assert.deepStrictEqual((await orch.task.get({ task_id: 'ok-3' })).depends_on, ['ok-1'], 'a later item may depend on an earlier one by its id');
});

test('a refusal found before git (overlap, fix rounds, validation) leaves no tree and no branch, and writes nothing', async () => {
  const holder = await orch.task.create({ ...spec(), files_owned: ['shared/x'] });
  const work = await orch.task.create({ ...spec(), files_owned: ['w/y'] });
  await orch.task.create({ ...spec(), repairs: work.id, files_owned: ['w/y2'] }); // the run's one fix round
  const cases = [
    [[{ ...spec(), worktree: true }, { ...spec(), files_owned: ['shared/x'] }], 'E_FILES_OVERLAP'],
    [[{ ...spec(), worktree: true }, { ...spec(), repairs: work.id }], 'E_FIX_ROUNDS'],
    [[{ ...spec(), worktree: true }, { ...spec(), depends_on: ['no-such-task'] }], 'E_NOT_FOUND'],
    [[{ ...spec(), worktree: true }, { ...spec(), acceptance: { verdict: false } }], 'E_ARGS'],
    [[{ ...spec(), worktree: true }, { ...spec(), id: holder.id }], 'E_ARGS'],
  ];
  const before0 = [trees(), branches(), await rowCount()];
  for (const [tasks, code] of cases) {
    const e = await rejectsCode(orch.task.create({ tasks }), code).catch((x) => { throw new Error(code + ': ' + x.message); });
    assert.strictEqual(e.detail && e.detail.rollback, undefined, `${code}: nothing was made, so there is nothing to roll back`);
    assert.deepStrictEqual([trees(), branches(), await rowCount()], before0, code);
  }
  // the single form too: a refused create with worktree makes no tree
  await rejectsCode(orch.task.create({ ...spec(), repairs: work.id, worktree: true }), 'E_FIX_ROUNDS');
  assert.deepStrictEqual([trees(), branches(), await rowCount()], before0);
});

test('a fault after tree 2 of 3 removes trees 1 and 2, newest first, with receipts that name each path as gone', async () => {
  const ids = ['ft-1', 'ft-2', 'ft-3'];
  const before0 = [trees(), branches(), await rowCount()];
  BATCH.seam.afterTree = async (i) => { if (i === 1) throw Object.assign(new Error('injected after tree 2'), { code: 'E_INTERNAL' }); };
  let e;
  try { e = await rejectsCode(orch.task.create({ tasks: ids.map((id) => ({ ...spec(), id, worktree: true })) }), 'E_INTERNAL'); } finally { BATCH.seam.afterTree = null; }
  assert.match(e.message, /injected after tree 2/, 'the original error is returned');
  assert.deepStrictEqual(e.detail.rollback.map((r) => r.task_id), ['ft-2', 'ft-1']);
  for (const r of e.detail.rollback) {
    assert.ok(r.worktree_removed && r.branch_deleted && r.path_gone, JSON.stringify(r));
    assert.ok(!fs.existsSync(r.path));
  }
  assert.strictEqual(e.detail.rollback_incomplete, undefined);
  assert.deepStrictEqual([trees(), branches(), await rowCount()], before0);
  // the ids were released: the same call now succeeds
  const again = await orch.task.create({ tasks: ids.map((id) => ({ ...spec(), id, worktree: true })) });
  assert.strictEqual(again.tasks.length, 3);
});

test('a refusal inside the transaction (the store changed while the trees were made) removes every tree', async () => {
  const before0 = [trees(), branches(), await rowCount()];
  // two shared-tree tasks that agree on a file pass the dry run; a third task landing meanwhile makes the second refuse
  BATCH.seam.afterTree = async (i) => { if (i === 0) await orch.task.create({ ...spec(), id: 'lands-meanwhile', files_owned: ['race/f'] }); };
  let e;
  try {
    e = await rejectsCode(orch.task.create({ tasks: [{ ...spec(), id: 'tx-1', worktree: true }, { ...spec(), id: 'tx-2', files_owned: ['race/f'] }] }), 'E_FILES_OVERLAP');
  } finally { BATCH.seam.afterTree = null; }
  assert.deepStrictEqual(e.detail.rollback.map((r) => r.task_id), ['tx-1']);
  assert.ok(e.detail.rollback[0].path_gone && e.detail.rollback[0].branch_deleted);
  assert.deepStrictEqual([trees(), branches()], before0.slice(0, 2));
  assert.strictEqual(await rowCount(), before0[2] + 1, 'only the task that landed meanwhile; no row of the refused batch');
});

test('a hook that rejects tree 3 removes trees 1 and 2 and the half-made tree 3', async () => {
  fs.writeFileSync(path.join(repo, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\ncase "$PWD" in *hk-3*) echo "no third tree" >&2; exit 1;; esac\nexit 0\n');
  const before0 = [trees(), branches(), await rowCount()];
  try {
    const e = await rejectsCode(orch.task.create({ tasks: ['hk-1', 'hk-2', 'hk-3'].map((id) => ({ ...spec(), id, worktree: true })) }), 'E_GIT');
    assert.match(e.message, /post-checkout/);
    assert.deepStrictEqual(e.detail.rollback.map((r) => r.task_id), ['hk-3', 'hk-2', 'hk-1']);
    assert.ok(e.detail.rollback.every((r) => r.path_gone), JSON.stringify(e.detail.rollback));
  } finally { fs.rmSync(path.join(repo, '.git', 'hooks', 'post-checkout')); }
  assert.deepStrictEqual([trees(), branches(), await rowCount()], before0);
});

test('explicit ids make a retry refuse E_EXISTS naming the leftover, and a foreign branch is never deleted', async () => {
  git(repo, 'branch', 'belay/orphan-2'); // what a crash between the trees and the write leaves
  const before0 = [trees(), branches(), await rowCount()];
  const e = await rejectsCode(orch.task.create({ tasks: ['orphan-1', 'orphan-2'].map((id) => ({ ...spec(), id, worktree: true })) }), 'E_EXISTS');
  assert.strictEqual(e.detail.branch, 'belay/orphan-2');
  assert.deepStrictEqual(e.detail.rollback, [], 'the git-only checks ran before any tree, so nothing was made to remove');
  assert.deepStrictEqual([trees(), branches(), await rowCount()], before0, 'the foreign branch is still there, and nothing else');
  assert.ok(branches().includes('belay/orphan-2'));
});

test('the ADR 0059 rule with own trees: trees on one file are all written with the overlap reported; shared tasks still refuse each other', async () => {
  const out = await orch.task.create({ tasks: [
    { ...spec(), id: 'ov-1', files_owned: ['ov/f'], worktree: true },
    { ...spec(), id: 'ov-2', files_owned: ['ov/f'], worktree: true },
  ] });
  assert.strictEqual(out.tasks[0].overlaps, undefined);
  assert.deepStrictEqual(out.tasks[1].overlaps.map((o) => [o.task_id, o.files]), [['ov-1', ['ov/f']]]);
  // a task with its own tree is not refused by a holder in the shared tree, and reports it
  const shared = await orch.task.create({ ...spec(), id: 'ov-shared', files_owned: ['ov/g'] });
  const own = await orch.task.create({ ...spec(), id: 'ov-own', files_owned: ['ov/g'], worktree: true });
  assert.deepStrictEqual(own.overlaps.map((o) => o.task_id), [shared.id]);
  // a task created without a tree is judged shared: a holder in its own tree does not refuse it
  const plain = await orch.task.create({ ...spec(), id: 'ov-plain', files_owned: ['ov/f'] });
  assert.ok(plain.overlaps.length >= 1);
  // two items without trees on one file refuse the batch as two calls would
  const before0 = await rowCount();
  await rejectsCode(orch.task.create({ tasks: [{ ...spec(), files_owned: ['ov/h'] }, { ...spec(), files_owned: ['ov/h'] }] }), 'E_FILES_OVERLAP');
  assert.strictEqual(await rowCount(), before0);
});

test('a batch without trees is also all or nothing', async () => {
  const before0 = await rowCount();
  await rejectsCode(orch.task.create({ tasks: [spec(), { ...spec(), depends_on: ['nope'] }] }), 'E_NOT_FOUND');
  assert.strictEqual(await rowCount(), before0);
  const out = await orch.task.create({ tasks: [spec(), spec()] });
  assert.strictEqual(out.tasks.length, 2);
  assert.strictEqual(await rowCount(), before0 + 2);
});

test('the undo of a failed add removes only what the call made', async () => {
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  // nothing listed at the path: a branch that appeared in the window is left alone
  git(repo, 'branch', 'belay/foreign-a');
  const none = await W.undoAdd(repo, { path: treePath('foreign-a'), branch: 'belay/foreign-a' }, baseSha);
  assert.strictEqual(none.worktree_removed, false);
  assert.ok(branches().includes('belay/foreign-a'));
  // another process's tree on the same branch at another commit is left alone
  write(repo, 'moved.txt', 'x\n');
  commit(repo, 'moved');
  const foreign = treePath('foreign-b');
  git(repo, 'worktree', 'add', '-b', 'belay/foreign-b', foreign);
  const other = await W.undoAdd(repo, { path: foreign, branch: 'belay/foreign-b' }, baseSha);
  assert.strictEqual(other.worktree_removed, false);
  assert.ok(fs.existsSync(foreign) && branches().includes('belay/foreign-b'));
  // a different branch at the same path is left alone too
  const wrongBranch = await W.undoAdd(repo, { path: foreign, branch: 'belay/not-it' }, git(repo, 'rev-parse', 'HEAD'));
  assert.strictEqual(wrongBranch.worktree_removed, false);
  // a tree this call made (listed at the path, on the branch, at the base) is removed, branch included
  const mine = treePath('mine');
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'add', '-b', 'belay/mine', mine);
  const done = await W.undoAdd(repo, { path: mine, branch: 'belay/mine' }, head);
  assert.ok(done.worktree_removed && done.branch_deleted && done.path_gone, JSON.stringify(done));
  // through mustAdd: an add that fails because the branch exists runs the undo, which keeps the foreign branch
  fs.writeFileSync(path.join(repo, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nexit 0\n');
  try {
    const p = treePath('late');
    await assert.rejects(H.mustAdd(repo, ['worktree', 'add', '-b', 'belay/foreign-a', '--', p, head], 'add', () => W.undoAdd(repo, { path: p, branch: 'belay/foreign-a' }, head)));
  } finally { fs.rmSync(path.join(repo, '.git', 'hooks', 'post-checkout')); }
  assert.ok(branches().includes('belay/foreign-a'));
});

test('a null tasks or worktree is absent: the single form answers a row, and an amend is not refused', async () => {
  const one = await orch.task.create({ ...spec(), id: 'nul-1', tasks: null, worktree: null });
  assert.strictEqual(one.id, 'nul-1');
  assert.strictEqual(one.tasks, undefined, 'a row, not { tasks: [row] }');
  const amended = await orch.task.create({ id: 'nul-1', amend: true, acceptance: { files_within_owned: true }, tasks: null });
  assert.strictEqual(amended.id, 'nul-1');
  assert.strictEqual(amended.amended.length, 1);
});

test('the git-only checks of every item run before any tree: a bad ref on item 3 makes nothing', async () => {
  const before0 = [trees(), branches(), await rowCount()];
  const e = await rejectsCode(orch.task.create({ tasks: [{ ...spec(), id: 'pp-1', worktree: true }, { ...spec(), id: 'pp-2', worktree: true }, { ...spec(), id: 'pp-3', worktree: 'no-such-ref-anywhere' }] }), null);
  assert.ok(!e.detail || !e.detail.rollback || e.detail.rollback.length === 0, 'nothing was made to remove');
  assert.deepStrictEqual([trees(), branches(), await rowCount()], before0);
});

test('the deadline: a call that would pass its budget stops before the next tree, removes the trees made and writes nothing', async () => {
  const before0 = [trees(), branches(), await rowCount()];
  let t = 0;
  BATCH.seam.now = () => (t += 30000); // each look at the clock costs 30 s
  BATCH.seam.budgetMs = 100000;
  let e;
  try { e = await rejectsCode(orch.task.create({ tasks: ['dl-1', 'dl-2', 'dl-3'].map((id) => ({ ...spec(), id, worktree: true })) }), 'E_TIMEOUT'); }
  finally { BATCH.seam.now = null; BATCH.seam.budgetMs = null; }
  assert.strictEqual(e.detail.trees_made, 1);
  assert.strictEqual(e.detail.budget_ms, 100000);
  assert.ok(e.detail.elapsed_ms + e.detail.margin_ms > e.detail.budget_ms);
  assert.deepStrictEqual(e.detail.rollback.map((r) => r.task_id), ['dl-1']);
  assert.ok(e.detail.rollback[0].path_gone);
  assert.deepStrictEqual([trees(), branches(), await rowCount()], before0);
});

test('seams do nothing unless BELAY_TEST_SEAMS is set', async () => {
  delete process.env.BELAY_TEST_SEAMS;
  let called = false;
  BATCH.seam.afterTree = async () => { called = true; };
  try { await orch.task.create({ ...spec(), id: 'seam-off', worktree: true }); } finally { BATCH.seam.afterTree = null; process.env.BELAY_TEST_SEAMS = '1'; }
  assert.strictEqual(called, false);
});

test('an add that failed and made nothing is reported as kept_foreign, never as left', async () => {
  fs.writeFileSync(path.join(repo, '.git', 'hooks', 'reference-transaction'), '#!/bin/sh\nif [ "$1" = prepared ] && grep -q "belay/kp-2"; then echo refused >&2; exit 1; fi\nexit 0\n');
  const before0 = [trees(), branches(), await rowCount()];
  let e;
  try { e = await rejectsCode(orch.task.create({ tasks: ['kp-1', 'kp-2'].map((id) => ({ ...spec(), id, worktree: true })) }), 'E_GIT'); }
  finally { fs.rmSync(path.join(repo, '.git', 'hooks', 'reference-transaction')); }
  const k = e.detail.rollback.find((r) => r.task_id === 'kp-2');
  assert.ok(k && k.kept, JSON.stringify(e.detail.rollback));
  assert.deepStrictEqual(e.detail.kept_foreign, [k.path]);
  assert.strictEqual(e.detail.rollback_incomplete, undefined);
  assert.strictEqual(e.detail.left, undefined);
  assert.deepStrictEqual([trees(), branches(), await rowCount()], before0);
});
