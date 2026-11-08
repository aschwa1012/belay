'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// A start or restart that finds its worker's pid gone waits for the held exit event (awaitSettled), then failNoReady waits for the
// exit code (awaitExitCode). The two together may not exceed EXIT_CODE_WAIT_MS, the allowance restartBoundMs makes for them.
// An injected clock stands in for the time the first wait took, so nothing here sleeps.

const test = require('node:test');
const assert = require('node:assert');
const W = require('../../src/run/worker.cjs');

const rec = () => W.newWorkerRecord({ id: 'w-eb', substrate: 'claude-code', worktree: 'C:/x', dataDir: 'C:/x', captureBase: false });
const clock = (...ticks) => { const q = ticks.slice(); return () => q.shift(); };

test('the code wait takes only what the settle wait left of EXIT_CODE_WAIT_MS', async () => {
  const w = rec();
  w.settled = true; // nothing to wait for: the clock alone says the wait took 8,000 ms
  await W.awaitSettled(w, clock(1000, 9000));
  assert.strictEqual(w.settleWaitedMs, 8000);
  const left = W.exitCodeBudgetMs(w);
  assert.strictEqual(left, W.EXIT_CODE_WAIT_MS - 8000);
  assert.ok(8000 + left <= W.EXIT_CODE_WAIT_MS);
  assert.strictEqual(w.settleWaitedMs, 0, 'consumed once');
});

test('a settle wait that used the whole allowance leaves no code wait, and never a negative one', async () => {
  const w = rec();
  w.settled = true;
  await W.awaitSettled(w, clock(0, 20000));
  assert.strictEqual(W.exitCodeBudgetMs(w), 0);
});

test('without a settle wait the code wait is the full allowance', () => {
  assert.strictEqual(W.exitCodeBudgetMs(rec()), W.EXIT_CODE_WAIT_MS);
});

test('the worst case of both waits fits the allowance restartBoundMs makes', async () => {
  const { holdBoundMs, POLL_MS } = require('../../src/core/exit-hold.cjs');
  const w = rec();
  w.settled = true;
  await W.awaitSettled(w, clock(0, holdBoundMs() + POLL_MS + 1000)); // the longest the settle wait can run
  assert.ok(holdBoundMs() + POLL_MS + 1000 + W.exitCodeBudgetMs(w) <= W.EXIT_CODE_WAIT_MS);
});

test('failNoReady takes its code wait from exitCodeBudgetMs, not the full allowance', async () => {
  const { createStartFail } = require('../../src/run/start-fail.cjs');
  const asked = [];
  const real = W.exitCodeBudgetMs; const realWait = W.awaitExitCode;
  W.exitCodeBudgetMs = () => 7;
  W.awaitExitCode = async (w, ms) => { asked.push(ms); };
  try {
    const w = rec();
    w.settled = true; w.settledChild = {}; w.deathEstablishedBy = 'pid-poll'; w.exitEventSeen = new Promise(() => {});
    w.pid = null; w.state = 'dead';
    const { failNoReady } = createStartFail({ core: { bind: {} }, writeRow: async () => null });
    await assert.rejects(failNoReady(w, 'no ready'), (e) => e.code === 'E_NO_READY');
    assert.deepStrictEqual(asked, [7]);
  } finally { W.exitCodeBudgetMs = real; W.awaitExitCode = realWait; }
});

test('a new launch clears the time an earlier settle wait left on the record', () => {
  const src = require('node:fs').readFileSync(require.resolve('../../src/run/manager.cjs'), 'utf8');
  assert.match(src, /w\.settled = false;[^\n]*w\.settleWaitedMs = 0;/);
});
