'use strict';
// check-history.test.cjs — ADR 0069: belay shows what each task was checked by and how that changed. The history is derived from
// the task's own `amended` column (ADR 0061), so it needs no new column, and it never gates anything. Pure derivation first, then
// the integrate answer (merged, carried and forced tasks) with real git in throwaway repositories.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, write, commit } = require('./worktree-helpers.cjs');
const CH = require('../../src/core/check-history.cjs');

const { openCore } = core('index.cjs');

const cmd = (...argv) => ({ argv });
const acc = (...commands) => ({ commands });

test('lines names each command, quoting an argument that needs it, and the checks that have no command', () => {
  assert.deepStrictEqual(CH.lines(acc(cmd('node', '--test'))), ['node --test']);
  assert.deepStrictEqual(CH.lines(acc(cmd('C:/x/node.exe', '--test', '--test-skip-pattern=parallel writers'))), ['node.exe --test --test-skip-pattern="parallel writers"']);
  assert.deepStrictEqual(CH.lines(acc({ argv: ['npm', 'test'], cwd: 'pkg', retries_on_fail: 2 })), ['npm test (cwd pkg, retries_on_fail 2)']);
  assert.deepStrictEqual(CH.lines({ files_within_owned: true, verdict: true, handoff: { required: ['head', 'tests'] } }), ['files_within_owned', 'verdict', 'handoff: head, tests']);
  assert.deepStrictEqual(CH.lines(null), []);
  assert.ok(CH.lines(acc(cmd('node', 'x'.repeat(400))))[0].length <= 160, 'a long command is clipped');
});

test('historyOf: several amends give one change each, in order, with the time of the amend', () => {
  const task = {
    id: 'T28', acceptance: acc(cmd('node', '--test', '--test-skip-pattern=parallel writers')),
    amended: [{ at: 1000, by: 'o', acceptance: acc(cmd('node', '--test')) }, { at: 2000, by: 'o', acceptance: acc(cmd('node', '--test', '--test-name-pattern=a')) }],
  };
  const h = CH.historyOf(task);
  assert.deepStrictEqual(h.checks, ['node --test --test-skip-pattern="parallel writers"']);
  assert.deepStrictEqual(h.changes, [
    { at: 1000, from: ['node --test'], to: ['node --test --test-name-pattern=a'] },
    { at: 2000, from: ['node --test --test-name-pattern=a'], to: ['node --test --test-skip-pattern="parallel writers"'] },
  ]);
});

test('historyOf: an amend that leaves the commands as they were (a new spec, the same acceptance) is no change', () => {
  const same = acc(cmd('node', '--test'));
  const task = { id: 'T1', acceptance: same, amended: [{ at: 1, by: 'o', acceptance: same, spec: 'old spec' }, { at: 2, by: 'o', acceptance: acc(cmd('node', '--test')) }] };
  assert.deepStrictEqual(CH.historyOf(task).changes, []);
  assert.strictEqual(CH.line(CH.historyOf(task)), 'T1 checks: node --test');
  assert.deepStrictEqual(CH.historyOf({ id: 'T2', acceptance: same }).changes, [], 'a task never amended has none');
});

test('historyOf: an amend that adds a change and a later one that reverts it show both', () => {
  const a = acc(cmd('node', '--test')), b = acc(cmd('node', '--test', '--test-skip-pattern=x'));
  const h = CH.historyOf({ id: 'T3', acceptance: a, amended: [{ at: 10, by: 'o', acceptance: a }, { at: 20, by: 'o', acceptance: b }] });
  assert.deepStrictEqual(h.changes.map((c) => [c.from.length, c.to.length, c.from[0] === c.to[0]]), [[1, 1, false], [1, 1, false]]);
  assert.strictEqual(h.checks[0], 'node --test');
});

