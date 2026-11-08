'use strict';
// fix-chain-root.test.cjs — a chain of fixes (a fix naming an earlier fix in `repairs`) counts its rounds on the work it began
// from, both when task.create enforces fix_hard_cap and when the derived `review` reads the rounds used.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch;
before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, fix_hard_cap: 2, max_fix_rounds: 2 });
});
after(async () => {
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

test('a fix of a fix counts on the original work: the review reads two rounds used, and a third fix is refused', async () => {
  const work = await orch.task.create({ spec: 'work' });
  const f1 = await orch.task.create({ spec: 'fix 1', repairs: work.id });
  const f2 = await orch.task.create({ spec: 'fix 2', repairs: f1.id });
  await orch.task.create({ spec: 'review of the last fix', depends_on: [f2.id], acceptance: { verdict: true } });
  const review = (await orch.task.get({ task_id: f2.id })).review;
  assert.strictEqual(review.rounds, 2);
  assert.strictEqual(review.fix_rounds_used, 2);
  assert.strictEqual((await orch.task.get({ task_id: work.id })).review.fix_rounds_used, 2, 'the work and its last fix read the same count');
  await assert.rejects(orch.task.create({ spec: 'fix 3', repairs: f2.id }), (e) => e.code === 'E_FIX_ROUNDS' && e.detail.fix_rounds_used === 2 && e.message.startsWith(`task ${work.id} already has 2 fix tasks`));
});
