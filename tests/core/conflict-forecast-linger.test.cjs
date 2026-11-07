'use strict';
require('../helpers/tmp.cjs');
// conflict-forecast-linger.test.cjs — a git child of a forecast that does not exit is ended through its live handle when the forecast
// passes its deadline, nothing is started after the answer, and the forecast can say which command is still running and for how long.
// The git calls are stand-in children (a node process that never exits), not git.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { forecast, makeTracker } = require('../../src/core/conflict-forecast.cjs');

const HANG = path.join(__dirname, 'fixtures', 'git-hang.cjs'); // sleeps forever

// A runner shaped like safeGit that starts a stand-in child; it resolves when the child exits, as runCommand does.
function hanging() {
  const kids = [];
  const runner = (args, _cwd, _ms, o) => new Promise((resolve) => {
    const c = spawn(process.execPath, [HANG], { stdio: 'ignore', windowsHide: true });
    kids.push(c);
    o.onChild(c);
    c.once('exit', () => resolve({ executable: true, exit_code: null, signal: 'SIGTERM', timed_out: true, stdout: '', stderr: '' }));
  });
  return { runner, kids };
}
const exited = (c) => (c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise((r) => c.once('exit', r)));

test('the tracker names a running child by argv and age, and release ends it through its handle and starts nothing more', { timeout: 20000 }, async () => {
  const { runner, kids } = hanging();
  const tr = makeTracker(Date.now() + 60000, runner);
  const first = tr.run(['merge-tree', '--write-tree', 'a', 'b'], process.cwd(), 1000, {});
  await new Promise((r) => setTimeout(r, 50));
  const live = tr.lingering();
  assert.strictEqual(live.length, 1);
  assert.strictEqual(live[0].argv, 'merge-tree --write-tree a b');
  assert.ok(live[0].ms >= 40, `age ${live[0].ms}`);
  tr.release();
  await exited(kids[0]);
  await first;
  assert.deepStrictEqual(tr.lingering(), []);
  const after = await tr.run(['--version'], process.cwd(), 1000, {});
  assert.strictEqual(after.executable, false);
  assert.strictEqual(kids.length, 1, 'no child was started after release');
});

test('a forecast that passes its deadline with a git child that never exits answers unavailable, ends the child, and its exited promise settles', { timeout: 20000 }, async () => {
  const { runner, kids } = hanging();
  const tracker = makeTracker(Date.now() + 300, runner);
  const t0 = Date.now();
  const r = await forecast({ repo: process.cwd(), head: 'h', against: 'a', totalMs: 300, deadline: Date.now() + 300, tracker, prepared: { git: 'git', env: process.env, filters: [] } });
  assert.match(r.unavailable, /deadline of \d+ ms passed/);
  assert.ok(Date.now() - t0 < 3000);
  assert.strictEqual(kids.length, 1);
  await exited(kids[0]);
  await r.exited;
  assert.deepStrictEqual(r.lingering(), []);
});
