'use strict';
// adapter-pipe-bounds.test.cjs — the CLI's read timeouts for a restart and a resume include the relaunch's index embedding (up to
// SPAWN_EMBED_MS before the process starts), so a verb that took effect is never reported failed because the CLI stopped
// waiting first. The bounds are sums of the manager's own nested waits; this pins each addition.

const test = require('node:test');
const assert = require('node:assert');
const { restartBoundMs, resumeBoundMs, stopBoundMs, pauseBoundMs } = require('../../src/cli/adapter-pipe.cjs');
const { SPAWN_EMBED_MS } = require('../../src/core/spawn-bounds.cjs');
const MP = require('../../src/run/memory-preface.cjs');
const { SNAPSHOT_TIMEOUT_MS: T } = require('../../src/core/proc-identity.cjs');
// ADR 0048: each snapshot wait on a verb's path is charged 2 x T, T the snapshot timeout in force.
const SNAP_WAIT = 2 * T;

test('the spawn bound is one constant, shared by the manager and the CLI', () => {
  assert.strictEqual(MP.SPAWN_EMBED_MS, SPAWN_EMBED_MS);
  assert.strictEqual(SPAWN_EMBED_MS, 12000);
});

test('a resume\'s bound is its own waits plus the relaunch embed', () => {
  // the resume line's read 30,000; the old pid's wait 5,000; the ready window 60,000; failNoReady's exit-code hold 15,000;
  // the running row's write 30,000; the CLI's margin 5,000; one snapshot wait for a failed relaunch's kill; and the index embed
  assert.strictEqual(resumeBoundMs(), 30000 + 5000 + 60000 + 15000 + 30000 + 5000 + SNAP_WAIT + SPAWN_EMBED_MS);
  assert.strictEqual(resumeBoundMs(1000), 30000 + 5000 + 60000 + 15000 + 30000 + 5000 + 2000 + SPAWN_EMBED_MS, 'T is an argument');
});

test('a restart\'s bound is its stop, its ready window, the exit-code hold, the first turn and the relaunch embed', () => {
  const stopInternal = 10000 + Math.max(2000, Math.min(10000, 10000)) + 5000 + 5000 + SNAP_WAIT; // the stop's kill fallback takes one snapshot wait
  assert.strictEqual(restartBoundMs(20000), stopInternal + 5000 + 60000 + 15000 + 20000 + SPAWN_EMBED_MS);
  assert.strictEqual(restartBoundMs(30000) - restartBoundMs(20000), 10000, 'the first turn still adds one for one');
});

test('stop waits out a resume in flight, so its bound grows with the resume\'s', () => {
  assert.strictEqual(stopBoundMs(1000), 1000 + 2000 + 5000 + 5000 + SNAP_WAIT + Math.max(pauseBoundMs(), resumeBoundMs()));
  assert.ok(resumeBoundMs() > pauseBoundMs());
});
