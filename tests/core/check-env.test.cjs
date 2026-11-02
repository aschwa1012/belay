'use strict';
// check-env.test.cjs — a check records the environment it ran in (ADR 0080 decision 1). Recording only: nothing here refuses a check or
// changes what ran. Unit tests of the fingerprint, then task.evaluate and integration.merge against real git in the sandbox.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, write, commit } = require('./worktree-helpers.cjs');
const V = require('../../src/mcp/views.cjs');
const CE = require('../../src/core/check-env.cjs');

const { openCore } = core('index.cjs');
const NODE = [{ argv: [process.execPath, '-e', '0'], cwd: process.cwd() }];
const base = () => ({ ...process.env });

let dir, orch, op;
before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  op = await openCore({ dataDir: `${dir}/data`, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
});
after(async () => {
  delete process.env.BELAY_ENV_PROBE;
  await op.close();
  await orch.shutdownOwner();
  await orch.close();
  cleanup(dir);
});

test('a changed BELAY_ variable changes env_fp and names the input; the value is never shown', async () => {
  const a = await CE.capture(NODE, { salt: 's', env: { ...base(), BELAY_ENV_PROBE: 'one' } });
  const b = await CE.capture(NODE, { salt: 's', env: { ...base(), BELAY_ENV_PROBE: 'two' }, previous: a });
  assert.notStrictEqual(a.env_fp, b.env_fp);
  assert.deepStrictEqual(b.changed, ['env:BELAY_ENV_PROBE']);
  assert.ok(!JSON.stringify(b).includes('two'), 'a value is not in the record');
  const same = await CE.capture(NODE, { salt: 's', env: { ...base(), BELAY_ENV_PROBE: 'one' }, previous: a });
  assert.strictEqual(same.env_fp, a.env_fp);
  assert.deepStrictEqual(same.changed, []);
  const salted = await CE.capture(NODE, { salt: 'other', env: { ...base(), BELAY_ENV_PROBE: 'one' } });
  assert.notStrictEqual(salted.env_fp, a.env_fp, 'fingerprints compare only within one store');
});

test('a credential-named variable is listed by name and changes nothing', async () => {
  const a = await CE.capture(NODE, { salt: 's', env: { ...base(), CLAUDE_CODE_OAUTH_TOKEN: 'secret-one' } });
  const b = await CE.capture(NODE, { salt: 's', env: { ...base(), CLAUDE_CODE_OAUTH_TOKEN: 'secret-two' } });
  assert.strictEqual(a.env_fp, b.env_fp);
  assert.ok(a.facts.withheld.includes('CLAUDE_CODE_OAUTH_TOKEN'));
  assert.ok(!JSON.stringify(a).includes('secret-one'));
});

test('node_modules/.package-lock.json and the resolved binary are inputs', async () => {
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(proj, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'node_modules', '.package-lock.json'), '{"a":1}');
  const cmd = [{ argv: [process.execPath, '-e', '0'], cwd: proj }];
  const a = await CE.capture(cmd, { salt: 's' });
  fs.writeFileSync(path.join(proj, 'node_modules', '.package-lock.json'), '{"a":2}');
  const b = await CE.capture(cmd, { salt: 's', previous: a });
  assert.deepStrictEqual(b.changed, ['node_modules_lock']);
  assert.strictEqual(a.facts.node, process.version);
});

test('a bare name resolves the way the spawn does: the cwd before PATH on Windows, PATH only elsewhere', () => {
  const cwdDir = path.join(dir, 'cwdbin'), pathDir = path.join(dir, 'pathbin');
  fs.mkdirSync(cwdDir, { recursive: true }); fs.mkdirSync(pathDir, { recursive: true });
  const ext = process.platform === 'win32' ? '.exe' : '';
  fs.writeFileSync(path.join(cwdDir, `zzprobe${ext}`), 'x');
  fs.writeFileSync(path.join(pathDir, `zzprobe${ext}`), 'x');
  const env = { PATH: pathDir };
  const got = CE.resolveBinary('zzprobe', cwdDir, env);
  assert.strictEqual(got, path.join(process.platform === 'win32' ? cwdDir : pathDir, `zzprobe${ext}`));
  assert.strictEqual(CE.resolveBinary('zz-not-here', cwdDir, env), null);
});

