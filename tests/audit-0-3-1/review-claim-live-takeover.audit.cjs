'use strict';
// review-claim-live-takeover.audit.cjs — audit 0.3.1, core finding C7. Not globbed by `npm test` (*.audit.cjs).
// Run: node --test tests/audit-0-3-1/review-claim-live-takeover.audit.cjs
//
// memory.reviewClaim takes over a running claim whenever the caller names its id in `replaces` (review-claim.cjs:94-99). The core
// never checks that the claim's process is gone, although the file's contract says a claim is taken over only "whose process is
// gone" and that liveness is proved by identity. Here the holder is this very test process, alive, and the takeover succeeds.

const { test } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { openCore } = core('index.cjs');

test('C7: a claim whose process is alive is not taken over', async () => {
  const dir = sandbox();
  const op = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
  try {
    const first = await op.memory.reviewClaim({ project: 'p1', pid: process.pid, job: 'archreview-a' });
    let second;
    try { second = { ok: true, value: await op.memory.reviewClaim({ project: 'p1', pid: process.pid, job: 'archreview-b', replaces: first.claim.id }) }; }
    catch (e) { second = { ok: false, code: e.code }; }
    console.log(JSON.stringify({ first: first.claim.id, holder_pid_alive: true, second: second.ok ? { claim: second.value.claim.id, replaced: second.value.replaced } : second }));
    assert.strictEqual(second.ok, false, 'a live holder refuses the takeover');
  } finally {
    try { await op.shutdownOwner(); } finally { await op.close(); cleanup(dir); }
  }
});
