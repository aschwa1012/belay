'use strict';
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

module.exports = { git, write, commit, makeRepo, rejectsCode };
