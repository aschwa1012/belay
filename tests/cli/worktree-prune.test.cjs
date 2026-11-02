'use strict';
// worktree-prune.test.cjs — ADR 0065 amendment 3: `belay worktree prune [--run <id>] [--yes]` as the built CLI in its own process
// against a sandbox store whose owner is this test's core. Without --yes it removes nothing; with it a lapsed run's tree goes, its
// head pinned first. The CLI is spawned asynchronously: this process serves the store.

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { makeRepo, git, guarded } = require('../core/worktree-helpers.cjs');
const test = guarded(nodeTest);

const { openCore } = core('index.cjs');
const BIN = path.resolve(__dirname, '..', '..', 'src', 'cli', 'belay.cjs');

let dir, data, repo, owner, orch, operator;

function belay(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => resolve({ code, out, err, json: (() => { try { return JSON.parse(code === 0 ? out : err); } catch { return null; } })() }));
  });
}

before(async () => {
  dir = sandbox();
  data = `${dir}/data`;
  repo = makeRepo(dir);
  owner = await openCore({ dataDir: data, caller: callerFor('orchestrator'), embed: false });
  await owner.run.attach({ adapter_pid: process.pid });
  orch = await openCore({ dataDir: data, caller: callerFor('orchestrator', { run_id: 'cli-prune' }), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  operator = await openCore({ dataDir: data, caller: callerFor('operator', { run_id: 'cli-prune' }), embed: false });
});

after(async () => {
  await operator.close();
  await orch.close();
  await owner.shutdownOwner();
  await owner.close();
  cleanup(dir);
});

test('usage errors exit 2: a task id, an option another verb takes', async () => {
  for (const args of [['worktree', 'prune', 't1'], ['worktree', 'prune', '--force'], ['worktree', 'prune', '--run']]) {
    const r = await belay([...args, '--data', data], repo);
    assert.strictEqual(r.code, 2, `${args.join(' ')}: ${r.err}`);
    assert.match(r.err, /belay worktree prune \[--run <id>\] \[--yes\]/);
  }
});

test('the preview removes nothing; --yes removes the ended run\'s tree and says where its head is pinned', async () => {
  const t = await orch.task.create({ spec: 'prune cli' });
  const made = await belay(['worktree', 'create', t.id, '--data', data, '--json'], repo);
  assert.strictEqual(made.code, 0, made.err);
  const w = made.json.worktree;
  await orch.task.cancel({ task_id: t.id, reason: 'cli prune test' });

  const live = await belay(['worktree', 'prune', '--data', data, '--json'], repo);
  assert.strictEqual(live.code, 0, live.err);
  assert.strictEqual(live.json.runs.find((r) => r.run_id === 'cli-prune').lapsed, false, 'the run is not ended');
  assert.deepStrictEqual(live.json.would_remove, []);

  await operator.run.end({ exit_reason: 'test' });
  const preview = await belay(['worktree', 'prune', '--data', data], repo);
  assert.strictEqual(preview.code, 0, preview.err);
  assert.match(preview.out, /would remove 1 tree\(s\)/);
  assert.match(preview.out, /nothing was removed \(pass --yes to remove\)/);
  assert.ok(fs.existsSync(w.path), 'the preview removed nothing');
  assert.strictEqual(git(repo, 'for-each-ref', 'refs/belay/kept/'), '', 'and pinned nothing');

  const only = await belay(['worktree', 'prune', '--run', 'some-other-run', '--yes', '--data', data, '--json'], repo);
  assert.strictEqual(only.code, 0, only.err);
  assert.ok(fs.existsSync(w.path), '--run names the run: another run id leaves this tree');

  const done = await belay(['worktree', 'prune', '--yes', '--data', data], repo);
  assert.strictEqual(done.code, 0, done.err);
  assert.match(done.out, /removed 1 tree\(s\), kept 0, failed 0/);
  const head = git(repo, 'rev-parse', `refs/heads/${w.branch}`);
  assert.match(done.out, new RegExp(`pinned as refs/belay/kept/${t.id}/${head.slice(0, 12)}`));
  assert.ok(!fs.existsSync(w.path));
  assert.strictEqual(git(repo, 'rev-parse', `refs/belay/kept/${t.id}/${head.slice(0, 12)}`), head);
  assert.strictEqual(git(repo, 'rev-parse', `refs/heads/${w.branch}`), head, 'the branch is kept');

  const again = await belay(['worktree', 'prune', '--yes', '--data', data], repo);
  assert.strictEqual(again.code, 0, again.err);
  assert.match(again.out, /no run records a tree that is still there/);
});
