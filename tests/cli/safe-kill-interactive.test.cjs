'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
process.env.BELAY_FAKE_CORE = require('node:path').resolve(__dirname, 'fakes', 'core-attach-late-rejects.cjs'); // read once, at cmd-run's load
// safe-kill-interactive.test.cjs — ADR 0039 review round, interactive orchestrator: the attach-failure kill
// must not act on a claude whose exit was already seen (the injected pidAlive says "alive", as a reused pid
// would), and the console's SIGHUP snapshot is reused only while it is young.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const H = require('./run-interactive-helpers.cjs');
const { makeConsole } = require('../../src/run/orchestrator-interactive.cjs');
const P = require('../../src/run/process.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { start, withRun } = H;

test('interactive: an attach that fails after claude already exited kills nothing, even if its pid reads as alive', async (t) => withRun(t, async (dir) => {
  const killed = [];
  const deps = { pidAlive: () => true, killPid: (target) => { killed.push(target && target.pid); return { signalled: true, identity: { via: 'handle' } }; } };
  const r = start(dir, { deps, env: { FAKE_HOLD_MS: '100' } });
  const res = await r.done;
  assert.match(res.json.ended_by, /attach write failed/, res.json.ended_by);
  assert.deepStrictEqual(killed, [], 'claude had exited before the attach failure; its pid is not ours to signal');
}));

test('console snapshot: the SIGHUP-time snapshot is reused while under 250 ms old and replaced by a fresh one after', async () => {
  const saved = P.processSnapshot; let calls = 0;
  P.processSnapshot = async () => { calls += 1; return new Map([[1, { ppid: 0, created: calls, image: 'x' }]]); };
  const ce = makeConsole();
  try {
    ce.install();
    process.emit('SIGHUP');
    await sleep(20);
    assert.strictEqual(calls, 1, 'the snapshot starts at the SIGHUP');
    const young = await ce.snapshot();
    assert.strictEqual(young.get(1).created, 1);
    assert.strictEqual(calls, 1, 'a young snapshot is reused');
    await sleep(300);
    const old = await ce.snapshot();
    assert.strictEqual(calls, 2, 'a snapshot older than 250 ms is not reused');
    assert.strictEqual(old.get(1).created, 2);
    // Usable for a kill with little budget left: in flight, or done and young. Stale is not.
    assert.strictEqual(ce.snapshotPending(), true, 'a snapshot done under 250 ms ago is usable');
    await sleep(300);
    assert.strictEqual(ce.snapshotPending(), false, 'a stale, finished snapshot is not');
  } finally { P.processSnapshot = saved; ce.dispose(); }
});
