'use strict';
// spawn-self-review.test.cjs — ADR 0058 decision 2 on the spawn path: a spawn whose task_id is a review of work its own worker id
// held a lease on is refused E_SELF_REVIEW by the spawn's check_only call, before anything is written. A worker id is reusable within
// its run once stopped (a later adapter of the same run), which is how a coder's id can come back as a reviewer's.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { sandbox, cleanup, callerFor } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const RUN = 'spawn-self-review-run';
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };
const paths = { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') };

test('a spawn of a review task under the coder\'s own worker id is refused E_SELF_REVIEW with nothing written', { timeout: 120000 }, async () => {
  const dir = sandbox();
  const wt = path.join(dir, 'wt').split(path.sep).join('/');
  fs.mkdirSync(wt, { recursive: true });
  const core = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
  let coder = null;
  const clients = [];
  try {
    await core.run.attach({ adapter_pid: process.pid });
    const work = await core.task.create({ spec: 'the work', acceptance: PASS, files_owned: [] });
    // The coder c1 works the task and hands it back (no result, so no release evaluation races the one below).
    // Each manager gets its own client of the store, so its shutdown leaves the test's owner serving (it stops only an owner it holds).
    const client = () => openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
    const c1 = await client();
    clients.push(c1);
    assert.strictEqual(c1.isOwner(), false, 'the test core holds the owner');
    const m1 = createRunManager({ core: c1.harness(), dataDir: dir, runId: RUN, paths });
    try {
      await m1.spawn({ substrate: 'claude-code', worktree: wt, prompt: 'code it', worker_id: 'c1', task_id: work.id });
      const lease = (await core.task.get({ task_id: work.id })).lease;
      coder = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'c1', run_id: RUN }), embed: false });
      await coder.lease.release({ lease_id: lease.id, reason: 'done' });
      assert.strictEqual((await core.task.evaluate({ task_id: work.id, worktree: wt })).state, 'done');
    } finally { await m1.shutdown(); }
    const stopped = await core.worker.get({ worker_id: 'c1' });
    assert.strictEqual(stopped.state, 'stopped');
    const review = await core.task.create({ spec: 'review it', depends_on: [work.id], acceptance: { verdict: true } });
    // A later adapter of the same run: c1's id is free to reuse, but not to review its own work.
    const c2 = await client();
    clients.push(c2);
    const m2 = createRunManager({ core: c2.harness(), dataDir: dir, runId: RUN, paths });
    try {
      await assert.rejects(m2.spawn({ substrate: 'claude-code', worktree: wt, prompt: 'review it', worker_id: 'c1', task_id: review.id }),
        (e) => e.code === 'E_SELF_REVIEW' && e.detail.reviewed_task_id === work.id && e.detail.worker_id === 'c1');
      const after = await core.worker.get({ worker_id: 'c1' });
      assert.deepStrictEqual([after.state, after.rev ?? after.seq], ['stopped', stopped.rev ?? stopped.seq], 'no starting or dead row was written for the refused spawn');
      assert.deepStrictEqual((await m2.list()).workers, [], 'nothing launched');
      const r = await core.task.get({ task_id: review.id });
      assert.deepStrictEqual([r.state, r.lease], ['open', null], 'the review was not assigned');
    } finally { await m2.shutdown(); }
  } finally {
    if (coder) await coder.close();
    for (const c of clients) await c.close().catch(() => {});
    try { await core.shutdownOwner(); } catch { /* best effort */ }
    await core.close();
    cleanup(dir);
  }
});
