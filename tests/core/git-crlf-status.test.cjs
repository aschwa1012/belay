'use strict';
require('../helpers/git-env.cjs'); // isolated git config for every fixture
require('../helpers/tmp.cjs');
// git-crlf-status.test.cjs — a hardened status keeps the SYSTEM core.autocrlf: a file checked out with CRLF whose blob holds LF, and
// whose stat changed with no content change, is clean to git and so to G.dirtyPaths. Git for Windows installs autocrlf=true in its
// system config; a host without it has nothing to lose, so the test is skipped there. (git-safe drops every GIT_* variable, so
// GIT_CONFIG_SYSTEM cannot stand in for the host's system config; the seam test in git-safe-overrides covers the logic anywhere.)

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const G = require('../../src/core/git.cjs');

function systemAutocrlf() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  const r = spawnSync('git', ['config', '--system', '--get', 'core.autocrlf'], { encoding: 'utf8', windowsHide: true, env });
  return r.status === 0 ? r.stdout.trim() : '';
}

test('an unchanged CRLF file with a new mtime is clean through G.dirtyPaths when the system config sets autocrlf', async (t) => {
  if (systemAutocrlf() !== 'true') return t.skip('the host\'s system git config does not set core.autocrlf=true');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-crlf-')).split(path.sep).join('/');
  try {
    const sh = (...a) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8', windowsHide: true });
      assert.strictEqual(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
      return r.stdout;
    };
    sh('init', '-q', '-b', 'main');
    fs.writeFileSync(`${dir}/c.txt`, 'one\ntwo\n'); // LF in the blob
    sh('-c', 'core.autocrlf=false', 'add', 'c.txt');
    sh('-c', 'core.autocrlf=false', 'commit', '-q', '-m', 'c');
    fs.writeFileSync(`${dir}/c.txt`, 'one\r\ntwo\r\n'); // the CRLF working copy autocrlf=true makes
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(`${dir}/c.txt`, later, later); // a stat change with no content change
    assert.deepStrictEqual(await G.dirtyPaths(dir), [], 'git reads it clean');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
