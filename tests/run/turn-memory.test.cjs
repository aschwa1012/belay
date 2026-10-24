'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// turn-memory.test.cjs — review 3 of build step E1, finding F. A turn's memory write is an embed (about
// 0.5 s with voyage, seconds on an owner's first turn) and must not sit on the path the orchestrator's
// wait and wake depend on. r-f1: with memory.store slowed by 3,000 ms the turn's waiter resolves and the
// worker row lands before the store completes, and the store's row still appears afterwards. r-f2:
// shutdown with a store in flight completes within its 5,000 ms bound, names the queue it gave up on and
// elects no owner afterwards. Seeded from shutdown-drain-2.test.cjs (a real manager over a real core).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { teardown } = require('../helpers/teardown.cjs');
const os = require('node:os');
const path = require('node:path');

const { openCore } = require('../../src/core/index.cjs');
const { createRunManager } = require('../../src/run/index.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const USER_SETTINGS = path.join(__dirname, 'fixtures', 'user-settings.json');
const sleep = (ms, unref) => new Promise((r) => { const t = setTimeout(r, ms); if (unref) t.unref(); });

function sandbox(tag) {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), `belay-turn-memory-${tag}-`));
  const dataDir = path.join(sb, 'data').split(path.sep).join('/');
  const wt = path.join(sb, 'wt').split(path.sep).join('/');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  return { sb, dataDir, wt };
}

async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(25); }
  return false;
}

