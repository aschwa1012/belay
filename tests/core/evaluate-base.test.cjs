'use strict';
// evaluate-base.test.cjs — build step S3, ADR 0010 amendment 3: `files_within_owned` is judged against
// a base, so a commit is seen as well as a dirty tree. Each test builds a throwaway repository in OS
// temp (`git init -b main`, a committed base, a branch) and removes it in `finally`. The core is the
// real one, as methods.test.cjs uses it.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
});

after(async () => {
  await orch.shutdownOwner();
  await orch.close();
  cleanup(dir);
});

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(repo, rel, text) {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

// A repository on branch `main` holding one committed base file, then a work branch checked out.
// `trunk` names the initial branch, so a test can build a repository that has no `main`.
function makeRepo(trunk = 'main') {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-evalbase-')).split('\\').join('/');
  git(repo, 'init', '-q', '-b', trunk);
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'core.autocrlf', 'false');
  write(repo, 'base/keep.txt', 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'work');
  return repo;
}

function commit(repo, msg) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', msg);
  return git(repo, 'rev-parse', 'HEAD');
}

async function withRepo(fn, trunk) {
  const repo = makeRepo(trunk);
  try { return await fn(repo); } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}

const ownedCheck = (row) => row.results.checks.find(c => c.kind === 'files_within_owned');

async function newTask(owned) {
  return orch.task.create({ spec: 'evaluate base', files_owned: owned, acceptance: { files_within_owned: true } });
}

test('evaluate: a committed change outside files_owned fails the ownership check, naming the path', async () => {
  await withRepo(async (repo) => {
    write(repo, 'e1/mine.txt', 'ok\n');
    write(repo, 'elsewhere/theirs.txt', 'not mine\n');
    commit(repo, 'work');
    assert.strictEqual(git(repo, 'status', '--porcelain'), '', 'the tree is clean: only the diff can see the change');
    const t = await newTask(['e1']);
    const row = await orch.task.evaluate({ task_id: t.id, worktree: repo });
    const c = ownedCheck(row);
    assert.strictEqual(c.executable, true);
    assert.strictEqual(c.passed, false);
    assert.deepStrictEqual(c.detail.outside, ['elsewhere/theirs.txt']);
    assert.notStrictEqual(row.state, 'done');
  });
});

test('evaluate: committed changes only within files_owned pass, and detail names base_sha and head_sha', async () => {
  await withRepo(async (repo) => {
    const baseSha = git(repo, 'rev-parse', 'main');
    write(repo, 'e2/a.txt', 'a\n');
    write(repo, 'e2/sub/b.txt', 'b\n');
    const headSha = commit(repo, 'work');
    const t = await newTask(['e2']);
    const row = await orch.task.evaluate({ task_id: t.id, worktree: repo });
    const c = ownedCheck(row);
    assert.strictEqual(c.passed, true);
    assert.strictEqual(c.detail.base_ref, 'main');
    assert.strictEqual(c.detail.base_sha, baseSha);
    assert.strictEqual(c.detail.head_sha, headSha);
    assert.deepStrictEqual(c.detail.changed, ['e2/a.txt', 'e2/sub/b.txt']);
    assert.deepStrictEqual(c.detail.outside, []);
    assert.strictEqual(row.state, 'done');
  });
});

test('evaluate: a committed rename needs both paths owned', async () => {
  await withRepo(async (repo) => {
    // The renamed file is 20 lines so git's similarity detection sees a rename, not a delete and an add.
    write(repo, 'base/moved.txt', Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'add moved on work');
    const start = git(repo, 'rev-parse', 'HEAD');
    fs.mkdirSync(path.join(repo, 'e3'), { recursive: true });
    git(repo, 'mv', 'base/moved.txt', 'e3/moved.txt');
    commit(repo, 'rename out of base/');
    const t = await newTask(['e3']);
    const row = await orch.task.evaluate({ task_id: t.id, worktree: repo, base: start });
    const c = ownedCheck(row);
    assert.deepStrictEqual(c.detail.changed, ['base/moved.txt', 'e3/moved.txt'], 'both the old and the new path are in the changed set');
    assert.strictEqual(c.passed, false, 'the old path is outside files_owned');
    assert.deepStrictEqual(c.detail.outside, ['base/moved.txt']);

    const both = await orch.task.create({ spec: 'owns both', files_owned: ['e3b', 'base/moved.txt'], acceptance: { files_within_owned: true } });
    const half = await orch.task.evaluate({ task_id: both.id, worktree: repo, base: start });
    assert.deepStrictEqual(ownedCheck(half).detail.outside, ['e3/moved.txt'], 'the new path is now the one outside');

  });
  // SF5: the positive half, in a repository of its own so no other task owns these paths.
  await withRepo(async (repo) => {
    write(repo, 'base/moved3.txt', Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'add moved3');
    const start = git(repo, 'rev-parse', 'HEAD');
    fs.mkdirSync(path.join(repo, 'e3p'), { recursive: true });
    git(repo, 'mv', 'base/moved3.txt', 'e3p/moved3.txt');
    commit(repo, 'rename');
    const full = await orch.task.create({ spec: 'owns old and new', files_owned: ['e3p', 'base/moved3.txt'], acceptance: { files_within_owned: true } });
    const ok = await orch.task.evaluate({ task_id: full.id, worktree: repo, base: start });
    assert.deepStrictEqual(ownedCheck(ok).detail.changed, ['base/moved3.txt', 'e3p/moved3.txt']);
    assert.strictEqual(ownedCheck(ok).passed, true, 'both paths owned, so the rename passes');
    assert.deepStrictEqual(ownedCheck(ok).detail.outside, []);
    assert.strictEqual(ok.state, 'done');
  });
});

