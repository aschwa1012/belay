'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// base-error.test.cjs — a worker row says why it has no base_sha (base_error), mirroring head_error. git is made to
// fail by wrapping child_process.execFile before the run modules load, exactly as head-retry.test.cjs does.

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-base-error-')).replace(/\\/g, '/');
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
  const ctx = { core, runId: 'run-base-error', adapterPid: process.pid, writeRow: null };
  ctx.writeRow = createWriteRow(ctx, flags);
  attach(w, fakeChild(), ctx);
  settle(w, 0, null, 'exit', ctx);
  const t0 = Date.now();
  await shutdown(new Map([['w1', w]]), { stop: async () => {}, core, clearPoll: () => {}, markClosed: () => { flags.closed = true; } });
  return { core, w, ms: Date.now() - t0 };
}

test('every base lookup attempt failing to spawn records base_error on the record and on the last row', async () => {
  const repo = makeRepo();
  try {
    failFirst = 1000; calls = 0;
    const { core, w } = await runShutdown(repo.dir, { captureBase: true });
    const last = core.writes[core.writes.length - 1];
    assert.match(String(w.baseError), /EAGAIN/, `the record says why, got ${JSON.stringify(w.baseError)}`);
    assert.match(String(last.base_error), /EAGAIN/, `the last row says why, rows: ${JSON.stringify(core.writes.map((r) => [r.base_sha, r.base_error]))}`);
    assert.ok(last.base_sha == null, 'the last row has no base_sha');
  } finally { failFirst = 0; fs.rmSync(repo.dir, { recursive: true, force: true }); }
});

test('a base_sha that lands is written with base_error null', async () => {
  const repo = makeRepo();
  try {
    failFirst = 0; calls = 0;
    const { core } = await runShutdown(repo.dir, { captureBase: true });
    const withBase = core.writes.filter((r) => r.base_sha != null);
    assert.ok(withBase.some((r) => r.base_sha === repo.head), `a row carries the base, rows: ${JSON.stringify(core.writes.map((r) => r.base_sha))}`);
    for (const r of withBase) assert.strictEqual(r.base_error, null);
  } finally { failFirst = 0; fs.rmSync(repo.dir, { recursive: true, force: true }); }
});

test('a worktree in no repository keeps base_error on the record and writes no extra row', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-base-norepo-')).split(path.sep).join('/');
  try {
    failFirst = 0; calls = 0;
    const { core, w } = await runShutdown(plain, { captureBase: true });
    assert.strictEqual(core.writes.length, 1, `only the terminal row, rows: ${JSON.stringify(core.writes.map((r) => [r.state, r.base_error]))}`);
    assert.strictEqual(w.baseError, 'not in a git repository');
  } finally { failFirst = 0; fs.rmSync(plain, { recursive: true, force: true }); }
});
