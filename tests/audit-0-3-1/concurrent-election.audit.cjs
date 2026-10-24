'use strict';
// concurrent-election.audit.cjs — audit 0.3.1, core finding C1. Not globbed by `npm test` (*.audit.cjs).
// Run: node --test tests/audit-0-3-1/concurrent-election.audit.cjs
//
// Two writes issued at once by one Core that holds no owner (the orchestrator adapter serving two parallel tool calls on its
// first writes) each build a Client and each elect. acquireLock skips the "holder is alive" check when the lock names this
// very process (lock.cjs:191), so the second Owner "takes over" the first's live lock in place. Expected: one owner, both
// writes succeed, owner.lock names the serving owner.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { openCore } = core('index.cjs');
const { readOwnerLock } = core('lock.cjs');

test('C1: two concurrent first writes from one Core elect one owner and both succeed', async () => {
  const dir = sandbox();
  const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  try {
    const results = await Promise.allSettled([orch.task.create({ spec: 'a' }), orch.task.create({ spec: 'b' })]);
    const lockAfter = readOwnerLock(dir);
    const report = {
      results: results.map(r => (r.status === 'fulfilled' ? { ok: true, id: r.value.id } : { ok: false, code: r.reason.code, message: r.reason.message })),
      lock_present: fs.existsSync(path.join(dir, 'owner.lock')),
      lock_token: lockAfter && lockAfter.token,
      owner_is_this_core: orch.isOwner(),
    };
    console.log(JSON.stringify(report, null, 2));
    assert.ok(results.every(r => r.status === 'fulfilled'), 'both writes succeed');
    assert.ok(report.lock_present, 'the serving owner still has its lock on disk');
  } finally {
    try { await orch.shutdownOwner(); } catch { /* best effort */ }
    await orch.close();
    cleanup(dir);
  }
});
