'use strict';
// worktree.test.cjs — ADR 0053 decision 7: `belay worktree create|remove|merge` and `belay worktrees`, run as the built CLI in
// its own process against a sandbox store whose owner is this test's orchestrator core. The CLI is spawned asynchronously:
// this process serves the store, so a synchronous spawn would wait on itself.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { makeRepo, write, commit } = require('../core/worktree-helpers.cjs');

const { openCore } = core('index.cjs');
const BIN = path.resolve(__dirname, '..', '..', 'src', 'cli', 'belay.cjs');

let dir, data, repo, orch;

function belay(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => resolve({ code, out, err, json: (() => { try { return JSON.parse(code === 0 ? out : err); } catch { return null; } })() })); // a failure's receipt goes to stderr
  });
}

before(async () => {
  dir = sandbox();
  data = `${dir}/data`;
  repo = makeRepo(dir);
  orch = await openCore({ dataDir: data, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
});

after(async () => {
  await orch.shutdownOwner();
  await orch.close();
  cleanup(dir);
});

test('worktrees on an empty data dir answers and creates nothing', async () => {
  const empty = `${dir}/empty-data`;
  const r = await belay(['worktrees', '--data', empty], dir);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /no worktrees/);
  assert.ok(!fs.existsSync(empty), 'a read made no data dir');
});

test('usage errors exit 2 and name the subcommands', async () => {
  for (const args of [['worktree'], ['worktree', 'frob'], ['worktree', 'create'], ['worktree', 'remove', 'a', 'b'], ['worktree', 'merge', '--into']]) {
    const r = await belay([...args, '--data', data], repo);
    assert.strictEqual(r.code, 2, `${args.join(' ')}: ${r.err}`);
    assert.match(r.err, /usage: belay worktree create/);
  }
});

test('create, list, merge and remove a task\'s worktree from the CLI', async () => {
  const check = { argv: [process.execPath, '-e', "require('fs').accessSync('cli.txt')"] };
  const t = await orch.task.create({ spec: 'cli', acceptance: { commands: [check] } });
  const made = await belay(['worktree', 'create', t.id, '--data', data, '--json'], repo);
  assert.strictEqual(made.code, 0, made.err);
  const w = made.json.worktree;
  assert.strictEqual(w.repo, repo, 'the repository is the one the CLI ran in');
  assert.strictEqual(w.created_by, 'operator');

  const listed = await belay(['worktrees', '--all', '--data', data, '--json'], repo);
  assert.strictEqual(listed.code, 0, listed.err);
  assert.deepStrictEqual(listed.json.worktrees.map((x) => [x.task_id, x.path]), [[t.id, w.path]]);

  write(w.path, 'cli.txt', 'cli\n');
  commit(w.path, 'cli');
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id })).state, 'done');
  const merged = await belay(['worktree', 'merge', t.id, '--into', 'int/cli', '--data', data], repo);
  assert.strictEqual(merged.code, 0, merged.err);
  assert.match(merged.out, /: evaluated/);
  assert.match(merged.out, /passed: true/);
  // `belay tasks` shows whether the task's branch landed beside its work state, in one cell.
  const tasks = await belay(['tasks', '--all', '--data', data], repo);
  assert.strictEqual(tasks.code, 0, tasks.err);
  assert.match(tasks.out, /integration/);
  assert.match(tasks.out, /merged:int\/cli:passed/);

  const removed = await belay(['worktree', 'remove', t.id, '--data', data], repo);
  assert.strictEqual(removed.code, 0, removed.err);
  assert.match(removed.out, /1 junction\(s\) unlinked first/);
  assert.ok(!fs.existsSync(w.path));
  const again = await belay(['worktree', 'remove', t.id, '--data', data, '--json'], repo);
  assert.strictEqual(again.code, 1);
  assert.strictEqual(again.json.error.code, 'E_NOT_FOUND');

  const { integrations } = await orch.integration.list({});
  const int = integrations.find((r) => r.into_branch === 'int/cli');
  const gone = await belay(['worktree', 'remove', '--integration', int.id, '--data', data], repo);
  assert.strictEqual(gone.code, 0, gone.err);
  assert.ok(!fs.existsSync(int.worktree));
});
