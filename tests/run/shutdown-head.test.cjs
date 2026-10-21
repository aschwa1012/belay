'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// shutdown-head.test.cjs — ADR 0029 amendment 2 items 3 and 4 (S8-fix-3). Item 3: the adapter's shutdown
// stops a store owner only when this process holds it. Item 4: a graceful shutdown waits for each worker's
// pending head request, so the follow-up row lands before the write path is marked closed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-shutdown-head-')).replace(/\\/g, '/');
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(git('init', '-q').status, 0);
  assert.strictEqual(git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--allow-empty', '-q', '-m', 'x').status, 0);
  return { dir, head: git('rev-parse', 'HEAD').stdout.trim() };
}

function fakeCore({ isOwner }) {
  const writes = [];
  const core = {
    worker: { write: async (row) => { writes.push(row); return { ...row, seq: writes.length }; } },
    shutdownCalls: 0,
    shutdownOwner: async () => { core.shutdownCalls += 1; },
    writes,
  };
  if (isOwner !== undefined) core.isOwner = () => isOwner;
  return core;
}

async function runShutdown(core, worktree) {
  const w = newWorkerRecord({ id: 'w1', substrate: 'claude-code', worktree, dataDir: __dirname });
  const flags = { closed: false };
  const ctx = { core, runId: 'run-shutdown-head', adapterPid: process.pid, writeRow: null };
  ctx.writeRow = createWriteRow(ctx, flags);
  attach(w, fakeChild(), ctx);
  settle(w, 0, null, 'exit', ctx);
  await shutdown(new Map([['w1', w]]), { stop: async () => {}, core, clearPoll: () => {}, markClosed: () => { flags.closed = true; } });
  return w;
}

test('shutdown leaves a store owner it does not hold running, and stops one it holds', async () => {
  const notOwner = fakeCore({ isOwner: false });
  await runShutdown(notOwner, __dirname);
  assert.strictEqual(notOwner.shutdownCalls, 0, 'an adapter that is not the owner must not send shutdown to the owner');
  const owner = fakeCore({ isOwner: true });
  await runShutdown(owner, __dirname);
  assert.strictEqual(owner.shutdownCalls, 1);
});

test('shutdown does not stop a store owner when the core has no isOwner (fail closed)', async () => {
  const core = fakeCore({});
  await runShutdown(core, __dirname);
  assert.strictEqual(core.shutdownCalls, 0, 'fail closed: a core that does not say it holds the owner must never have shutdownOwner called');
});

test('a graceful shutdown lands the stopped row\'s head follow-up itself, before the write path closes', async () => {
  const repo = makeRepo();
  try {
    const core = fakeCore({ isOwner: true });
    const w = await runShutdown(core, repo.dir);
    assert.ok(core.writes.length >= 2, `the terminal row and its head follow-up were written, got ${core.writes.length}`);
    const last = core.writes[core.writes.length - 1];
    assert.strictEqual(last.head_sha, repo.head, 'the last row carries the worktree head');
    assert.ok(!(w.lastError && w.lastError.where === 'after-shutdown'), `no write was dropped: ${JSON.stringify(w.lastError)}`);
  } finally { fs.rmSync(repo.dir, { recursive: true, force: true }); }
});

// Build 12 a2 (review 1, B1): the base_sha rev-parse newWorkerRecord starts has the worktree as its cwd, and a
// bare rmSync of the repo threw EPERM while it still ran. Shutdown now waits for it. Forced delay: the record's
// own base promise resolves 700 ms late; the old shutdown returned without it.
test('shutdown waits for the base_sha git child it started, so nothing holds the worktree after it returns', async () => {
  const repo = makeRepo();
  try {
    const core = fakeCore({ isOwner: true });
    const w = newWorkerRecord({ id: 'w1', substrate: 'claude-code', worktree: repo.dir, dataDir: __dirname });
    assert.ok(w.basePromise, 'the record keeps its base_sha request');
    let baseDone = false;
    const real = w.basePromise;
    w.basePromise = real.then(() => new Promise((r) => setTimeout(r, 700))).then(() => { baseDone = true; });
    const flags = { closed: false };
    const ctx = { core, runId: 'run-shutdown-head', adapterPid: process.pid, writeRow: null };
    ctx.writeRow = createWriteRow(ctx, flags);
    attach(w, fakeChild(), ctx);
    settle(w, 0, null, 'exit', ctx);
    await shutdown(new Map([['w1', w]]), { stop: async () => {}, core, clearPoll: () => {}, markClosed: () => { flags.closed = true; } });
    assert.strictEqual(baseDone, true, 'shutdown returned before the base_sha request settled');
  } finally { fs.rmSync(repo.dir, { recursive: true, force: true }); }
});
