'use strict';
// check-history-receipts.test.cjs — ADR 0069: the run-end receipt (text and JSON) and `belay receipts` list each task's check
// commands once and any change made to them during the run, as facts. A store is planted through the core; `belay receipts` is
// driven as a subprocess, and the run receipt's pieces (collect and the text lines) are driven directly.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const { openCore } = require('../../src/core/index.cjs');
const RC = require('../../src/cli/run-checks.cjs');
const { renderText } = require('../../src/cli/cmd-run.cjs');
const { ROOT, CLI, sandbox, cleanup } = require('./stop-helpers.cjs');

const NODE_TEST = { argv: ['node', '--test'] };
const SKIPPED = { argv: ['node', '--test', '--test-skip-pattern=parallel writers'] };
const SHOWN = 'node --test -> node --test --test-skip-pattern="parallel writers"';

async function plant(dataDir, runId) {
  const orch = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
  try {
    await orch.run.attach({ adapter_pid: process.pid });
    const t = await orch.task.create({ id: 'T28', spec: 'work', acceptance: { commands: [NODE_TEST] } });
    await orch.task.create({ id: t.id, amend: true, acceptance: { commands: [SKIPPED] } });
    await orch.task.create({ id: 'T29', spec: 'other', acceptance: { commands: [NODE_TEST] } });
    await orch.task.create({ id: 'T29', amend: true, spec: 'other, reworded', acceptance: { commands: [NODE_TEST] } }); // a no-op amend
    await orch.task.create({ id: 'T30', spec: 'untouched', acceptance: { commands: [NODE_TEST] } });
    return await orch.run.get({});
  } finally { await orch.shutdownOwner(); await orch.close(); }
}

test('collect lists every task of the run once, with its changes and how long into the run they came', async () => {
  const dir = sandbox(), dataDir = `${dir}/.belay`;
  try {
    await plant(dataDir, 'run-h');
    const core = await openCore({ dataDir, caller: { role: 'operator', run_id: 'run-h', pid: process.pid } });
    try {
      const all = await RC.collect({ core, runId: 'run-h', startedAt: Date.now() - 30 * 60000 });
      const got = all.task_checks;
      assert.deepStrictEqual(all.integrate_checks, []);
      assert.deepStrictEqual(got.map((h) => h.task_id).sort(), ['T28', 'T29', 'T30']);
      const t28 = got.find((h) => h.task_id === 'T28');
      assert.strictEqual(t28.changes.length, 1);
      assert.deepStrictEqual([t28.changes[0].from, t28.changes[0].to], [['node --test'], ['node --test --test-skip-pattern="parallel writers"']]);
      assert.ok(t28.changes[0].after_ms >= 29 * 60000, 'the offset from the run start is in the receipt');
      assert.deepStrictEqual(got.find((h) => h.task_id === 'T29').changes, [], 'an amend that left the commands as they were is no change');
      assert.deepStrictEqual((await RC.collect({ core, runId: 'another-run', startedAt: null })).task_checks, []);
      assert.strictEqual(await RC.collect({ core: { task: { list: async () => { throw new Error('x'); } } }, runId: 'run-h' }), null, 'a read that fails leaves the receipt without the block');
    } finally { await core.close(); }
  } finally { cleanup(dir); }
});

test('the run text receipt lists each task\'s checks once, and names a change as from -> to with when', () => {
  const receipt = {
    run_id: 'r', orchestrator: { pid: 1, session_id: 's', turns: 2, exit_code: 0 }, ended_by: 'idle', holds: [], polls: 3,
    task_checks: [
      { task_id: 'T28', checks: ['node --test --test-skip-pattern="parallel writers"'], changes: [{ at: 5, after_ms: 30 * 60000, from: ['node --test'], to: ['node --test --test-skip-pattern="parallel writers"'] }] },
      { task_id: 'T30', checks: ['node --test'], changes: [] },
    ],
  };
  const text = renderText(receipt).split('\n');
  assert.ok(text.includes(`T28 checks: ${SHOWN} (amended 30 min in)`), text.join('\n'));
  assert.ok(text.includes('T30 checks: node --test'));
  assert.strictEqual(text.filter((l) => l.startsWith('T28 ')).length, 1, 'once');
  assert.ok(!renderText({ ...receipt, task_checks: undefined }).includes(' checks: '), 'a receipt with no block prints no such lines');
  assert.ok(!renderText({ ...receipt, task_checks: [{ task_id: 'T\u001b[2J', checks: [], changes: [] }] }).includes('\u001b'), 'an id with a control character cannot start a line of its own');
});

