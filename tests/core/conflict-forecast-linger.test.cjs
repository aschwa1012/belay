'use strict';
require('../helpers/tmp.cjs');
// conflict-forecast-linger.test.cjs — the forecast names the git children it started and that have not exited (git's arguments and age), the
// preparation's config reads included, and keeps what runCommand's tree kill reported. It only names: nothing here ends a child.
// The git calls are stand-in children (a node process that never exits), not git.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { forecast, makeTracker } = require('../../src/core/conflict-forecast.cjs');

const HANG = path.join(__dirname, 'fixtures', 'git-hang.cjs'); // sleeps forever

const start = (onChild) => { const c = spawn(process.execPath, [HANG], { stdio: 'ignore', windowsHide: true }); onChild(c); return c; };
const ended = (c) => (c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise((r) => c.once('exit', r)));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('the tracker names a running child by argv and age, and forgets it when it exits', { timeout: 20000 }, async () => {
  let kid;
  const tr = makeTracker((args, _cwd, _ms, o) => { kid = start(o.onChild); return ended(kid).then(() => ({ executable: true, exit_code: 0, stdout: '', stderr: '' })); });
  const run = tr.run(['merge-tree', '--write-tree', 'a', 'b'], process.cwd(), 1000, {});
  await pause(60);
  const live = tr.lingering();
  assert.strictEqual(live.length, 1);
  assert.strictEqual(live[0].argv, 'merge-tree --write-tree a b');
  assert.ok(live[0].ms >= 40, `age ${live[0].ms}`);
  kid.kill();
  await run;
  assert.deepStrictEqual(tr.lingering(), []);
});

test('the preparation git children are named too', { timeout: 20000 }, async () => {
  let kid;
  const tr = makeTracker(undefined, (cwd, ms, env, o) => { kid = start((c) => o.onChild(c, ['config', '--null', '--get-regexp', 'x'])); return ended(kid).then(() => ({ git: 'git', env, filters: [] })); });
  const prep = tr.prepare(process.cwd(), 1000);
  await pause(60);
  assert.deepStrictEqual(tr.lingering().map((c) => c.argv), ['config --null --get-regexp x']);
  kid.kill();
  await prep;
});

test('the tree kill report of a timed-out call is kept with its argv', async () => {
  const tr = makeTracker(async () => ({ executable: true, timed_out: true, tree_kill: { ms: 1234, snapshot_ms: 1100 } }));
  await tr.run(['merge-tree', 'x'], process.cwd(), 10, {});
  assert.deepStrictEqual(tr.killReports(), [{ argv: 'merge-tree x', ms: 1234, snapshot_ms: 1100 }]);
});

test('a forecast past its deadline answers unavailable and leaves its child alone, still named by lingering()', { timeout: 20000 }, async () => {
  let kid;
  const tracker = makeTracker((args, _cwd, _ms, o) => { kid = start(o.onChild); return ended(kid).then(() => ({ executable: true, exit_code: null, stdout: '', stderr: '' })); });
  const t0 = Date.now();
  const r = await forecast({ repo: process.cwd(), head: 'h', against: 'a', totalMs: 300, tracker, prepared: { git: 'git', env: process.env, filters: [] } });
  assert.match(r.unavailable, /deadline of \d+ ms passed/);
  assert.ok(Date.now() - t0 < 3000);
  assert.deepStrictEqual(r.lingering().map((c) => c.argv), ['--version']);
  assert.strictEqual(kid.exitCode, null, 'nothing ended the child');
  kid.kill();
  await r.exited;
  assert.deepStrictEqual(r.lingering(), []);
});

test('a child whose spawn failed is not kept as a running git', { timeout: 20000 }, async () => {
  const tr = makeTracker((args, _cwd, _ms, o) => new Promise((resolve) => {
    const c = spawn(path.join(__dirname, 'fixtures', 'no-such-git.exe'), [], { stdio: 'ignore', windowsHide: true });
    o.onChild(c);
    c.once('close', () => resolve({ executable: false, exit_code: null, stdout: '', stderr: '' }));
    c.once('error', () => {});
  }));
  await tr.run(['--version'], process.cwd(), 1000, {});
  assert.deepStrictEqual(tr.lingering(), []);
});