test('line: the shape of the example, with the time into the run, and each step of a task amended twice', () => {
  const since = 1000000;
  const task = { id: 'T28', acceptance: acc(cmd('node', '--test', '--test-skip-pattern=parallel writers')), amended: [{ at: since + 30 * 60000, by: 'o', acceptance: acc(cmd('node', '--test')) }] };
  assert.strictEqual(CH.line(CH.historyOf(task), since), 'T28 checks: node --test -> node --test --test-skip-pattern="parallel writers" (amended 30 min in)');
  assert.strictEqual(CH.line(CH.forReceipt(task, since)), 'T28 checks: node --test -> node --test --test-skip-pattern="parallel writers" (amended 30 min in)', 'a receipt carries the offset');
  const twice = { id: 'T9', acceptance: acc(cmd('c')), amended: [{ at: since + 60000, by: 'o', acceptance: acc(cmd('a')) }, { at: since + 180 * 60000, by: 'o', acceptance: acc(cmd('b')) }] };
  assert.strictEqual(CH.line(CH.historyOf(twice), since), 'T9 checks: a -> b (amended 1 min in), then -> c (amended 3.0 h in)');
  assert.strictEqual(CH.line(CH.historyOf({ id: 'T0', acceptance: {} })), 'T0 checks: none');
  assert.match(CH.line(CH.historyOf(task), null), /amended at \d{4}-\d\d-\d\dT/, 'without a run start the instant itself is named');
});

let dir, orch, op;

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

const exists = (rel) => cmd(process.execPath, '-e', `require('fs').accessSync(${JSON.stringify(rel)})`);
const never = cmd(process.execPath, '-e', 'process.exit(5)');

// A task in its own worktree with `files` committed; `first` is its acceptance when created, `commands` what it is amended to.
async function work(repo, files, first, commands, { evaluate = true } = {}) {
  const t = await orch.task.create({ spec: `write ${Object.keys(files).join(', ')}`, acceptance: { commands: first } });
  if (commands) await orch.task.create({ id: t.id, amend: true, acceptance: { commands } });
  const w = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  for (const [rel, text] of Object.entries(files)) write(w.path, rel, text);
  commit(w.path, `task ${t.id}`);
  return evaluate ? orch.task.evaluate({ task_id: t.id }) : orch.task.get({ task_id: t.id });
}

test('the integrate answer names each merged task\'s checks and the change an amend made, and integration.get gives the same', async () => {
  const repo = makeRepo(dir);
  const a = await work(repo, { 'a.txt': 'a\n' }, [never], [exists('a.txt')]);
  const b = await work(repo, { 'b.txt': 'b\n' }, [exists('b.txt')]);
  const row = await orch.integration.merge({ task_ids: [a.id, b.id] });
  assert.strictEqual(row.passed, true);
  assert.strictEqual(row.task_checks.length, 2);
  assert.ok(row.task_checks[0].startsWith(`${a.id} checks: `) && row.task_checks[0].includes(' -> ') && /\(amended [^)]+\)$/.test(row.task_checks[0]), row.task_checks[0]);
  assert.ok(row.task_checks[0].split(' -> ')[0].includes('process.exit(5)'), 'the earlier command is kept beside the new one');
  assert.strictEqual(row.task_checks[1].includes(' -> '), false, 'a task never amended shows its checks alone');
  assert.ok(row.task_checks[1].startsWith(`${b.id} checks: `));
  const got = await orch.integration.get({ id: row.id });
  assert.deepStrictEqual(got.task_checks, row.task_checks);
  const stored = (await orch.integration.list({})).integrations.find((r) => r.id === row.id);
  assert.strictEqual(stored.task_checks, undefined, 'it is derived from the task rows, not stored');
});

test('a carried task and a forced task are named once each', async () => {
  const repo = makeRepo(dir), into = 'int/check-history';
  const a = await work(repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  const r1 = await orch.integration.merge({ task_ids: [a.id], into });
  assert.deepStrictEqual(r1.task_checks.map((l) => l.split(' ')[0]), [a.id]);
  const b = await work(repo, { 'b.txt': 'b\n' }, [exists('b.txt')], [exists('later.txt')], { evaluate: false });
  const r2 = await orch.integration.merge({ task_ids: [b.id], into, force: true, reason: 'later.txt comes with another task' });
  assert.deepStrictEqual(r2.merged.map((m) => m.task_id), [a.id, b.id], 'a is carried from the first row');
  assert.deepStrictEqual(r2.task_checks.map((l) => l.split(' ')[0]), [a.id, b.id]);
  assert.ok(r2.task_checks[1].includes(' -> ') && r2.task_checks[1].includes('later.txt'), r2.task_checks[1]);
  assert.strictEqual(r2.task_checks[0].includes(' -> '), false);
});

test('an amend is refused on a done task, so a merged task\'s history is final', async () => {
  const repo = makeRepo(dir);
  const a = await work(repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  await assert.rejects(orch.task.create({ id: a.id, amend: true, acceptance: { commands: [never] } }), (e) => e.code === 'E_TASK_DONE');
});
