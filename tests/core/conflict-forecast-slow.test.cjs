'use strict';
require('../helpers/tmp.cjs'); // a plain `node --test` of this file keeps its temp dirs out of the real temp dir
// conflict-forecast-slow.test.cjs — a forecast has one overall deadline and one preparation, whatever git is doing. Every git spawn is
// redirected through tests/core/fixtures/sleep-git.cjs, which waits SLEEP_GIT_MS and then runs the real git. The patch is installed
// before the modules under test load, and this file runs in a process of its own.

const cp = require('node:child_process');
const path = require('node:path');
let spawns = 0;
const orig = cp.spawn;
cp.spawn = function spawn(cmd, args, opts) {
  if (/git(\.exe)?$/i.test(String(cmd))) { spawns += 1; return orig.call(this, process.execPath, [path.join(__dirname, 'fixtures', 'sleep-git.cjs'), cmd, ...args], opts); }
  return orig.apply(this, arguments);
};

const test = require('node:test');
const assert = require('node:assert');

const { forecastTask } = require('../../src/core/conflict-forecast.cjs');
const { sandbox, cleanup } = require('./helpers.cjs');
const { git, write, commit, makeRepo } = require('./worktree-helpers.cjs');

function repoWithConflict(dir) {
  const repo = makeRepo(dir);
  write(repo, 'shared.txt', 'one\n'); commit(repo, 'shared');
  git(repo, 'branch', 'a'); git(repo, 'branch', 'belay/integrate/run1');
  for (const br of ['a', 'belay/integrate/run1']) { git(repo, 'checkout', '-q', br); write(repo, 'shared.txt', `${br}\n`); commit(repo, br); }
  git(repo, 'checkout', '-q', 'main');
  return repo;
}

test('a forecast prepares git once: the task and integration refs share one preparation', async () => {
  const dir = sandbox();
  try {
    const repo = repoWithConflict(dir);
    spawns = 0;
    const r = await forecastTask({ id: 't1', worktree: { repo, branch: 'a' } }, 'run1', { totalMs: 120000 });
    assert.deepStrictEqual(r.files, ['shared.txt']);
    // prepare 2 (system and local filter reads), 2 ref reads, version, common dir, merge-tree
    assert.ok(spawns <= 7, `${spawns} git spawns`);
  } finally { cleanup(dir); }
});

// Last: it leaves the abandoned calls of the deadline behind, which would be counted by a test after it.
test('slow git: one forecast ends at its overall deadline, not after a deadline per call', async () => {
  const dir = sandbox();
  try {
    const repo = repoWithConflict(dir);
    process.env.SLEEP_GIT_MS = '1500';
    const t0 = Date.now();
    const r = await forecastTask({ id: 't1', worktree: { repo, branch: 'a' } }, 'run1', { totalMs: 700 });
    const ms = Date.now() - t0;
    assert.ok(r === null || typeof r.unavailable === 'string', JSON.stringify(r));
    assert.ok(ms < 1400, `the forecast took ${ms} ms against a 700 ms deadline`);
  } finally { delete process.env.SLEEP_GIT_MS; cleanup(dir); }
});
