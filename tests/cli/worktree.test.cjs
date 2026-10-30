'use strict';
// worktree.test.cjs — ADR 0053 decision 7: `belay worktree create|remove|merge` and `belay worktrees`, run as the built CLI in
// its own process against a sandbox store whose owner is this test's orchestrator core. The CLI is spawned asynchronously:
// this process serves the store, so a synchronous spawn would wait on itself.

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { makeRepo, write, commit, guarded } = require('../core/worktree-helpers.cjs');
const test = guarded(nodeTest); // a longer hang guard than the runner's 60 s; see guarded

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

// A done task, its worktree made by the CLI in the repository it runs in, its files committed there.
async function doneTask(files, commands) {
  const t = await orch.task.create({ spec: Object.keys(files).join(','), acceptance: { commands } });
  const w = (await belay(['worktree', 'create', t.id, '--data', data, '--json'], repo)).json.worktree;
  for (const [rel, text] of Object.entries(files)) write(w.path, rel, text);
  commit(w.path, t.id);
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id })).state, 'done');
  return t;
}

const keep = { argv: [process.execPath, '-e', "require('fs').accessSync('base/keep.txt')"] };

test('the operator sees unchecked and not merged work: in merge output and in belay tasks', async () => {
  const a = await doneTask({ 'base/keep.txt': 'from a\n' }, [keep]);
  const b = await doneTask({ 'base/keep.txt': 'from b\n' }, [keep]);
  const stopped = await belay(['worktree', 'merge', a.id, b.id, '--into', 'int/cli-stop', '--no-evaluate', '--data', data], repo);
  assert.strictEqual(stopped.code, 1); // a stopped merge exits 1, and its receipt goes to stderr
  assert.ok(stopped.err.includes(`not merged ${b.id} (conflict)`), stopped.err);
  assert.match(stopped.err, /merged work unchecked/);
  const checked = await belay(['worktree', 'merge', a.id, b.id, '--into', 'int/cli-stop2', '--data', data], repo);
  assert.strictEqual(checked.code, 1);
  assert.match(checked.err, /pass .*\n {2}passed: true/, 'a stopped integration prints the checks of what landed');
  assert.doesNotMatch(checked.err, /merged work unchecked/);

  const listed = await belay(['tasks', '--all', '--data', data, '--json'], repo);
  assert.strictEqual(listed.code, 0, listed.err);
  const text = (await belay(['tasks', '--all', '--data', data], repo)).out;
  const line = (id) => text.split('\n').find((l) => l.startsWith(id)) || '';
  assert.match(line(a.id), /merged:int\/cli-stop2:passed/, 'the newest merge of a leads');
  assert.match(line(b.id), /conflict:int\/cli-stop2/);
  const ia = listed.json.tasks.find((t) => t.id === a.id).integration;
  assert.deepStrictEqual(ia.elsewhere, [{ into: 'int/cli-stop', state: 'merged' }]);
});

test('the operator sees failed and unchecked merges in belay tasks', async () => {
  const notBoth = { argv: [process.execPath, '-e', "const f=require('fs');process.exit(f.existsSync('x.txt')&&f.existsSync('y.txt')?1:0)"] };
  const x = await doneTask({ 'x.txt': 'x\n' }, [notBoth]);
  const y = await doneTask({ 'y.txt': 'y\n' }, [notBoth]);
  const failed = await belay(['worktree', 'merge', x.id, y.id, '--into', 'int/cli-fail', '--data', data], repo);
  assert.strictEqual(failed.code, 1);
  const text = (await belay(['tasks', '--all', '--data', data], repo)).out;
  assert.match(text.split('\n').find((l) => l.startsWith(x.id)) || '', /merged:int\/cli-fail:failed/);
  // A merge made with --no-evaluate was never checked: belay tasks says so when that is the newest merge.
  const solo = await doneTask({ 'solo.txt': 's\n' }, [keep]);
  await belay(['worktree', 'merge', solo.id, '--into', 'int/cli-solo', '--no-evaluate', '--data', data], repo);
  const after = (await belay(['tasks', '--all', '--data', data], repo)).out;
  assert.match(after.split('\n').find((l) => l.startsWith(solo.id)), /merged:int\/cli-solo:unchecked/);
});
