'use strict';
// Build step H1: releaseCore() in tests/cli/stop-helpers.cjs.
// A test core that won the election owns the store; close() only drops the client, so it must be shut
// down. A core that is only a client of someone else's owner must never end that owner.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { openCore } = require('../../src/core/index.cjs');
const { ping } = require('../../src/core/ping.cjs');
const { sandbox, cleanup, releaseCore } = require('./stop-helpers.cjs');

const caller = (runId) => ({ role: 'orchestrator', run_id: runId, pid: process.pid });

test('releaseCore: a core that won the election is shut down, its lock removed, and a second call is a no-op', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  let core = null;
  try {
    core = await openCore({ dataDir, caller: caller('run-h3') });
    const won = await core.becomeOwner();
    assert.strictEqual(won.owner, true, `the core must have won the election: ${JSON.stringify(won)}`);
    assert.ok(core.isOwner());
    assert.ok(fs.existsSync(`${dataDir}/owner.lock`), 'owner.lock must exist while the core owns the store');
    assert.strictEqual((await ping(dataDir, 2000)).ok, true, 'the owner must answer a bounded ping before release');

    await releaseCore(core);
    assert.strictEqual(core.isOwner(), false, 'the core must no longer be the owner');
    assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'owner.lock is still present after releaseCore');
    assert.strictEqual((await ping(dataDir, 2000)).ok, false, 'the owner still answers a ping after releaseCore');

    await releaseCore(core); // second call: nothing to stop, must not throw
    await releaseCore(null); // and a core that was never opened is skipped
    assert.ok(!fs.existsSync(`${dataDir}/owner.lock`));
  } finally {
    if (core && core.isOwner()) { try { await core.shutdownOwner(); } catch { /* best effort */ } }
    if (core) { try { await core.close(); } catch { /* best effort */ } }
    cleanup(dir);
  }
});

test('releaseCore: a client core leaves a foreign owner running', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  let planted = null;
  let client = null;
  try {
    planted = await openCore({ dataDir, caller: caller('run-h4') });
    assert.strictEqual((await planted.becomeOwner()).owner, true, 'the planted core must own the store');

    client = await openCore({ dataDir, caller: { role: 'operator', run_id: 'run-h4', pid: process.pid } });
    const seen = await client.becomeOwner();
    assert.strictEqual(seen.owner, false, `the second core must be a client of the planted owner: ${JSON.stringify(seen)}`);
    assert.strictEqual(client.isOwner(), false);

    await releaseCore(client);
    assert.strictEqual(client.isOwner(), false);
    assert.ok(planted.isOwner(), 'the planted core lost ownership when a client was released');
    assert.ok(fs.existsSync(`${dataDir}/owner.lock`), 'owner.lock vanished when a client core was released');
    assert.strictEqual((await ping(dataDir, 2000)).ok, true, 'the planted owner stopped answering after a client core was released');
  } finally {
    if (client) { try { await client.close(); } catch { /* best effort */ } }
    if (planted) {
      try { if (planted.isOwner()) await planted.shutdownOwner(); } catch { /* best effort */ }
      try { await planted.close(); } catch { /* best effort */ }
    }
    cleanup(dir);
  }
});
