'use strict';
// review-spawn-baseline.test.cjs — ADR 0054 amendment 1: a reviewer spawned with its review task gets its grant snapshot before
// it is launched (the run manager assigns, then launches), so the snapshot is never baseline_late on the spawn path. The real
// run manager, the real core, the fake claude, a real git repository.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createRunManager } = require('../../src/run/index.cjs');
const { openCore } = require('../../src/core/index.cjs');
const rows = require('../../src/core/rows.cjs');
const { sandbox, cleanup, callerFor } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };

test('a reviewer spawned with its review task: the grant snapshot is attached and not late', { timeout: 60000 }, async () => {
  const dir = sandbox();
  const core = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  const opened = [];
  try {
    await core.run.attach({ adapter_pid: process.pid });
    const wt = path.join(dir, 'wt').split(path.sep).join('/');
    fs.mkdirSync(wt);
    const git = (...a) => assert.strictEqual(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: wt, windowsHide: true }).status, 0);
    git('init', '-q'); fs.writeFileSync(path.join(wt, 'a.txt'), 'one\n'); git('add', 'a.txt'); git('commit', '-q', '-m', 'base');
    const work = await core.task.create({ spec: 'the work', acceptance: PASS });
    await core.worker.write({ id: 'coder', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-coder', last_event_at: Date.now(), worktree: wt });
    const cw = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'coder' }), embed: false });
    opened.push(cw);
    const a0 = await core.task.assign({ task_id: work.id, worker_id: 'coder' });
    await cw.lease.release({ lease_id: a0.new_lease.id, reason: 'done' });
    assert.strictEqual((await core.task.evaluate({ task_id: work.id, worktree: wt })).state, 'done');
    const review = await core.task.create({ spec: 'the review', depends_on: [work.id], acceptance: { verdict: true } });
    const m = createRunManager({ core: core.harness(), dataDir: dir, runId: 'test-run', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
    try {
      await m.spawn({ substrate: 'claude-code', worktree: wt, prompt: 'review it', worker_id: 'rev', agent_type: 'reviewer', task_id: review.id });
      await m._waitTurn('rev', 8000);
      // Read before the manager's shutdown, which stops the store owner this process holds.
      const lease = rows.currentLeaseForTask(core.owner.store, review.id);
      assert.ok(lease && lease.tree && lease.tree.head, 'the snapshot is attached');
      assert.strictEqual(lease.tree.baseline_late, undefined, `not late on the spawn path: ${JSON.stringify(lease.tree.baseline_late_by)}`);
    } finally { try { await m.shutdown(); } catch { /* best effort */ } }
  } finally {
    for (const c of opened) await c.close();
    try { await core.shutdownOwner(); } catch { /* best effort */ }
    await core.close();
    cleanup(dir);
  }
});
