'use strict';
require('../helpers/git-env.cjs'); // isolated git config for every fixture
require('../helpers/tmp.cjs'); // own spawn register and tmp cleanup
// git-safe-register.test.cjs — a git call the core makes in a worker's or an integration tree is a check process (its config and hooks
// are a worker's code), whether it runs plainly or through git-safe's hardened path: every spawn of it, the config read included,
// is recorded in the spawn register as kind `check`; `register: null` records none.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const CR = require('../../src/core/check-register.cjs');
const G = require('../../src/core/git.cjs');
const S = require('../../src/core/git-safe.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-git-register-')).replace(/\\/g, '/');
cp.spawnSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });

// Counts the register's begin calls by kind while a callback runs; the record itself is not written.
async function recorded(fn) {
  const real = CR.begin;
  const kinds = [];
  CR.begin = (child, kind) => { kinds.push(kind); return () => {}; };
  try { await fn(); } finally { CR.begin = real; }
  return kinds;
}

test('a plain git call is registered as a check by default and not when register is null', async () => {
  const on = await recorded(() => G.run(dir, ['rev-parse', '--git-dir']));
  assert.deepStrictEqual(on, ['check']);
  const off = await recorded(() => G.run(dir, ['rev-parse', '--git-dir'], { register: null }));
  assert.deepStrictEqual(off, []);
});

test('a hardened status registers the config read and the status itself', async () => {
  const kinds = await recorded(async () => { const r = await G.run(dir, ['status', '--porcelain']); assert.ok(r.ok, r.stderr); });
  assert.ok(kinds.length >= 2, `a config read and a status, got ${JSON.stringify(kinds)}`);
  assert.ok(kinds.every((k) => k === 'check'), JSON.stringify(kinds));
});

test('safeGit registers its spawns by default and none when register is null', async () => {
  const on = await recorded(() => S.safeGit(['rev-parse', '--git-dir'], dir, 30000));
  assert.ok(on.length >= 2 && on.every((k) => k === 'check'), JSON.stringify(on));
  const off = await recorded(() => S.safeGit(['rev-parse', '--git-dir'], dir, 30000, { register: null }));
  assert.deepStrictEqual(off, []);
});
