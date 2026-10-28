'use strict';
// review-claim-live.test.cjs — memory.reviewClaim takes over only a claim whose holder is gone (audit 0.3.1 C7). The core accepted
// any `replaces` equal to the newest claim id and never checked the holder, so any operator-role caller other than the shipped CLI
// could start a second paid reviewer beside a live one. The holder's creation time comes from a stubbed snapshot (the seam
// `reviewClaim.createdOf`), so no case depends on the host's process table.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor, deadPid } = require('./helpers.cjs');
const { openCore } = core('index.cjs');
const { reviewClaim } = core('review-claim.cjs');

let dir, op;
before(async () => { dir = sandbox(); op = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false }); });
after(async () => { reviewClaim.createdOf = undefined; try { await op.shutdownOwner(); } finally { await op.close(); cleanup(dir); } });

const busy = (reason) => (e) => { assert.strictEqual(e.code, 'E_BUSY', e.message); assert.strictEqual(e.detail.reason, reason); return true; };
const claim = (project, extra) => op.memory.reviewClaim({ project, pid: process.pid, job: 'archreview-a', ...extra });

test('a claim whose pid is alive and that recorded no creation time is not taken over', async () => {
  const first = await claim('p-live');
  await assert.rejects(claim('p-live', { job: 'archreview-b', replaces: first.claim.id }), busy('holder_alive'));
});

test('a claim whose pid is gone is taken over and names the claim it replaced', async () => {
  const first = await claim('p-dead', { pid: deadPid() });
  const second = await claim('p-dead', { job: 'archreview-b', replaces: first.claim.id });
  assert.strictEqual(second.replaced.id, first.claim.id);
});

test('a live pid is the holder when its creation time matches, another process when it does not, and unproven when unreadable', async () => {
  const first = await claim('p-created', { created: 1000 });
  reviewClaim.createdOf = async () => ({ created: 1000, image: 'node.exe' });
  await assert.rejects(claim('p-created', { job: 'b', replaces: first.claim.id }), busy('holder_alive'));
  reviewClaim.createdOf = async () => null;
  await assert.rejects(claim('p-created', { job: 'b', replaces: first.claim.id }), busy('holder_alive'));
  reviewClaim.createdOf = async () => ({ created: 2000, image: 'node.exe' });
  const taken = await claim('p-created', { job: 'b', replaces: first.claim.id });
  assert.strictEqual(taken.replaced.id, first.claim.id, 'a pid created at another time is another process: the claim is taken over');
  reviewClaim.createdOf = undefined;
});
