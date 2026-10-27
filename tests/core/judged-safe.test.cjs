'use strict';
// judged-safe.test.cjs — ADR 0060 decision 6 as hardened: recording what a task was judged on runs no program the repository
// names (a hook, core.fsmonitor, a clean filter: ADR 0054 decision 2), converts line endings as the system config says (Git for
// Windows sets core.autocrlf=true there), keeps the head when the content cannot be read, and names the uncommitted paths. Real
// core, a sandbox store and a throwaway repository with its own config, never this checkout.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, git, write, commit } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };
const fwd = (p) => p.split('\\').join('/');

let dir, repo, orch, marks, n = 0;
const workers = [];

before(async () => {
  dir = sandbox();
  repo = makeRepo(dir);
  marks = fwd(path.join(dir, 'marks'));
  fs.mkdirSync(marks);
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, project_dir: repo });
});

after(async () => {
  for (const c of workers) await c.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

// A task with its own tree; `edit(tree)` makes its changes; the worker hands back; the task is judged.
async function judged(edit, acceptance = PASS, beforeEval = () => {}) {
  let t = await orch.task.create({ spec: `judged ${++n}`, acceptance });
  t = await orch.task.worktreeCreate({ task_id: t.id });
  edit(t.worktree.path);
  const id = `w-${n}`;
  await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now(), worktree: t.worktree.path });
  const w = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: id }), embed: false });
  workers.push(w);
  const a = await orch.task.assign({ task_id: t.id, worker_id: id });
  await w.lease.release({ lease_id: a.new_lease.id, reason: 'done' });
  beforeEval();
  return orch.task.evaluate({ task_id: t.id });
}

test('the repository\'s hook, fsmonitor and clean filter run for a plain git add, and never while belay records what was judged', async () => {
  const script = fwd(path.join(dir, 'mark.cjs'));
  fs.writeFileSync(script, "require('fs').writeFileSync(process.argv[2] + '/' + process.argv[3], 'ran'); if (process.argv[3] === 'filter') process.stdin.pipe(process.stdout);\n");
  const node = fwd(process.execPath);
  const hooks = path.join(repo, '.git', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'post-index-change'), `#!/bin/sh\n"${node}" "${script}" "${marks}" hook\n`);
  fs.chmodSync(path.join(hooks, 'post-index-change'), 0o755);
  git(repo, 'config', 'core.fsmonitor', `"${node}" "${script}" "${marks}" fsmonitor`);
  git(repo, 'config', 'filter.evil.clean', `"${node}" "${script}" "${marks}" filter`);
  try {
    // Making the tree (belay's own git worktree add) runs them too; only what runs from the evaluation on is counted.
    const clear = () => { for (const f of fs.readdirSync(marks)) fs.rmSync(path.join(marks, f)); };
    const row = await judged((tree) => { write(tree, '.gitattributes', '*.txt filter=evil\n'); write(tree, 'planted.txt', 'x\n'); }, PASS, clear);
    assert.strictEqual(row.state, 'done');
    assert.strictEqual(row.results.uncommitted, true);
    assert.deepStrictEqual(fs.readdirSync(marks), [], 'no program the repository names ran');
    // The control: the same tree, a plain git add into a temporary index, runs them.
    const index = path.join(os.tmpdir(), `belay-control-${process.pid}.index`);
    spawnSync('git', ['add', '-A'], { cwd: row.worktree.path, env: { ...process.env, GIT_INDEX_FILE: index }, windowsHide: true });
    fs.rmSync(index, { force: true });
    assert.ok(fs.readdirSync(marks).length >= 1, `the control ran a planted program: ${fs.readdirSync(marks)}`);
  } finally {
    fs.rmSync(path.join(hooks, 'post-index-change'), { force: true });
    git(repo, 'config', '--unset', 'core.fsmonitor');
    git(repo, 'config', '--unset', 'filter.evil.clean');
    for (const f of fs.readdirSync(marks)) fs.rmSync(path.join(marks, f));
  }
});

test('with the system core.autocrlf=true, CRLF content judged uncommitted and then committed merges clean (skipped without it)', async (t) => {
  const sys = spawnSync('git', ['config', '--system', '--get', 'core.autocrlf'], { encoding: 'utf8', windowsHide: true });
  if (String(sys.stdout).trim() !== 'true') return t.skip('the system config does not set core.autocrlf=true');
  git(repo, 'config', '--unset', 'core.autocrlf'); // the helper's local false would hide the system key
  try {
    const crlf = 'line one\r\nline two\r\n';
    const left = await judged((tree) => write(tree, 'crlf.txt', crlf));
    assert.strictEqual(left.results.uncommitted, true);
    commit(left.worktree.path, 'crlf, committed as judged');
    const row = await orch.integration.merge({ task_ids: [left.id], into: 'int/crlf' });
    assert.ok(['merged', 'evaluated'].includes(row.state), row.state);
    assert.deepStrictEqual([row.merged[0].covers, row.left_out], [[left.id], null]);
    // Committed before it is judged: clean, nothing uncommitted.
    const done = await judged((tree) => { write(tree, 'crlf2.txt', crlf); commit(tree, 'crlf2'); });
    assert.deepStrictEqual([done.results.uncommitted, done.results.tree_sha], [undefined, git(done.worktree.path, 'rev-parse', 'HEAD^{tree}')]);
  } finally {
    git(repo, 'config', 'core.autocrlf', 'false');
  }
});

test('content that cannot be read (an embedded repository with no commit) keeps the head and says why', async () => {
  const row = await judged((tree) => { fs.mkdirSync(path.join(tree, 'inner')); git(path.join(tree, 'inner'), 'init', '-q'); write(path.join(tree, 'inner'), 'f.txt', 'x\n'); });
  assert.strictEqual(row.results.head_sha, row.worktree.base_sha);
  assert.strictEqual(row.results.tree_sha, undefined);
  assert.match(row.results.warning, /^the judged content could not be read \(git add failed/);
});

test('the warning names the uncommitted paths, at most 20, and counts the rest; a clean tree is HEAD\'s tree', async () => {
  const row = await judged((tree) => { for (let i = 0; i < 25; i++) write(tree, `many/f${String(i).padStart(2, '0')}.txt`, `${i}\n`); });
  assert.strictEqual(row.results.uncommitted_paths.length, 20);
  assert.match(row.results.warning, /^uncommitted changes \(many\/f00\.txt, .*many\/f19\.txt, and 5 more\): commit before integrate$/);
  const clean = await judged((tree) => { write(tree, 'clean.txt', 'c\n'); commit(tree, 'clean'); });
  assert.deepStrictEqual([clean.results.uncommitted, clean.results.warning, clean.results.tree_sha], [undefined, undefined, git(clean.worktree.path, 'rev-parse', 'HEAD^{tree}')]);
});
