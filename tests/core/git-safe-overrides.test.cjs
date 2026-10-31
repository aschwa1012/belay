'use strict';
require('../helpers/git-env.cjs'); // isolated git config for every fixture
require('../helpers/tmp.cjs');
// git-safe-overrides.test.cjs — the override list is read in ONE config spawn (the system keys passed back, a repository's filters and
// merge drivers switched off), the system line-ending keys come back for a read that asks for them, git is found on PATH or the spawn
// fails closed, and an injected GIT_CONFIG_PARAMETERS never reaches a core git call.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GS = require('../../src/core/git-safe.cjs');
const G = require('../../src/core/git.cjs');

// A fake `run` returning one canned `git config --null --show-scope` answer, counting its calls.
function fakeRun(entries) {
  const calls = [];
  const out = Buffer.from(entries.map(([scope, key, value]) => `${scope}\0${key}${value === undefined ? '' : `\n${value}`}\0`).join(''), 'utf8');
  const run = async (g, argv, opts) => { calls.push({ argv, system: !!opts.system }); return { code: 0, out, total: out.length, kept: out.length, errTail: '' }; };
  return { run, calls };
}
const ENTRIES = [
  ['system', 'filter.lfs.clean', 'git-lfs clean -- %f'],
  ['system', 'core.autocrlf', 'true'],
  ['system', 'core.fscache', 'true'],
  ['system', 'core.symlinks', 'false'],
  ['global', 'filter.mine.clean', 'cat'],
  ['local', 'filter.evil.clean', 'evil'],
  ['local', 'filter.evil.smudge', 'evil'],
  ['local', 'merge.pwn.driver', 'evil %O %A %B'],
];
const pairs = (a) => a.filter((x) => x !== '-c');

test('the overrides come from one config read; the system line-ending keys come back only for a read that hashes content', async () => {
  const f = fakeRun(ENTRIES);
  const plain = await GS.filterOverrides(f.run, 'git', '.', {}, 1000);
  assert.strictEqual(f.calls.length, 1, 'one config spawn');
  assert.strictEqual(f.calls[0].system, true, 'the system config is read');
  assert.ok(pairs(plain).includes('filter.lfs.clean=git-lfs clean -- %f'), 'a system filter is passed back');
  assert.ok(pairs(plain).includes('core.fscache=true'));
  assert.ok(!pairs(plain).some((x) => x.startsWith('core.autocrlf')), 'autocrlf only when asked');
  assert.ok(pairs(plain).includes('filter.evil.clean=') && pairs(plain).includes('filter.evil.smudge=') && pairs(plain).includes('filter.evil.process='));
  assert.ok(pairs(plain).includes('merge.pwn.driver='));
  assert.ok(!pairs(plain).some((x) => x.startsWith('filter.mine.')), 'a global filter is the operator\'s own');
  const le = await GS.filterOverrides(fakeRun(ENTRIES).run, 'git', '.', {}, 1000, { lineEndings: true });
  assert.ok(pairs(le).includes('core.autocrlf=true'), 'status keeps the system autocrlf, so a CRLF checkout does not read dirty');
  assert.ok(pairs(le).includes('core.symlinks=false'));
});

test('git is found on PATH or the path cannot exist; there is no bare fallback', () => {
  const saved = { PATH: process.env.PATH, Path: process.env.Path };
  try {
    assert.ok(path.isAbsolute(GS.gitPath()));
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-nogit-'));
    process.env.PATH = empty;
    if (process.env.Path !== undefined) process.env.Path = empty;
    const none = GS.gitPath();
    assert.ok(path.isAbsolute(none) && none !== 'git' && !fs.existsSync(none), none);
    fs.rmSync(empty, { recursive: true, force: true });
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.Path !== undefined) process.env.Path = saved.Path;
  }
  assert.ok(fs.existsSync(GS.gitPath()), 'restored');
});

test('GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT and GIT_EXTERNAL_DIFF are not inherited by a core git call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-gitinj-')).split(path.sep).join('/');
  try {
    spawnSync('git', ['init', '-q', dir], { windowsHide: true });
    const names = ['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_EXTERNAL_DIFF'];
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    process.env.GIT_CONFIG_PARAMETERS = "'belay.probe'='injected'";
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'belay.probe2';
    process.env.GIT_CONFIG_VALUE_0 = 'injected';
    process.env.GIT_EXTERNAL_DIFF = 'evil';
    try {
      for (const k of ['belay.probe', 'belay.probe2']) {
        const r = await G.run(dir, ['config', '--get', k]);
        assert.strictEqual(r.stdout.trim(), '', `${k} was injected`);
      }
    } finally { for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; } }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
