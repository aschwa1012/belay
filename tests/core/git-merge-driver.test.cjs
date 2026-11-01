'use strict';
require('../helpers/git-env.cjs'); // isolated git config for every fixture
require('../helpers/tmp.cjs');
// git-merge-driver.test.cjs — a merge driver the repository's own config names runs neither under git-safe's merge-tree nor under
// git-hooks' expectedTree.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GS = require('../../src/core/git-safe.cjs');
const H = require('../../src/core/git-hooks.cjs');

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

// A repo whose config names a merge driver for f.txt; two branches conflict on it. -> { root, repo, log, head }
function driverRepo() {
  const root = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-gitdrv-')));
  const repo = `${root}/repo`;
  fs.mkdirSync(repo);
  const log = `${root}/DRIVER-RAN.log`;
  const drv = `${root}/driver.cjs`;
  fs.writeFileSync(drv, `require('fs').appendFileSync(${JSON.stringify(log)}, 'ran\\n'); process.exit(1);\n`);
  sh(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(`${repo}/.gitattributes`, 'f.txt merge=pwn\n');
  fs.writeFileSync(`${repo}/f.txt`, 'base\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'base');
  sh(repo, 'config', 'merge.pwn.driver', `"${fwd(process.execPath)}" "${drv}" %O %A %B`);
  sh(repo, 'checkout', '-q', '-b', 'left');
  fs.writeFileSync(`${repo}/f.txt`, 'left\n');
  sh(repo, 'commit', '-qam', 'left');
  sh(repo, 'checkout', '-q', '-b', 'right', 'main');
  fs.writeFileSync(`${repo}/f.txt`, 'right\n');
  sh(repo, 'commit', '-qam', 'right');
  sh(repo, 'checkout', '-q', 'left');
  return { root, repo, log, head: sh(repo, 'rev-parse', 'right') };
}
const runs = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0);

test('the control: a plain git merge-tree runs the repository\'s merge driver, so the plant is live', () => {
  const { root, repo, log, head } = driverRepo();
  try {
    spawnSync('git', ['merge-tree', '--write-tree', 'HEAD', head], { cwd: repo, encoding: 'utf8', windowsHide: true, env: CLEAN() });
    assert.ok(runs(log) > 0, 'the driver ran');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('git-safe\'s merge-tree and git-hooks\' expectedTree run no merge driver from the repository\'s config', async () => {
  const { root, repo, log, head } = driverRepo();
  try {
    const r = await GS.safeGit(['merge-tree', '--write-tree', '--no-messages', 'HEAD', head], repo, 60000);
    assert.strictEqual(r.executable, true, r.spawn_error);
    assert.strictEqual(runs(log), 0, 'git-safe ran the driver');
    const t = await H.expectedTree(repo, head);
    assert.strictEqual(t, null, 'a content conflict has no expected tree');
    assert.strictEqual(runs(log), 0, 'expectedTree ran the driver');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a clean merge still gives expectedTree its tree', async () => {
  const root = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-gitdrv-ok-')));
  try {
    const repo = mkRepo(root, 'R');
    sh(repo, 'checkout', '-q', '-b', 'other');
    fs.writeFileSync(`${repo}/g.txt`, 'g\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-qm', 'g');
    sh(repo, 'checkout', '-q', 'main');
    const t = await H.expectedTree(repo, sh(repo, 'rev-parse', 'other'));
    assert.match(t, /^[0-9a-f]{40,64}$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
