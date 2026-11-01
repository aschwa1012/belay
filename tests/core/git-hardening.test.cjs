'use strict';
require('../helpers/git-env.cjs'); // isolated git config for every fixture
require('../helpers/tmp.cjs');
// git-hardening.test.cjs — core's git calls run no program the repository's own config names (core.fsmonitor under `status`), and
// resolve git from PATH, never from the worker tree they run in (Windows searches the cwd before PATH for a bare name).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const G = require('../../src/core/git.cjs');
const EV = require('../../src/core/evaluate.cjs');
const GS = require('../../src/core/git-safe.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const sh = (cwd, ...a) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
function mkRepo() {
  const root = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-githard-')));
  const repo = `${root}/repo`;
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(`${repo}/f.txt`, 'one\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'c');
  return { root, repo };
}

test('git status through core runs no core.fsmonitor program (the control: a plain status does)', async () => {
  const { root, repo } = mkRepo();
  try {
    const mark = `${root}/FSMONITOR-RAN`;
    const mon = `${root}/mon.sh`;
    fs.writeFileSync(mon, `#!/bin/sh\necho ran >> "${mark}"\nexit 1\n`);
    sh(repo, 'config', 'core.fsmonitor', `sh "${mon}"`);
    sh(repo, 'config', 'core.untrackedCache', 'true');
    spawnSync('git', ['status', '--porcelain'], { cwd: repo, windowsHide: true });
    assert.ok(fs.existsSync(mark), 'the plant is live: a plain status ran the program');
    fs.rmSync(mark);
    fs.writeFileSync(`${repo}/new.txt`, 'x\n');
    const dirty = await G.dirtyPaths(repo);
    assert.ok(dirty.length > 0);
    const r = await G.run(repo, ['status', '--porcelain']);
    assert.strictEqual(r.ok, true, r.stderr);
    assert.ok(!fs.existsSync(mark), 'core ran the fsmonitor program');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a git.exe planted in the tree git runs in is not the git that runs', async () => {
  if (process.platform !== 'win32') return; // only Windows searches the cwd for a bare name
  const { root, repo } = mkRepo();
  const saved = process.env.NODE_OPTIONS;
  try {
    const mark = `${root}/PLANT-RAN`;
    const pre = `${root}/pre.cjs`;
    fs.writeFileSync(pre, `require('fs').appendFileSync(${JSON.stringify(mark)}, 'ran\\n');\n`);
    fs.copyFileSync(process.execPath, `${repo}/git.exe`); // a program that runs the preload below when it starts
    process.env.NODE_OPTIONS = `--require ${JSON.stringify(pre)}`;
    assert.ok(GS.gitPath() !== 'git' && path.isAbsolute(GS.gitPath()), 'git is found on PATH');
    const r = await EV.runCommand(['git', 'rev-parse', 'HEAD'], repo, 30000);
    assert.strictEqual(r.exit_code, 0, r.stderr);
    assert.match(r.stdout.trim(), /^[0-9a-f]{40,64}$/);
    const g = await G.run(repo, ['rev-parse', 'HEAD']);
    assert.strictEqual(g.ok, true, g.stderr);
    assert.ok(!fs.existsSync(mark), 'the planted git.exe ran');
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
