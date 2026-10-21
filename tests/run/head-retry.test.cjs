'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// head-retry.test.cjs — build 12b (headsha), ADR 0029 amendment 2. A worker's head_sha and base_sha used to get
// one git attempt; under load it timed out and the sha was lost for good. The lookup now retries inside the
// shutdown drain bound, and a lookup that never answers records head_sha null with head_error. git is made to
// fail by wrapping child_process.execFile before the run modules load, so the same tests run against old code.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');

const realExecFile = cp.execFile;
let failFirst = 0; // how many `git rev-parse` calls to fail with a timeout before answering for real (failMode: 'spawn' is EAGAIN, 'timeout' a killed git)
let calls = 0;
let failMode = 'spawn';
let slowMs = 0; // when set, git answers after this long, or times out at its own timeout option if that is shorter
cp.execFile = function (file, args, opts, cb) {
  if (file === 'git' && Array.isArray(args) && args[0] === 'rev-parse') {
    calls += 1;
    if (slowMs) {
      const child = new EventEmitter();
      const t = opts.timeout || Infinity;
      if (t < slowMs) setTimeout(() => cb(Object.assign(new Error('timed out'), { killed: true }), '', ''), t);
      else setTimeout(() => realExecFile.call(this, file, args, opts, cb), slowMs);
      return child;
    }
    if (calls <= failFirst) {
      const child = new EventEmitter();
      setImmediate(() => cb(failMode === 'spawn' ? Object.assign(new Error('spawn git EAGAIN'), { code: 'EAGAIN' }) : Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }), '', ''));
      return child;
    }
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

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-head-retry-')).replace(/\\/g, '/');
  const git = (...a) => cp.spawnSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(git('init', '-q').status, 0);
  assert.strictEqual(git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--allow-empty', '-q', '-m', 'x').status, 0);
  return { dir, head: git('rev-parse', 'HEAD').stdout.trim() };
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

// captureBase false keeps the base lookup out of the call count unless a test asks for it.
async function runShutdown(repoDir, { captureBase = false } = {}) {
  const core = fakeCore();
  const w = newWorkerRecord({ id: 'w1', substrate: 'claude-code', worktree: repoDir, dataDir: __dirname, captureBase });
  const flags = { closed: false };
  const ctx = { core, runId: 'run-head-retry', adapterPid: process.pid, writeRow: null };
  ctx.writeRow = createWriteRow(ctx, flags);
  attach(w, fakeChild(), ctx);
  settle(w, 0, null, 'exit', ctx);
  const t0 = Date.now();
  await shutdown(new Map([['w1', w]]), { stop: async () => {}, core, clearPoll: () => {}, markClosed: () => { flags.closed = true; } });
  return { core, w, ms: Date.now() - t0 };
}

test('head_sha lands when the first git attempt fails to spawn (EAGAIN) and the second succeeds', async () => {
  const repo = makeRepo();
  try {
    failFirst = 1; calls = 0;
    const { core, w, ms } = await runShutdown(repo.dir);
    const last = core.writes[core.writes.length - 1];
    assert.strictEqual(last.head_sha, repo.head, `the last row carries the head, rows: ${JSON.stringify(core.writes.map((r) => r.head_sha))}`);
    assert.ok(!last.head_error, 'a head that arrived leaves no error');
    assert.ok(calls >= 2, `git was asked again, calls ${calls}`);
    assert.ok(ms < 5500, `shutdown stayed inside its drain bound, took ${ms} ms`);
    assert.ok(!(w.lastError && w.lastError.where === 'after-shutdown'), JSON.stringify(w.lastError));
  } finally { failFirst = 0; fs.rmSync(repo.dir, { recursive: true, force: true }); }
});

test('every attempt failing to spawn records head_sha null with a reason on a row', async () => {
  const repo = makeRepo();
  try {
    failFirst = 1000; calls = 0;
    const { core, ms } = await runShutdown(repo.dir);
    const last = core.writes[core.writes.length - 1];
    assert.strictEqual(last.head_sha, null);
    assert.match(String(last.head_error), /EAGAIN/, `the row says why, got ${JSON.stringify(last.head_error)}`);
    assert.strictEqual(calls, 3, `bounded retry, calls ${calls}`);
    assert.ok(ms < 5500, `shutdown stayed inside its drain bound, took ${ms} ms`);
  } finally { failFirst = 0; fs.rmSync(repo.dir, { recursive: true, force: true }); }
});

test('a base_sha that arrives after the terminal row was written lands in a follow-up row', async () => {
  const repo = makeRepo();
  try {
    failFirst = 1; calls = 0; // the first call is the record's own base lookup
    const { core } = await runShutdown(repo.dir, { captureBase: true });
    const last = core.writes[core.writes.length - 1];
    assert.strictEqual(last.base_sha, repo.head, `a row carries the late base, rows: ${JSON.stringify(core.writes.map((r) => r.base_sha))}`);
    assert.strictEqual(last.head_sha, repo.head);
  } finally { failFirst = 0; fs.rmSync(repo.dir, { recursive: true, force: true }); }
});

// Fix round 2: a timeout used the whole budget, so it is not retried; the row names it.
test('a timed-out git is asked once and the row names the timeout', async () => {
  const repo = makeRepo();
  try {
    failFirst = 1000; calls = 0; failMode = 'timeout';
    const { core } = await runShutdown(repo.dir);
    const last = core.writes[core.writes.length - 1];
    assert.strictEqual(calls, 1, `no retry after a timeout, calls ${calls}`);
    assert.strictEqual(last.head_sha, null);
    assert.match(String(last.head_error), /timed out/);
  } finally { failFirst = 0; failMode = 'spawn'; fs.rmSync(repo.dir, { recursive: true, force: true }); }
});

// Fix round 1 (review B1): one attempt used to get 5 s, so git answering in 2 to 5 s landed. A per-attempt cap
// below that lost the sha; an attempt now gets all the time left.
// Fix round 2 (review B2): the old single attempt had 5 s, so 4800 ms must land too.
for (const ms of [2500]) {
  test(`a git that answers in ${ms} ms still lands head_sha inside the drain bound`, async () => {
    const repo = makeRepo();
    try {
      failFirst = 0; calls = 0; slowMs = ms;
      const { core, ms: took } = await runShutdown(repo.dir);
      const last = core.writes[core.writes.length - 1];
      assert.strictEqual(last.head_sha, repo.head, `rows: ${JSON.stringify(core.writes.map((r) => [r.head_sha, r.head_error]))}`);
      // The head must land (asserted above); this tells a drain that ended when git answered (2500 ms) from one that sat out
      // its full HEAD_DRAIN_MS bound (5500 ms). Under 5000 leaves 2,500 ms of runner lag (CI max seen 3.76 s).
      assert.ok(took < 5000, `took ${took} ms`);
    } finally { slowMs = 0; fs.rmSync(repo.dir, { recursive: true, force: true }); }
  });
}

// The 4800 ms case goes straight to lookupSha: through shutdown it has about 200 ms against the 5 s drain bound.
test('lookupSha lands a sha from a git that answers in 4800 ms (the old single attempt had 5 s)', async () => {
  const repo = makeRepo();
  try {
    failFirst = 0; calls = 0; slowMs = 4800;
    const { lookupSha } = require('../../src/run/head-lookup.cjs');
    const r = await lookupSha(repo.dir);
    assert.deepStrictEqual(r, { sha: repo.head, reason: null });
    assert.strictEqual(calls, 1);
  } finally { slowMs = 0; fs.rmSync(repo.dir, { recursive: true, force: true }); }
});

// Integration regression: a worktree in no repository has no head to find, so no follow-up row is written for it
// (an extra row during a park or stop broke tests/run/park-2 and control).
test('a worktree in no repository writes no head follow-up row', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-head-norepo-')).split(path.sep).join('/');
  try {
    failFirst = 0; calls = 0;
    const { core } = await runShutdown(plain);
    assert.strictEqual(core.writes.length, 1, `only the terminal row, rows: ${JSON.stringify(core.writes.map((r) => [r.state, r.head_error]))}`);
  } finally { fs.rmSync(plain, { recursive: true, force: true }); }
});
