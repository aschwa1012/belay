'use strict';
// git-safe.test.cjs — the core's reads of a worker's tree (files_within_owned's status, the review tree snapshot) use the
// same hardening as git_read: a repository whose config names an fsmonitor program and a clean filter runs neither, and an
// inherited GIT_DIR does not redirect the read. The control shows the plant is live: a plain `git status` runs the program.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GS = require('../../src/core/git-safe.cjs');
const EV = require('../../src/core/evaluate.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');

function planted() {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-gitsafe-')));
  const marks = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-gitsafe-marks-')));
  const git = (...a) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8', windowsHide: true });
    assert.strictEqual(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
    return r;
  };
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'base');
  const script = `${marks}/mark.cjs`;
  fs.writeFileSync(script, "require('fs').appendFileSync(process.argv[2], 'ran'); if (process.argv[3] === 'pipe') process.stdin.pipe(process.stdout);\n");
  const cmd = (name, pipe) => `"${fwd(process.execPath)}" "${script}" "${marks}/${name}"${pipe ? ' pipe' : ''}`;
  git('config', 'core.fsmonitor', cmd('fsmonitor'));
  git('config', 'filter.evil.clean', cmd('clean', true));
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt filter=evil\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n'); // stat-dirty, so a status would run the clean filter
  const ran = () => fs.readdirSync(marks).filter((n) => n !== 'mark.cjs');
  const clear = () => { for (const n of ran()) fs.rmSync(`${marks}/${n}`); };
  return { dir, marks, ran, clear, rm: () => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(marks, { recursive: true, force: true }); } };
}

test('control: a plain git status in the planted repository runs the configured fsmonitor program', () => {
  const p = planted();
  try {
    spawnSync('git', ['status', '--porcelain'], { cwd: p.dir, encoding: 'utf8', windowsHide: true });
    assert.ok(p.ran().includes('fsmonitor'), `the plant is live: ${p.ran()}`);
  } finally { p.rm(); }
});

test('safeGit, files_within_owned and the review snapshot run no program from the repository\'s config', async () => {
  const p = planted();
  try {
    const s = await GS.safeGit(['status', '--porcelain', '-z', '--untracked-files=all'], p.dir, 30000);
    assert.strictEqual(s.exit_code, 0, s.stderr || s.spawn_error);
    assert.ok(EV.parsePorcelainZ(s.stdout).includes('a.txt'), 'the read still sees the change');
    const owned = await EV.filesWithinOwned(p.dir, ['a.txt', '.gitattributes'], 'HEAD', 'arg');
    assert.strictEqual(owned.executable, true, JSON.stringify(owned.detail));
    const snap = await require('../../src/core/review-tree.cjs').snapshot(p.dir);
    assert.ok(snap.head && snap.count >= 1, JSON.stringify(snap));
    assert.deepStrictEqual(p.ran(), [], 'no configured program ran');
  } finally { p.rm(); }
});

test('an inherited GIT_DIR is dropped: the read is of the worktree, not the directory the variable names', async () => {
  const p = planted();
  const other = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-gitsafe-other-')));
  try {
    const r = await GS.safeGit(['rev-parse', '--show-toplevel'], p.dir, 30000, { env: { ...process.env, GIT_DIR: other } });
    assert.strictEqual(r.exit_code, 0, r.stderr || r.spawn_error);
    assert.strictEqual(fwd(fs.realpathSync(r.stdout.trim())).toLowerCase(), fwd(fs.realpathSync(p.dir)).toLowerCase());
    assert.strictEqual(GS.gitEnv({ GIT_DIR: 'x', git_work_tree: 'y', PATH: 'p' }).GIT_DIR, undefined);
  } finally { p.rm(); fs.rmSync(other, { recursive: true, force: true }); }
});
