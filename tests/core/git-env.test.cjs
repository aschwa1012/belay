'use strict';
require('../helpers/git-env.cjs'); // isolated git config for every fixture
require('../helpers/tmp.cjs');
// git-env.test.cjs — an inherited GIT_DIR, GIT_INDEX_FILE and the other repository-locating variables never redirect a call core makes

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const G = require('../../src/core/git.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const CLEAN = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|INDEX_FILE|WORK_TREE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR)$/i.test(k)));
function sh(cwd, ...a) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', windowsHide: true, env: CLEAN() });
  assert.strictEqual(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function mkRepo(root, name) {
  const p = `${root}/${name}`;
  fs.mkdirSync(p);
  sh(p, 'init', '-q', '-b', 'main');
  fs.writeFileSync(`${p}/f.txt`, name);
  sh(p, 'add', '-A');
  sh(p, 'commit', '-q', '-m', 'c');
  return p;
}
const withEnv = async (vars, fn) => {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};

test('an inherited GIT_DIR or GIT_INDEX_FILE does not redirect a core git call', async () => {
  const root = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-gitenv-')));
  try {
    const A = mkRepo(root, 'A');
    const B = mkRepo(root, 'B');
    await withEnv({ GIT_DIR: `${A}/.git`, GIT_WORK_TREE: A, GIT_COMMON_DIR: `${A}/.git`, GIT_OBJECT_DIRECTORY: `${A}/.git/objects`, GIT_ALTERNATE_OBJECT_DIRECTORIES: `${A}/.git/objects` }, async () => {
      const top = await G.run(B, ['rev-parse', '--absolute-git-dir']);
      assert.strictEqual(fwd(top.stdout.trim()), `${B}/.git`, 'the call acted on B, not on the inherited GIT_DIR');
      const w = await G.run(B, ['branch', 'probe']);
      assert.strictEqual(w.ok, true, w.stderr);
    });
    assert.strictEqual(sh(A, 'branch', '--list', 'probe'), '', 'A was not written');
    assert.ok(sh(B, 'branch', '--list', 'probe'), 'B was');
    await withEnv({ GIT_INDEX_FILE: `${root}/x.index` }, async () => {
      const add = await G.run(B, ['worktree', 'add', '-b', 'belay/t', '--', `${root}/B-wt`, 'main']);
      assert.strictEqual(add.ok, true, add.stderr);
    });
    assert.ok(!fs.existsSync(`${root}/x.index`), 'the inherited index file was not used');
    assert.strictEqual(sh(`${root}/B-wt`, 'status', '--porcelain'), '', 'the new tree reads clean');
    // A variable the caller passes on purpose (judged.cjs's temporary index) still reaches git.
    const idx = `${root}/own.index`;
    const own = await G.run(B, ['read-tree', 'HEAD'], { env: { GIT_INDEX_FILE: idx } });
    assert.strictEqual(own.ok, true, own.stderr);
    assert.ok(fs.existsSync(idx), 'an explicit env entry is honoured');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
