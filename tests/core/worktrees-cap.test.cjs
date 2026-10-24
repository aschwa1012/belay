'use strict';
// worktrees-cap.test.cjs — ADR 0053's 4 MiB cap on the git listings files_within_owned reads: a changed set past it is not
// judged at all (executable false, the task not done), never judged from a cut list. Every path here is owned, so a check that
// read only the first 4 MiB would pass; the throwaway repository is under the OS temp dir (helpers.cjs).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, repo;

before(async () => {
  dir = sandbox();
  repo = makeRepo(dir);
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, project_dir: repo });
});

after(async () => {
  await orch.shutdownOwner();
  await orch.close();
  cleanup(dir);
});

test('a git status listing past 4 MiB makes files_within_owned not executable, and the task stays open', { timeout: 300000 }, async () => {
  const t = await orch.task.create({ spec: 'huge change', files_owned: ['owned'], acceptance: { files_within_owned: true } });
  const w = (await orch.task.worktreeCreate({ task_id: t.id })).worktree;
  // About 4.4 MB of `?? owned/<150 chars>\0` entries, each path short enough for a default Windows checkout.
  const sub = path.join(w.path, 'owned');
  fs.mkdirSync(sub);
  const pad = 'x'.repeat(140);
  for (let i = 0; i < 28000; i += 1) fs.writeFileSync(path.join(sub, `${String(i).padStart(6, '0')}${pad}`), '');
  const row = await orch.task.evaluate({ task_id: t.id });
  const c = row.results.checks.find((x) => x.kind === 'files_within_owned');
  assert.strictEqual(c.executable, false, JSON.stringify({ ...c.detail, changed: undefined, outside: undefined }));
  assert.match(c.detail.reason, /more than 4194304 characters/);
  assert.notStrictEqual(row.state, 'done');
});
