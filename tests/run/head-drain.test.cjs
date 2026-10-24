'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// head-drain.test.cjs — the shutdown head drain must outlast a git killed at its own 5000 ms timeout. git is a
// stub that hangs until execFile's timeout kills it, the kill completing KILL_LAG_MS late; execFile is wrapped
// before the run modules load, as head-retry.test.cjs does.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');

const realExecFile = cp.execFile;
let killLagMs = 250; // how long after its timeout the killed git's callback arrives; Infinity never calls back
cp.execFile = function (file, args, opts, cb) {
  if (file === 'git' && Array.isArray(args) && args[0] === 'rev-parse') {
    const child = new EventEmitter();
    if (Number.isFinite(killLagMs)) {
      setTimeout(() => cb(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }), '', ''), (opts.timeout || 0) + killLagMs);
    }
    return child;
  }
  return realExecFile.call(this, file, args, opts, cb);
};
for (const f of ['git-facts', 'head-lookup', 'write-row', 'worker', 'exit', 'lifecycle']) {
  try { delete require.cache[require.resolve(`../../src/run/${f}.cjs`)]; } catch {}
}
const { newWorkerRecord, attach } = require('../../src/run/worker.cjs');
const { settle } = require('../../src/run/exit.cjs');
const { shutdown } = require('../../src/run/lifecycle.cjs');
const { createWriteRow } = require('../../src/run/write-row.cjs');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.pid = 40000 + Math.floor(Math.random() * 10000);
  return child;
}

function fakeCore() {
  const writes = [];
  return {
    writes,
    worker: { write: async (row) => { writes.push(row); return { ...row, seq: writes.length }; } },
    shutdownOwner: async () => {},
    isOwner: () => true,
  };
}

async function runShutdown(dir) {
  const core = fakeCore();
  const w = newWorkerRecord({ id: 'w1', substrate: 'claude-code', worktree: dir, dataDir: __dirname, captureBase: false });
  const flags = { closed: false };
  const ctx = { core, runId: 'run-head-drain', adapterPid: process.pid, writeRow: null };
  ctx.writeRow = createWriteRow(ctx, flags);
  attach(w, fakeChild(), ctx);
  settle(w, 0, null, 'exit', ctx);
  const t0 = Date.now();
  await shutdown(new Map([['w1', w]]), { stop: async () => {}, core, clearPoll: () => {}, markClosed: () => { flags.closed = true; } });
  return { core, w, ms: Date.now() - t0 };
}

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-head-drain-')).split(path.sep).join('/');
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

test('a git killed at its 5000 ms timeout 250 ms late still lands its head_error row before shutdown closes', async () => {
  const dir = makeDir();
  try {
    killLagMs = 250;
    const { core, w, ms } = await runShutdown(dir);
    const last = core.writes[core.writes.length - 1];
    assert.ok(core.writes.length >= 2, `rows: ${JSON.stringify(core.writes.map((r) => [r.state, r.head_sha, r.head_error]))}`);
    assert.strictEqual(last.head_sha, null);
    assert.match(String(last.head_error), /timed out after 5000 ms/, JSON.stringify(last.head_error));
    assert.ok(!(w.lastError && w.lastError.where === 'after-shutdown'), JSON.stringify(w.lastError));
    // The drain is bounded at HEAD_DRAIN_MS (5500). Here git calls back at about 5250 ms, so an unbounded drain would end
    // near 5.3 s; only a drain that ran twice (about 11,000 ms) is told apart here, and the never-calls-back test below
    // pins the bound itself. 9000 leaves a slow runner 3,500 ms of lag over the bound and still fails that. (6500 left 1,000.)
    assert.ok(ms < 9000, `shutdown took ${ms} ms`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a git that never calls back holds shutdown for one drain, not two', async () => {
  const dir = makeDir();
  try {
    killLagMs = Infinity;
    const { ms } = await runShutdown(dir);
    // Same separation as above: the bound is 5500 ms, a second drain would make it 11,000 ms.
    assert.ok(ms <= 9000, `shutdown took ${ms} ms`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
