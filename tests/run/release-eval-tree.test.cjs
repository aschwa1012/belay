'use strict';
// release-eval-tree.test.cjs — ADR 0058 amendment (proposed): a task with its own worktree is worked and judged there. A reused
// idle worker runs in the tree of its earlier task, and its directory cannot change, so task.assign refuses it a task with another
// worktree, naming both paths; a spawn in the wrong tree is refused with nothing written; and task.evaluate refuses a worktree
// argument that is not the task's (the release evaluation passes the worker's own directory), so a check never runs in the wrong
// tree to give a false fail or a false pass. Real core, real run manager, the fake Claude Code substrate, a throwaway repository.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { makeRepo, rejectsCode } = require('../core/worktree-helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const RUN = 'release-eval-tree-run';
// Passes only where the task's work is: the file the task writes in its own tree.
const MARKED = { commands: [{ argv: [process.execPath, '-e', "process.exit(require('fs').existsSync('mark.txt') ? 0 : 4)"], timeout_ms: 20000 }] };

async function withRun(fn) {
  const dir = sandbox();
  const repo = makeRepo(dir);
  const core = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
  let m = null;
  try {
    await core.run.attach({ adapter_pid: process.pid, project_dir: repo });
    m = createRunManager({ core: core.harness(), dataDir: `${dir}/data`, runId: RUN, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
    const tree = async (spec) => {
      const t = await core.task.create({ spec, acceptance: MARKED, files_owned: [] });
      return { task: t, path: (await core.task.worktreeCreate({ task_id: t.id })).worktree.path };
    };
    return await fn({ core, m, tree, dir });
  } finally {
    if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
    try { await core.shutdownOwner(); } catch { /* best effort */ }
    await core.close();
    cleanup(dir);
  }
}

test('a reused idle worker is refused a task with another worktree, naming both; the release evaluation\'s call cannot judge the wrong tree', { timeout: 120000 }, async () => {
  await withRun(async ({ core, m, tree }) => {
    const a = await tree('first');
    const b = await tree('second');
    await m.spawn({ substrate: 'claude-code', worktree: a.path, prompt: 'one', worker_id: 'w1', task_id: a.task.id });
    await m.wait({ worker_ids: ['w1'], timeout_ms: 30000 }); // the first turn ends: w1 is idle in a's tree

    const e = await rejectsCode(core.task.assign({ task_id: b.task.id, worker_id: 'w1' }), 'E_PRECONDITION');
    assert.deepStrictEqual([e.detail.task_worktree, e.detail.worktree], [b.path, a.path]);
    assert.ok(e.message.includes(b.path) && e.message.includes(a.path), e.message);
    const bRow = await core.task.get({ task_id: b.task.id });
    assert.deepStrictEqual([bRow.state, bRow.lease], ['open', null], 'nothing was written');

    // The false-fail repro: b's work is in b's tree; the release evaluation passes the worker's directory (a's tree). Run there,
    // the check fails though the work is there. That call is refused and writes nothing; b's own tree is where it is judged.
    fs.writeFileSync(path.join(b.path, 'mark.txt'), 'done\n');
    await rejectsCode(core.task.evaluate({ task_id: b.task.id, worktree: a.path, trigger: 'release' }), 'E_PRECONDITION');
    assert.strictEqual((await core.task.get({ task_id: b.task.id })).results, null, 'the refused evaluation wrote no results');
    const judged = await core.task.evaluate({ task_id: b.task.id });
    assert.deepStrictEqual([judged.results.passed, judged.state], [true, 'done']);
    // The false pass: a's tree holds a mark (a's own work), b's does not. Judged in a's tree it would pass; refused instead.
    const c = await tree('third');
    fs.writeFileSync(path.join(a.path, 'mark.txt'), 'a\n');
    await rejectsCode(core.task.evaluate({ task_id: c.task.id, worktree: a.path }), 'E_PRECONDITION');
    assert.strictEqual((await core.task.evaluate({ task_id: c.task.id })).results.passed, false);
    // The same tree in another spelling is the same tree.
    const same = await core.task.evaluate({ task_id: c.task.id, worktree: c.path.split('/').join('\\').toUpperCase() });
    assert.strictEqual(same.results.passed, false);

    // A task with no worktree of its own goes to the reused worker, and is judged where the worker runs.
    const bare = await core.task.create({ spec: 'no tree', acceptance: MARKED, files_owned: [] });
    const got = await core.task.assign({ task_id: bare.id, worker_id: 'w1' });
    assert.strictEqual(got.task.state, 'assigned');
  });
});

test('a spawn into a tree that is not its task\'s is refused before anything is written, and the id stays free', { timeout: 120000 }, async () => {
  await withRun(async ({ core, m, tree, dir }) => {
    const a = await tree('first');
    const b = await tree('second');
    await rejectsCode(m.spawn({ substrate: 'claude-code', worktree: a.path, prompt: 'one', worker_id: 'w2', task_id: b.task.id }), 'E_PRECONDITION');
    assert.strictEqual(fs.existsSync(path.join(`${dir}/data`, 'workers', 'w2')), false, 'no worker directory');
    assert.strictEqual(((await core.worker.list({})).workers || []).some((w) => w.id === 'w2'), false, 'no worker row');
    await rejectsCode(core.task.assign({ task_id: b.task.id, check_only: false, worktree: b.path, worker_id: 'w2' }), 'E_ARGS');
    const ok = await core.task.assign({ task_id: b.task.id, check_only: true, worktree: b.path });
    assert.strictEqual(ok.assignable, true);
  });
});
