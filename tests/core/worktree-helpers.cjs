'use strict';
require('../helpers/git-env.cjs'); // isolated git config for every fixture
// worktree-helpers.cjs — throwaway repositories for the ADR 0053 tests. Not a *.test.cjs file, so the runner does not run it.
// A repository lives under the test's own sandbox dir, on `main`, with one committed base file, a `node_modules/dep` that is
// not committed, and (unless `ignore: false`) a `.gitignore` of `node_modules/`, the shape of this repository.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function commit(root, msg) {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', msg);
}

let k = 0;
function makeRepo(parent, { ignore = true } = {}) {
  const repo = path.join(parent, `repo${++k}`).split('\\').join('/');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'core.autocrlf', 'false');
  write(repo, 'base/keep.txt', 'base\n');
  if (ignore) write(repo, '.gitignore', 'node_modules/\n');
  commit(repo, 'base');
  write(repo, 'node_modules/dep/index.js', 'module.exports = 1;\n');
  // toplevel's spelling, which is what core records, so a comparison of paths is a comparison of strings
  return git(repo, 'rev-parse', '--show-toplevel');
}

// Awaits a rejection and returns the error; `code` null accepts any code.
async function rejectsCode(promise, code) {
  let got = null;
  await assert.rejects(promise, (e) => { got = e; if (code) assert.strictEqual(e.code, code, `${e.code}: ${e.message}`); return true; });
  return got;
}

// A staging branch belay treats as its own is belay/integrate/<run id> for a run the store knows: this registers a run per name
// (an operator attach for it), so a test can stage on belay/integrate/<name> and keep the persistent tree it asserts on.
async function stageRuns(dataDir, names) {
  const { openCore } = require('./helpers.cjs').core('index.cjs');
  for (const name of names) {
    const c = await openCore({ dataDir, caller: { role: 'operator', run_id: name, pid: process.pid }, embed: false });
    try { await c.run.attach({ adapter_pid: process.pid }); } finally { await c.close(); }
  }
  // The suite's standing orchestrator run merges into these staged runs' branches, so its launching process allows cross-run merges
  // (cross_run_merge is off by default; tests/core/cross-run-merge.test.cjs covers the refusal). Its other settings are carried.
  const c = await openCore({ dataDir, caller: { role: 'operator', run_id: 'test-run', pid: process.pid }, embed: false });
  try {
    const cur = (await c.run.get({})).run;
    if (cur) await c.run.attach({ adapter_pid: process.pid, cross_run_merge: true, ...(cur.merge_into ? { merge_into: cur.merge_into } : {}), ...(cur.run_mode ? { run_mode: cur.run_mode } : {}) });
  } finally { await c.close(); }
}

// The runner's 60 s per-test cap (scripts/test.cjs) is a hang guard, not a budget. A test over real repositories costs 2 to 13 s alone
// (git spawns, and a node spawn per check), so a loaded host reaches the cap with nothing wrong. `guarded(test)` gives each test this
// longer guard instead; it asserts nothing about time.
const HANG_GUARD_MS = 240000;
const guarded = (nodeTest) => (name, fn) => nodeTest(name, { timeout: HANG_GUARD_MS }, fn);

module.exports = { git, write, commit, makeRepo, rejectsCode, stageRuns, guarded, HANG_GUARD_MS };
