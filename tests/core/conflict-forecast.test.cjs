'use strict';
require('../helpers/tmp.cjs'); // a plain `node --test` of this file keeps its temp dirs out of the real temp dir
// conflict-forecast.test.cjs — the conflict forecast: a planted text conflict names its files, a clean pair is clean, no integration
// branch is `against: null`, a timeout is `unavailable`, and the repository gains no object. Throwaway repositories built here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { forecast, forecastTask } = require('../../src/core/conflict-forecast.cjs');
const { sandbox, cleanup } = require('./helpers.cjs');
const { git, write, commit, makeRepo } = require('./worktree-helpers.cjs');

// A repository whose branches `a` and `b` both rewrote shared.txt differently (a conflict), and `c` touched another file only.
function conflictRepo(dir) {
  const repo = makeRepo(dir);
  write(repo, 'shared.txt', 'one\ntwo\nthree\n'); commit(repo, 'shared');
  git(repo, 'branch', 'a'); git(repo, 'branch', 'b'); git(repo, 'branch', 'c');
  for (const [br, text, other] of [['a', 'one\nA\nthree\n'], ['b', 'one\nB\nthree\n'], ['c', 'one\ntwo\nthree\n', 'c-only.txt']]) {
    git(repo, 'checkout', '-q', br);
    write(repo, other || 'shared.txt', other ? 'c\n' : text); commit(repo, br);
  }
  git(repo, 'checkout', '-q', 'main');
  return repo;
}
const looseObjects = (repo) => Number(/^count: (\d+)/m.exec(git(repo, 'count-objects', '-v'))[1]);

test('a planted text conflict gives the conflicted files; a clean pair is clean', async () => {
  const dir = sandbox();
  try {
    const repo = conflictRepo(dir);
    const [a, b, c] = ['a', 'b', 'c'].map((x) => git(repo, 'rev-parse', x));
    const hit = await forecast({ repo, head: a, against: b });
    assert.deepStrictEqual(hit.files, ['shared.txt']);
    assert.strictEqual(hit.against, b);
    assert.strictEqual(typeof hit.ms, 'number');
    assert.strictEqual(hit.clean, undefined);
    const ok = await forecast({ repo, head: c, against: b });
    assert.strictEqual(ok.clean, true);
    assert.strictEqual(ok.files, undefined);
    assert.strictEqual(ok.against, b);
  } finally { cleanup(dir); }
});

test('no integration head gives against null and runs nothing', async () => {
  const dir = sandbox();
  try {
    const repo = conflictRepo(dir);
    const r = await forecast({ repo, head: git(repo, 'rev-parse', 'a'), against: null });
    assert.deepStrictEqual({ ...r, ms: 0 }, { against: null, ms: 0 });
  } finally { cleanup(dir); }
});

test('the repository gains no object (a bare merge-tree does, so the count means something)', async () => {
  const dir = sandbox();
  try {
    const repo = conflictRepo(dir);
    const [a, b] = ['a', 'b'].map((x) => git(repo, 'rev-parse', x));
    const before = looseObjects(repo);
    const r = await forecast({ repo, head: a, against: b });
    assert.deepStrictEqual(r.files, ['shared.txt']);
    assert.strictEqual(looseObjects(repo), before, 'the forecast wrote objects into the repository');
    spawnSync('git', ['merge-tree', '--write-tree', a, b], { cwd: repo, windowsHide: true });
    assert.ok(looseObjects(repo) > before, 'control: an unguarded merge-tree writes objects');
  } finally { cleanup(dir); }
});

test('a scratch directory is removed after the call', async () => {
  const dir = sandbox();
  try {
    const repo = conflictRepo(dir);
    const scratchRoot = path.join(dir, 'scratch'); fs.mkdirSync(scratchRoot);
    await forecast({ repo, head: git(repo, 'rev-parse', 'a'), against: git(repo, 'rev-parse', 'b'), scratchRoot });
    assert.deepStrictEqual(fs.readdirSync(scratchRoot), []);
  } finally { cleanup(dir); }
});

test('a timeout, or a commit that does not exist, is unavailable: never a throw', async () => {
  const dir = sandbox();
  try {
    const repo = conflictRepo(dir);
    const [a, b] = ['a', 'b'].map((x) => git(repo, 'rev-parse', x));
    const slow = await forecast({ repo, head: a, against: b, timeoutMs: 1 });
    assert.strictEqual(typeof slow.unavailable, 'string');
    assert.strictEqual(slow.files, undefined); assert.strictEqual(slow.clean, undefined);
    const bad = await forecast({ repo, head: 'f'.repeat(40), against: b });
    assert.match(bad.unavailable, /merge-tree exited 1 with no conflict/);
    const gone = await forecast({ repo: path.join(dir, 'nowhere'), head: a, against: b });
    assert.strictEqual(typeof gone.unavailable, 'string');
  } finally { cleanup(dir); }
});

test('forecastTask reads the task branch and the run\'s integration branch; no branch or no integration branch says so', async () => {
  const dir = sandbox();
  try {
    const repo = conflictRepo(dir);
    const task = (branch) => ({ id: 't1', worktree: { repo, branch } });
    assert.strictEqual(await forecastTask({ id: 't0' }, 'run1'), null, 'a task with no belay branch has nothing to forecast');
    assert.strictEqual(await forecastTask(task('no-such-branch'), 'run1'), null);
    const none = await forecastTask(task('a'), 'run1');
    assert.strictEqual(none.against, null, 'the integration branch does not exist yet');
    git(repo, 'branch', 'belay/integrate/run1', 'b');
    const hit = await forecastTask(task('a'), 'run1');
    assert.deepStrictEqual(hit.files, ['shared.txt']);
    assert.strictEqual(hit.against, git(repo, 'rev-parse', 'b'));
    assert.strictEqual((await forecastTask(task('c'), 'run1')).clean, true);
  } finally { cleanup(dir); }
});