test('turn memory (r-f1): the waiter resolves and the row lands before a slow memory.store completes, and the row still appears', async () => {
  const { sb, dataDir, wt } = sandbox('f1');
  const runId = 'run-f1';
  let core, m;
  try {
    core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
    await core.run.attach({ adapter_pid: process.pid });
    const calls = [], stored = [];
    core.memory.store = async (a) => { calls.push(Date.now()); await sleep(3000, true); stored.push(a); return { id: 'stub' }; };
    m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: USER_SETTINGS } });
    const t0 = Date.now();
    await m.spawn({ substrate: 'claude-code', worktree: wt, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    const waited = Date.now() - t0;
    // Ordered by event, not by clock: a waiter that sat behind the 3,000 ms write resolves after it, with the text already
    // stored. (A wall bound here read the spawn's own time on a slow runner.)
    assert.strictEqual(stored.length, 0, `the turn's waiter resolved after ${waited} ms with the write already done: it sat behind the memory write`);
    assert.ok(await until(async () => (await core.worker.get({ worker_id: 'w1' })).state === 'running', 2000), 'the running row never landed');
    assert.strictEqual(stored.length, 0, 'the row landed while the slow store was still in flight');
    assert.ok(await until(() => stored.length === 1, 8000), 'the turn text never reached memory');
    assert.strictEqual(stored[0].type, 'turn');
    assert.ok(stored[0].text && stored[0].text.length > 0);
    assert.ok(stored[0].tags.includes('w1') && stored[0].tags.some((t) => /^turn:\d+$/.test(t)));
  } finally {
    if (m) await m.shutdown().catch(() => {});
    if (core && core.isOwner()) await core.shutdownOwner().catch(() => {});
    try { fs.rmSync(sb, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('turn memory (r-f2): shutdown with a store in flight completes within its bound and elects no owner afterwards', async () => {
  const { sb, dataDir, wt } = sandbox('f2');
  const runId = 'run-f2';
  let core, m;
  let bodyError = null;
  try {
    core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
    await core.run.attach({ adapter_pid: process.pid });
    const calls = [];
    core.memory.store = async () => { calls.push(Date.now()); await sleep(30000, true); return { id: 'stub' }; };
    m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: USER_SETTINGS } });
    await m.spawn({ substrate: 'claude-code', worktree: wt, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    assert.ok(await until(() => calls.length === 1, 3000), 'the memory write never started');
    const t0 = Date.now();
    const receipt = await m.shutdown();
    const ms = Date.now() - t0;
    // Shutdown gives the memory queue up after MEMORY_DRAIN_MS (5000); waiting out the store takes 30,000 ms. 20000 separates
    // them with 15 s of room for a slow runner.
    assert.ok(ms < 20000, `shutdown took ${ms} ms with a 30,000 ms store in flight`);
    assert.deepStrictEqual(receipt.memory_gave_up, ['w1'], 'the queue it gave up on is named');
    assert.strictEqual(core.isOwner(), false, 'shutdown must leave no owner elected in this process');
  } catch (e) { bodyError = e; throw e; } finally {
    // A failed assertion above must not leave the manager and its workers running; every step runs, the body's error wins.
    await teardown(bodyError, [() => m && m.shutdown(), () => core && core.isOwner() && core.shutdownOwner()]);
    try { fs.rmSync(sb, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// Amendment 4, items 1 and 2: two turns of one worker, the first turn's memory write slow, the second fast.
// `hold.m` is the manager, set before the first turn so a store stub can read its closed flag.
async function twoTurns(tag, storeStub, hold = {}) {
  const { sb, dataDir, wt } = sandbox(tag);
  const runId = `run-${tag}`;
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
  await core.run.attach({ adapter_pid: process.pid });
  core.memory.store = storeStub;
  const m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: USER_SETTINGS } });
  hold.m = m;
  await m.spawn({ substrate: 'claude-code', worktree: wt, prompt: 'one', worker_id: 'w1' });
  await m._waitTurn('w1', 8000);
  await m.message({ worker_id: 'w1', text: 'two' });
  await m._waitTurn('w1', 8000);
  return { sb, core, m };
}
const turnOf = (a) => (a.tags.find((t) => /^turn:\d+$/.test(t)) || '');

// The first write stays in flight until shutdown has flipped its closed flag (the event the drop keys on),
// never for a fixed time: a graceful stop that outlasts a fixed sleep let the second write start before the
// flag flipped. `stopDelayMs` stalls every worker-row write made during shutdown, as a slow runner does.
async function droppedAfterShutdown(tag, stopDelayMs) {
  const starts = [];
  const hold = {};
  let ctx;
  let bodyError = null;
  try {
    ctx = await twoTurns(tag, async (a) => {
      starts.push(turnOf(a));
      if (starts.length === 1) await until(() => hold.m._closed(), 30000);
      return { id: 'stub' };
    }, hold);
    assert.deepStrictEqual(starts, ['turn:1'], 'the first write is in flight and the second is queued behind it');
    if (stopDelayMs) { const write = ctx.core.worker.write.bind(ctx.core.worker); ctx.core.worker.write = async (row) => { await sleep(stopDelayMs); return write(row); }; }
    // Every error the record is given, in order: a late row restatement (the pid creation time, about a second after
    // launch) can be dropped after this one on a fast host, so the drop is looked for in the history, not as the last.
    const errs = []; const w1 = ctx.m._worker('w1'); let last = w1.lastError;
    Object.defineProperty(w1, 'lastError', { configurable: true, get: () => last, set: (v) => { last = v; errs.push(v); } });
    const receipt = await ctx.m.shutdown();
    assert.deepStrictEqual(receipt.memory_gave_up, [], 'the in-flight write finished inside the bound');
    await sleep(100);
    assert.deepStrictEqual(starts, ['turn:1'], 'the write queued before shutdown but started after it was dropped');
    assert.strictEqual(ctx.core.isOwner(), false, 'and no owner was elected');
    assert.ok(errs.some((e) => e && e.where === 'after-shutdown' && e.state === 'turn-memory'), `the drop is named: ${JSON.stringify(errs)}`);
  } catch (e) { bodyError = e; throw e; } finally {
    // Release the held first write and the workers even when an assertion failed; every step runs, the body's error wins.
    await teardown(bodyError, [() => hold.m && hold.m.shutdown(), () => ctx && ctx.core.isOwner() && ctx.core.shutdownOwner()]);
    if (ctx) { try { fs.rmSync(ctx.sb, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

test('turn memory (r-f3): a write queued before shutdown but started after it is dropped, and elects no owner', () => droppedAfterShutdown('f3', 0));

test('turn memory (r-f3): the drop holds when the graceful stop is slow (row writes stalled 3,000 ms)', () => droppedAfterShutdown('f3s', 3000));

test('turn memory (r-f4): a worker\'s memory writes land in turn order even when the first is slow', async () => {
  const done = [];
  let ctx;
  try {
    let n = 0;
    ctx = await twoTurns('f4', async (a) => { const mine = ++n; await sleep(mine === 1 ? 1500 : 0, true); done.push(turnOf(a)); return { id: 'stub' }; });
    const deadline = Date.now() + 8000;
    while (done.length < 2 && Date.now() < deadline) await sleep(25);
    assert.deepStrictEqual(done, ['turn:1', 'turn:2'], 'the fast second write must wait behind the slow first');
  } finally {
    if (ctx) { await ctx.m.shutdown().catch(() => {}); if (ctx.core.isOwner()) await ctx.core.shutdownOwner().catch(() => {}); try { fs.rmSync(ctx.sb, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
});
