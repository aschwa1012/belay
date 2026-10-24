'use strict';
require('../helpers/tmp.cjs');
// A park snapshots the worker's descendants before its graceful close (pause.cjs step 3) and kills the ones still alive after the exit.
// The snapshot is taken only while the child handle shows the worker running, and only of a root whose creation time is the worker's:
// a worker that ended during the interrupt window may have lost its pid to another process, whose children step 5 would then kill.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const P = require('../../src/run/process.cjs');
const CP = require('../../src/core/process.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const USER_SETTINGS = fwd(path.join(__dirname, 'fixtures', 'user-settings.json'));

test('descendantTargets with expectCreated: a root with another creation time has no descendants of ours', async () => {
  const snap = new Map([
    [100, { ppid: 1, created: 5000, image: 'node.exe' }],
    [101, { ppid: 100, created: 5100, image: 'node.exe' }],
  ]);
  const snapshot = async () => ({ snap, startSeq: Infinity });
  assert.deepEqual((await CP.descendantTargets(100, { snapshot })).map((d) => d.pid), [101], 'no expectation: the snapshot decides');
  assert.deepEqual((await CP.descendantTargets(100, { snapshot, expectCreated: 5000 })).map((d) => d.pid), [101], 'the same root');
  assert.deepEqual(await CP.descendantTargets(100, { snapshot, expectCreated: 4000 }), [], 'another process holds the root pid');
  assert.deepEqual(await CP.descendantTargets(102, { snapshot, expectCreated: 4000 }), [], 'the root is gone');
});

function setup(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-parkdesc-'));
  fs.mkdirSync(path.join(d, 'wt'));
  const core = createFakeCore();
  const m = createRunManager({ core, dataDir: fwd(d), runId: 'run-parkdesc', paths: { claudeExe: FAKE, userSettings: USER_SETTINGS } });
  const saved = P.descendantTargets;
  const calls = [];
  P.descendantTargets = async (pid, opts) => { calls.push({ pid, opts }); return saved(pid, opts); };
  t.after(async () => { P.descendantTargets = saved; await m.shutdown().catch(() => {}); try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* tmp */ } });
  return { core, m, worktree: fwd(path.join(d, 'wt')), calls };
}

test('a park snapshots the descendants of the running worker, naming its creation time', async (t) => {
  const { m, worktree, calls } = setup(t);
  await m.spawn({ substrate: 'claude-code', worktree, prompt: 'one', worker_id: 'w1' });
  await m._waitTurn('w1', 20000);
  const w = m._worker('w1');
  await w.pidCreatedPromise;
  const pid = w.pid;
  const r = await m.pause({ worker_id: 'w1', by: 'operator:1' });
  assert.equal(r.paused, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pid, pid);
  assert.equal(calls[0].opts.expectCreated, w.pidCreated);
});

test('a park whose worker ended during the interrupt window takes no descendant snapshot', async (t) => {
  const { core, m, worktree, calls } = setup(t);
  await m.spawn({ substrate: 'claude-code', worktree, prompt: 'one', worker_id: 'w1' });
  await m._waitTurn('w1', 20000);
  const w = m._worker('w1');
  const child = w.child;
  const write = core.worker.write;
  let ended = false;
  core.worker.write = async (r) => {
    const out = await write(r);
    if (r.id === 'w1' && r.state === 'stopping' && !ended) { // the park's step 1b: the worker ends here, by its own handle
      ended = true;
      await new Promise((res) => { child.once('exit', res); child.kill(); });
    }
    return out;
  };
  const r = await m.pause({ worker_id: 'w1', by: 'operator:1', interrupt_timeout_ms: 1000 });
  assert.ok(ended);
  assert.equal(r.paused, true);
  assert.deepEqual(calls, [], 'no snapshot of whatever process holds the pid now');
  assert.deepEqual(r.descendants.before_close, []);
});