test('task.evaluate records the environment on the results, names what changed on the next evaluation, and decides nothing by it', async () => {
  const repo = makeRepo(dir);
  const failing = { argv: [process.execPath, '-e', 'process.exit(1)'] }; // stays open, so it can be evaluated again
  const t = await orch.task.create({ spec: 'env record', acceptance: { commands: [failing] } });
  const w = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  write(w.path, 'a.txt', 'a\n'); commit(w.path, 'a');
  delete process.env.BELAY_ENV_PROBE;
  const first = await orch.task.evaluate({ task_id: t.id });
  assert.match(first.results.env.env_fp, /^[0-9a-f]{16}$/);
  assert.strictEqual(first.results.env.facts.node, process.version);
  assert.strictEqual(first.results.env.changed, undefined, 'nothing before it to differ from');
  assert.strictEqual(first.results.passed, false, 'the failing command still fails');
  process.env.BELAY_ENV_PROBE = 'changed';
  const second = await orch.task.evaluate({ task_id: t.id });
  assert.notStrictEqual(second.results.env.env_fp, first.results.env.env_fp);
  assert.deepStrictEqual(second.results.env.changed, ['env:BELAY_ENV_PROBE']);
  assert.strictEqual(second.results.checks[0].exit_code, 1, 'the command ran the same');
  const shown = V.taskEvaluate(second).results.env;
  assert.deepStrictEqual(Object.keys(shown).sort(), ['changed', 'env_fp', 'facts'], 'the per-input digests stay in the store');
  const row = V.taskList({ tasks: [second] }).tasks[0].results;
  assert.strictEqual(row.env_fp, second.results.env.env_fp);
  assert.deepStrictEqual(row.env_changed, ['env:BELAY_ENV_PROBE']);
});

test('a task with no command checks records no environment', async () => {
  const t = await orch.task.create({ spec: 'no commands', acceptance: { files_within_owned: true } });
  assert.strictEqual(await CE.forTask(null, t, dir), null);
});

test('an executed integration check records the fingerprint and the facts, a reused one does not run and records none', async () => {
  const repo = makeRepo(dir);
  const t = await orch.task.create({ spec: 'integrate env', acceptance: { commands: [{ argv: [process.execPath, '-e', '0'] }] } });
  const w = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  write(w.path, 'i.txt', 'i\n'); commit(w.path, 'i');
  await orch.task.evaluate({ task_id: t.id });
  const r = await orch.integration.merge({ task_ids: [t.id], into: 'belay/integrate/test-run', checks: [{ argv: [process.execPath, '-e', '0'], timeout_ms: 61000 }] });
  assert.ok(Array.isArray(r.checks), JSON.stringify(r).slice(0, 600));
  const ran = r.checks.filter((c) => c.executable === true);
  assert.ok(ran.length >= 1);
  for (const c of ran) {
    assert.match(c.env_fp, /^[0-9a-f]{16}$/);
    assert.strictEqual(c.env_facts.node, process.version);
    assert.strictEqual(c.env_inputs, undefined);
  }
  for (const c of r.checks.filter((k) => k.reused_from)) assert.strictEqual(c.env_fp, undefined);
});

test('belay receipts shows the environment of a task\'s last evaluation, in JSON and in text', async () => {
  const { spawnSync } = require('node:child_process');
  const { ROOT, CLI } = require('../cli/stop-helpers.cjs');
  const repo = makeRepo(dir);
  const t = await orch.task.create({ spec: 'env receipt', acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(1)'] }] } });
  const w = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  write(w.path, 'r.txt', 'r\n'); commit(w.path, 'r');
  const ev = await orch.task.evaluate({ task_id: t.id });
  const cli = (...a) => spawnSync(process.execPath, [CLI, 'receipts', 'test-run', '--data', `${dir}/data`, ...a], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
  const view = JSON.parse(cli('--json').stdout);
  const mine = [...view.unassigned_tasks, ...view.workers.map((x) => x.task).filter(Boolean)].find((x) => x.id === t.id);
  assert.strictEqual(mine.env.env_fp, ev.results.env.env_fp);
  const out = cli();
  assert.strictEqual(out.status, 0, out.stderr);
  assert.match(out.stdout + out.stderr, new RegExp(`environment ${ev.results.env.env_fp} node ${process.version.replace(/\./g, '\.')}`));
});
