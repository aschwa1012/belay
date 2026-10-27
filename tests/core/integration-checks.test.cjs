'use strict';
// integration-checks.test.cjs — `checks` on integration.merge: extra commands run on the merged head for that call only, recorded on
// the integration row as integrate-level checks. Real git in throwaway repositories under the sandbox. A command that counts its own
// runs shows what really ran, and where.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, write, commit, rejectsCode } = require('./worktree-helpers.cjs');
const V = require('../../src/mcp/views.cjs');

const { openCore } = core('index.cjs');

let dir, orch, op, n = 0;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  op = await openCore({ dataDir: `${dir}/data`, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
});

after(async () => {
  await op.close();
  await orch.shutdownOwner();
  await orch.close();
  cleanup(dir);
});

// A command that appends its cwd to `counter` each time it runs, then passes when `rel` exists in that cwd.
const probe = (counter, rel) => ({
  argv: [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(counter)}, process.cwd() + '\\n'); process.exit(require('fs').existsSync(${JSON.stringify(rel)}) ? 0 : 1)`],
});
const lines = (counter) => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean) : []);
const into = () => `int/chk-${++n}`;
const counterFile = () => path.join(dir, `counter-${++n}.txt`);

const TRIVIAL = { argv: [process.execPath, '-e', '0'] }; // a task with no command is never done
const mine = (r) => r.checks.filter((k) => k.source === 'integrate');
async function work(repo, files, commands = [TRIVIAL]) {
  const t = await orch.task.create({ spec: `write ${Object.keys(files).join(', ')}`, acceptance: { commands } });
  const w = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  for (const [rel, text] of Object.entries(files)) write(w.path, rel, text);
  commit(w.path, `task ${t.id}`);
  return orch.task.evaluate({ task_id: t.id });
}

test('checks run on the merged head after the tasks\' own, and a failing one makes passed false', async () => {
  const repo = makeRepo(dir), c = counterFile(), br = into();
  const a = await work(repo, { 'a.txt': 'a\n' });
  const b = await work(repo, { 'b.txt': 'b\n' });
  const ok = await orch.integration.merge({ task_ids: [a.id, b.id], into: br, checks: [probe(c, 'b.txt')] });
  assert.strictEqual(ok.state, 'evaluated');
  assert.strictEqual(ok.passed, true);
  assert.strictEqual(lines(c).length, 1, 'ran once');
  assert.strictEqual(path.resolve(lines(c)[0]), path.resolve(ok.worktree), 'in the integration tree, where the merged files are');
  assert.strictEqual(ok.checks.length, 2, 'the task command, then the check');
  assert.deepStrictEqual([mine(ok)[0].source, mine(ok)[0].task_ids, mine(ok)[0].exit_code], ['integrate', [], 0]);
  const bad = await orch.integration.merge({ task_ids: [a.id, b.id], into: br, checks: [probe(c, 'missing.txt')] });
  assert.strictEqual(bad.passed, false);
  assert.strictEqual(mine(bad)[0].exit_code, 1);
  assert.strictEqual(mine(bad)[0].source, 'integrate');
});

test('evaluate false with checks runs only the checks', async () => {
  const repo = makeRepo(dir), c = counterFile(), taskC = counterFile();
  const a = await work(repo, { 'a.txt': 'a\n' }, [probe(taskC, 'a.txt')]);
  fs.rmSync(taskC, { force: true });
  const r = await orch.integration.merge({ task_ids: [a.id], into: into(), evaluate: false, checks: [probe(c, 'a.txt')] });
  assert.strictEqual(r.state, 'evaluated');
  assert.strictEqual(lines(taskC).length, 0, 'the task\'s own command was skipped');
  assert.strictEqual(lines(c).length, 1);
  assert.strictEqual(r.checks.length, 1, 'only the check');
  assert.strictEqual(r.passed, true);
  const none = await orch.integration.merge({ task_ids: [a.id], into: into(), evaluate: false });
  assert.strictEqual(none.checks, null, 'evaluate false without checks still runs nothing');
});

test('a bad shape is refused E_ARGS with nothing merged or written', async () => {
  const repo = makeRepo(dir), br = into();
  const a = await work(repo, { 'a.txt': 'a\n' });
  const count = async () => (await orch.integration.list({})).integrations.length;
  const before = await count();
  for (const bad of ['npm test', [{}], [{ argv: [] }], [{ argv: ['x', 3] }], [{ argv: ['x'], cwd: '' }], [{ argv: ['x'], timeout_ms: -1 }], [{ argv: ['x'], timeout_ms: 1.5 }], [{ argv: ['x'], shell: 'y' }], ['x']]) {
    await rejectsCode(orch.integration.merge({ task_ids: [a.id], into: br, checks: bad }), 'E_ARGS');
  }
  assert.strictEqual(await count(), before, 'no row was written');
  const r = await orch.integration.merge({ task_ids: [a.id], into: br, checks: [] });
  assert.strictEqual(r.state, 'evaluated', 'the branch was untouched by the refusals, so a good call merges');
});

test('an identical command at an identical head is reused; another timeout_ms or head runs it', async () => {
  const repo = makeRepo(dir), c = counterFile(), br = into();
  const a = await work(repo, { 'a.txt': 'a\n' });
  const cmd = { ...probe(c, 'a.txt'), timeout_ms: 60000 };
  const r1 = await orch.integration.merge({ task_ids: [a.id], into: br, checks: [cmd] });
  assert.strictEqual(lines(c).length, 1);
  const r2 = await orch.integration.merge({ task_ids: [a.id], into: br, checks: [cmd] });
  assert.strictEqual(lines(c).length, 1, 'not run again');
  assert.strictEqual(mine(r2)[0].reused_from, r1.id);
  assert.strictEqual(mine(r2)[0].source, 'integrate');
  assert.strictEqual(r2.passed, true);
  await orch.integration.merge({ task_ids: [a.id], into: br, checks: [{ ...cmd, timeout_ms: 61000 }] });
  assert.strictEqual(lines(c).length, 2, 'a different timeout_ms is a different command');
  const b = await work(repo, { 'b.txt': 'b\n' });
  await orch.integration.merge({ task_ids: [b.id], into: br, checks: [{ ...cmd, timeout_ms: 61000 }] });
  assert.strictEqual(lines(c).length, 3, 'a moved head runs it again');
});

test('a command a task also declares runs once, marked integrate and naming the task', async () => {
  const repo = makeRepo(dir), c = counterFile();
  const cmd = probe(c, 'a.txt');
  const a = await work(repo, { 'a.txt': 'a\n' }, [cmd]);
  fs.rmSync(c, { force: true });
  const r = await orch.integration.merge({ task_ids: [a.id], into: into(), checks: [cmd] });
  assert.strictEqual(lines(c).length, 1);
  assert.deepStrictEqual([r.checks.length, r.checks[0].source, r.checks[0].task_ids], [1, 'integrate', [a.id]]);
});

test('a forced merge records its integrate checks truthfully', async () => {
  const repo = makeRepo(dir), c = counterFile();
  const t = await orch.task.create({ spec: 'never finished', acceptance: { commands: [TRIVIAL] } });
  const w = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  write(w.path, 'f.txt', 'f\n');
  commit(w.path, `task ${t.id}`);
  const r = await orch.integration.merge({ task_ids: [t.id], into: into(), force: true, reason: 'checks are the proof here', checks: [probe(c, 'nope.txt')] });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(mine(r)[0].source, 'integrate');
  assert.ok(r.forced && r.forced.task_ids.includes(t.id));
  assert.deepStrictEqual(r.forced.failing, [], 'an integrate check belongs to no task, so no forced task is blamed for it');
});

test('the compact view shows an integrate check by name, with its source', () => {
  const row = { id: 'i1', state: 'evaluated', task_ids: ['t1'], merged: [], passed: true,
    checks: [{ argv: ['npm', 'test'], cwd: 'C:/x', task_ids: [], source: 'integrate', passed: true, exit_code: 0, stdout_tail: 'ok' },
      { argv: ['npm', 'run', 'lint'], cwd: 'C:/x', task_ids: [], source: 'integrate', passed: false, exit_code: 1, stdout_tail: 'bad' }] };
  const c = V.integrate(row);
  assert.deepStrictEqual(c.checks[0], { check: 'npm test', passed: true, source: 'integrate' });
  assert.strictEqual(c.checks[1].check, 'npm run lint');
  assert.strictEqual(c.checks[1].source, 'integrate');
});