test('evaluate: an uncommitted change outside files_owned still fails with a base present', async () => {
  await withRepo(async (repo) => {
    write(repo, 'e4/a.txt', 'committed\n');
    commit(repo, 'work');
    write(repo, 'stray/dirty.txt', 'uncommitted\n');
    const t = await newTask(['e4']);
    const row = await orch.task.evaluate({ task_id: t.id, worktree: repo, base: 'main' });
    const c = ownedCheck(row);
    assert.strictEqual(c.passed, false);
    assert.deepStrictEqual(c.detail.outside, ['stray/dirty.txt']);
    assert.deepStrictEqual(c.detail.changed, ['e4/a.txt', 'stray/dirty.txt'], 'the union of the diff and the status, sorted');
  });
});

test('evaluate: an explicit base is used in place of the merge-base', async () => {
  await withRepo(async (repo) => {
    write(repo, 'outside5/first.txt', 'first\n');
    const first = commit(repo, 'first');
    write(repo, 'e5/second.txt', 'second\n');
    commit(repo, 'second');
    const t = await newTask(['e5']);
    const byDefault = await orch.task.evaluate({ task_id: t.id, worktree: repo });
    assert.deepStrictEqual(ownedCheck(byDefault).detail.outside, ['outside5/first.txt'], 'from the merge-base the first commit is outside');
    const t2 = await newTask(['e5b']);
    const explicit = await orch.task.evaluate({ task_id: t2.id, worktree: repo, base: first });
    const c = ownedCheck(explicit);
    assert.strictEqual(c.detail.base_ref, first);
    assert.strictEqual(c.detail.base_sha, first);
    assert.deepStrictEqual(c.detail.changed, ['e5/second.txt'], 'from the first commit only the second is changed');
  });
});

test('evaluate: an unresolvable base makes the check not executable, and the task is not done', async () => {
  await withRepo(async (repo) => {
    write(repo, 'e6/a.txt', 'a\n');
    commit(repo, 'work');
    const t = await newTask(['e6']);
    const bogus = await orch.task.evaluate({ task_id: t.id, worktree: repo, base: 'no-such-ref-xyz' });
    const c = ownedCheck(bogus);
    assert.strictEqual(c.executable, false);
    assert.strictEqual(c.passed, false);
    assert.strictEqual(c.detail.failed_ref, 'no-such-ref-xyz');
    assert.ok(c.detail.stderr.length <= 400);
    assert.notStrictEqual(bogus.state, 'done');
    assert.strictEqual(bogus.results.executable, false);
  });
  await withRepo(async (repo) => {
    write(repo, 'e6b/a.txt', 'a\n');
    commit(repo, 'work');
    const t = await newTask(['e6b']);
    const row = await orch.task.evaluate({ task_id: t.id, worktree: repo });
    const c = ownedCheck(row);
    assert.strictEqual(c.executable, false, 'no main, so no merge-base');
    assert.strictEqual(c.detail.base_ref, 'main');
    assert.notStrictEqual(row.state, 'done');
  }, 'trunk');
});

test('evaluate (e11): a tag named main at HEAD does not stand in for the branch main', async () => {
  await withRepo(async (repo) => {
    write(repo, 'elsewhere11/theirs.txt', 'not mine\n');
    write(repo, 'e11/mine.txt', 'ok\n');
    commit(repo, 'work');
    git(repo, 'tag', 'main'); // a worker's tag: the bare name `main` now resolves to the tag first
    const t = await newTask(['e11']);
    const row = await orch.task.evaluate({ task_id: t.id, worktree: repo });
    const c = ownedCheck(row);
    assert.deepStrictEqual(c.detail.outside, ['elsewhere11/theirs.txt'], 'the base is refs/heads/main, not the tag');
    assert.strictEqual(c.passed, false);
    assert.strictEqual(c.detail.base_sha, git(repo, 'rev-parse', 'refs/heads/main'));
  });
});

test('evaluate (e12): an empty range is flagged, and still passes with a clean tree', async () => {
  await withRepo(async (repo) => {
    git(repo, 'checkout', '-q', 'main'); // HEAD is the base: the branch has been merged, or no work was committed
    const t = await newTask(['e12']);
    const row = await orch.task.evaluate({ task_id: t.id, worktree: repo });
    const c = ownedCheck(row);
    assert.strictEqual(c.detail.base_sha, c.detail.head_sha);
    assert.strictEqual(c.detail.empty_range, true);
    assert.strictEqual(c.passed, true);
    git(repo, 'checkout', '-q', '-b', 'work2');
    write(repo, 'e12b/x.txt', 'x\n');
    commit(repo, 'work');
    const t2 = await newTask(['e12b']);
    assert.strictEqual(ownedCheck(await orch.task.evaluate({ task_id: t2.id, worktree: repo })).detail.empty_range, false);
  });
});

test('task.evaluate: a non-string base is refused E_ARGS naming base', async () => {
  const t = await newTask(['e7']);
  for (const base of [7, '', {}, null]) {
    await assert.rejects(orch.task.evaluate({ task_id: t.id, worktree: dir, base }), e => {
      assert.strictEqual(e.code, 'E_ARGS');
      assert.match(e.message, /base/);
      return true;
    });
  }
});