test('belay receipts: each task carries check_history in JSON and a line of its checks in text', async () => {
  const dir = sandbox(), dataDir = `${dir}/.belay`;
  try {
    await plant(dataDir, 'run-r');
    const cli = (...a) => spawnSync(process.execPath, [CLI, 'receipts', 'run-r', '--data', dataDir, ...a], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    const json = JSON.parse(cli('--json').stdout);
    const t28 = json.unassigned_tasks.find((t) => t.id === 'T28');
    assert.deepStrictEqual(t28.check_history.checks, ['node --test --test-skip-pattern="parallel writers"']);
    assert.strictEqual(t28.check_history.changes.length, 1);
    assert.ok(t28.check_history.changes[0].after_ms >= 0);
    assert.deepStrictEqual(json.unassigned_tasks.find((t) => t.id === 'T30').check_history.changes, []);
    const out = cli();
    assert.strictEqual(out.status, 0, out.stderr);
    const lines = out.stdout.split(/\r?\n/);
    assert.strictEqual(lines.filter((l) => l.startsWith('  T28 checks: ')).length, 1);
    assert.ok(lines.some((l) => l.startsWith('  T28 checks: ') && l.includes(SHOWN) && /\(amended (under a minute in|\d+ min in)\)$/.test(l)), out.stdout);
    assert.ok(lines.includes('  T30 checks: node --test'));
  } finally { cleanup(dir); }
});

test('a line is never cut: a twice-amended task with long commands keeps every step and its marker in the receipts text', async () => {
  const dir = sandbox(), dataDir = `${dir}/.belay`;
  try {
    const long = (n) => ({ argv: ['node', '--test', `--test-skip-pattern=${'x'.repeat(100)}${n}`, `--test-name-pattern=${'y'.repeat(100)}`] });
    const orch = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-l', pid: process.pid } });
    try {
      await orch.run.attach({ adapter_pid: process.pid });
      await orch.task.create({ id: 'TL', spec: 'work', acceptance: { commands: [long(1)] } });
      await orch.task.create({ id: 'TL', amend: true, acceptance: { commands: [long(2)] } });
      await orch.task.create({ id: 'TL', amend: true, acceptance: { commands: [long(3)] } });
    } finally { await orch.shutdownOwner(); await orch.close(); }
    const out = spawnSync(process.execPath, [CLI, 'receipts', 'run-l', '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    const text = out.stdout.split(/\r?\n/).map((l) => l.trim()).join('');
    assert.strictEqual((text.match(/\(amended /g) || []).length, 2, 'both markers survive');
    assert.ok(text.includes('then ->') && text.includes('xxx3'), 'the later step survives');
  } finally { cleanup(dir); }
});

test('integrate calls that ran checks of their own are listed in the run receipt and in belay receipts, as commands only', async () => {
  const rows = [
    { id: 'i1', run_id: 'r', into_branch: 'belay/integrate/r', checks: [{ source: 'integrate', argv: ['node', '--test', '--test-skip-pattern=parallel writers'], task_ids: [] }, { argv: ['npm', 'test'], task_ids: ['T1'] }] },
    { id: 'i2', run_id: 'r', into_branch: 'belay/integrate/r', checks: [{ argv: ['npm', 'test'], task_ids: ['T1'] }] },
    { id: 'i3', run_id: 'other', into_branch: 'x', checks: [{ source: 'integrate', argv: ['a'] }] },
  ];
  const got = RC.integrateChecksOf(rows, 'r');
  assert.deepStrictEqual(got, [{ integration_id: 'i1', into_branch: 'belay/integrate/r', commands: ['node --test --test-skip-pattern="parallel writers"'] }]);
  const text = renderText({ run_id: 'r', orchestrator: { pid: 1, session_id: 's', turns: 1, exit_code: 0 }, ended_by: 'idle', holds: [], polls: 0, task_checks: [], integrate_checks: got });
  assert.ok(text.split('\n').includes('integrate i1 into belay/integrate/r ran its own checks: node --test --test-skip-pattern="parallel writers"'), text);

  const dir = sandbox(), dataDir = `${dir}/.belay`;
  try {
    const repo = require('../core/worktree-helpers.cjs').makeRepo(dir);
    const orch = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-i', pid: process.pid } });
    try {
      await orch.run.attach({ adapter_pid: process.pid, project_dir: repo });
      const op = await openCore({ dataDir, caller: { role: 'operator', run_id: 'cli', pid: process.pid } });
      try {
        const t = await orch.task.create({ id: 'TI', spec: 'w', acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'] }] } });
        const wt = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
        const h = require('../core/worktree-helpers.cjs');
        h.write(wt.path, 'a.txt', 'a\n'); h.commit(wt.path, 'a');
        await orch.task.evaluate({ task_id: t.id });
        await orch.integration.merge({ task_ids: [t.id], checks: [{ argv: [process.execPath, '-e', 'process.exit(0)'] }] });
      } finally { await op.close(); }
    } finally { await orch.shutdownOwner(); await orch.close(); }
    const json = JSON.parse(spawnSync(process.execPath, [CLI, 'receipts', 'run-i', '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }).stdout);
    assert.strictEqual(json.integrate_checks.length, 1);
    assert.match(json.integrate_checks[0].commands[0], /^node(\.exe)? -e process\.exit\(0\)$/);
    const txt = spawnSync(process.execPath, [CLI, 'receipts', 'run-i', '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }).stdout;
    assert.ok(/integrate \S+ into \S+ ran its own checks: node/.test(txt), txt);
  } finally { cleanup(dir); }
});
