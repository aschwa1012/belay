'use strict';
// run-harness.test.cjs — a run's row records the belay that wrote it (ADR 0082 decision 1): the build from the store stamp, and the
// three facts only the run process can state. Recording only: no attach is refused for what it records. Real owner in the sandbox.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const { core, sandbox, cleanup } = require('./helpers.cjs');
const { rejectsCode } = require('./worktree-helpers.cjs');
const { ROOT, CLI } = require('../cli/stop-helpers.cjs');
const { openCore } = core('index.cjs');
const ST = require('../../src/core/schema-stamp.cjs');
const S = require('../../src/core/schema.cjs');
const HF = require('../../src/cli/run-harness-facts.cjs');
const RH = require('../../src/core/run-harness.cjs');

const SHA = 'a'.repeat(64);
const { descriptorOf } = require('../../src/cli/cmd-diff.cjs');
const open = (dir, role, run) => openCore({ dataDir: `${dir}/data`, caller: { role, run_id: run, pid: process.pid }, embed: false });

test('the run process states the facts, the build comes from the stamp, and a later epoch carries them under its own build', async () => {
  const dir = sandbox();
  const op = await open(dir, 'operator', 'r1');
  try {
    const a = await op.run.attach({ adapter_pid: process.pid, harness: { dirty: false, prompt_sha: SHA, prompt_marker: '0.4.0' } });
    assert.deepStrictEqual(a.run.harness, { build: ST.writtenBy(), schema_version: ST.SCHEMA_VERSION, dirty: false, prompt_sha: SHA, prompt_marker: '0.4.0', run_build: null });
    const orch = await open(dir, 'orchestrator', 'r1');
    try {
      const b = await orch.run.attach({ adapter_pid: process.pid });
      assert.strictEqual(b.epoch, 2);
      assert.deepStrictEqual(b.run.harness, a.run.harness, 'the orchestrator\'s adapter states nothing, so the run process\'s facts stand, under the build that wrote this row');
      const got = (await orch.run.get({})).run;
      assert.strictEqual(got.harness.prompt_sha, SHA, 'read back as an object');
      await rejectsCode(orch.run.attach({ adapter_pid: process.pid, harness: { dirty: true } }), 'E_ROLE');
    } finally { await orch.close(); }
    for (const bad of [{ dirty: 'yes' }, { prompt_sha: 'abc' }, { prompt_marker: 'x y' }, { build: 'belay@9' }, []]) await rejectsCode(op.run.attach({ adapter_pid: process.pid, harness: bad }), 'E_ARGS');
  } finally { await op.shutdownOwner(); await op.close(); cleanup(dir); }
});

test('an attach without the facts records the build alone, with the facts null', async () => {
  const dir = sandbox();
  const op = await open(dir, 'operator', 'r2');
  try {
    const a = await op.run.attach({ adapter_pid: process.pid });
    assert.deepStrictEqual(a.run.harness, { build: ST.writtenBy(), schema_version: ST.SCHEMA_VERSION, dirty: null, prompt_sha: null, prompt_marker: null, run_build: null });
  } finally { await op.shutdownOwner(); await op.close(); cleanup(dir); }
});

test('a build that differs between epochs is what the record shows for each', () => {
  const was = JSON.stringify({ build: 'belay@0.0.1+aaaaaaaaaaaa', schema_version: 1, dirty: true, prompt_sha: SHA, prompt_marker: '0.4.0' });
  const now = RH.record(null, was);
  assert.strictEqual(now.build, ST.writtenBy());
  assert.strictEqual(now.dirty, true, 'carried');
  assert.notStrictEqual(now.build, JSON.parse(was).build);
});

test('a store from before the column opens: the column is added, and an old run row reads as not recorded', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(S.ORCHESTRATION_SCHEMA.replace(/CREATE TABLE IF NOT EXISTS run \(/, 'CREATE TABLE IF NOT EXISTS run (')); // the base schema has no harness column
  assert.ok(!db.prepare("PRAGMA table_info(run)").all().some((c) => c.name === 'harness'));
  db.exec("INSERT INTO run(id, epoch, written_at, written_by) VALUES ('old', 1, 1, 'orchestrator')");
  S.ensureSchema(db);
  S.ensureSchema(db); // twice: the duplicate column is tolerated
  assert.ok(db.prepare("PRAGMA table_info(run)").all().some((c) => c.name === 'harness'));
  assert.strictEqual(db.prepare("SELECT harness FROM run WHERE id = 'old'").get().harness, null);
  assert.strictEqual(RH.line(null), 'not recorded');
});

test('dirty is read from belay\'s own checkout: true with a change, false without, null for an install with no checkout', async () => {
  const dir = sandbox();
  try {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    const g = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
    g('init', '-q'); fs.writeFileSync(path.join(repo, 'f.txt'), 'x'); g('add', '.'); g('commit', '-q', '-m', 'one');
    assert.strictEqual(await HF.dirtyOf(repo), false);
    fs.writeFileSync(path.join(repo, 'f.txt'), 'changed');
    assert.strictEqual(await HF.dirtyOf(repo), true);
    const plain = path.join(dir, 'plain'); fs.mkdirSync(plain);
    assert.strictEqual(await HF.dirtyOf(plain), null);
  } finally { cleanup(dir); }
});

test('the prompt hash is of the text sent, so a substituted prompt differs from its template', async () => {
  const template = 'Run for {{timeout}}.', sent = 'Run for 30 minutes.';
  const a = await HF.collect({ promptText: template, marker: '0.4.0', root: __dirname }), b = await HF.collect({ promptText: sent, marker: '0.4.0', root: __dirname });
  assert.notStrictEqual(a.prompt_sha, b.prompt_sha);
  assert.match(a.prompt_sha, /^[0-9a-f]{64}$/);
  assert.strictEqual((await HF.collect({ promptText: sent, root: __dirname })).prompt_marker, null);
});

test('belay receipts prints the build on the run line, in text and in JSON; a run from before the column says not recorded', async () => {
  const dir = sandbox(), dataDir = `${dir}/data`;
  try {
    const op = await open(dir, 'operator', 'run-b');
    await op.run.attach({ adapter_pid: process.pid, harness: { dirty: true, prompt_sha: SHA, prompt_marker: '0.4.0' } });
    await op.shutdownOwner(); await op.close();
    const cli = (...a) => spawnSync(process.execPath, [CLI, 'receipts', 'run-b', '--data', dataDir, ...a], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    const json = JSON.parse(cli('--json').stdout);
    assert.strictEqual(json.run.harness.build, ST.writtenBy());
    assert.strictEqual(json.run.harness.dirty, true);
    const out = cli();
    assert.strictEqual(out.status, 0, out.stderr);
    const want = `  belay ${ST.writtenBy()} (dirty checkout), prompt template 0.4.0 sha ${SHA.slice(0, 12)}`;
    assert.ok(out.stdout.split(String.fromCharCode(10)).map((l) => l.replace(String.fromCharCode(13), "")).includes(want), out.stdout);
    assert.match(RH.line(null), /^not recorded$/);
  } finally { cleanup(dir); }
});

test('belay diff names a build change between epochs on the run descriptor', () => {
  const h = (build) => JSON.stringify({ build });
  assert.strictEqual(descriptorOf('run', { epoch: 1, harness: h('belay@0.3.2+aaaaaaaaaaaa') }), 'epoch 1 build belay@0.3.2+aaaaaaaaaaaa');
  assert.strictEqual(descriptorOf('run', { epoch: 2, harness: h('belay@0.3.3+bbbbbbbbbbbb') }), 'epoch 2 build belay@0.3.3+bbbbbbbbbbbb');
  assert.strictEqual(descriptorOf('run', { epoch: 3, harness: null }), 'epoch 3', 'a row from before the column');
});

test('when the store owner and the run process are different builds the line labels each; a marker the core would refuse is left out, not sent', async () => {
  const h = { build: 'belay@0.3.3+bbbbbbbbbbbb', run_build: 'belay@0.3.2+aaaaaaaaaaaa', dirty: true, prompt_sha: SHA, prompt_marker: '0.4.0' };
  assert.strictEqual(RH.line(h), `store owner belay@0.3.3+bbbbbbbbbbbb; run process belay@0.3.2+aaaaaaaaaaaa (dirty checkout), prompt template 0.4.0 sha ${SHA.slice(0, 12)}`);
  assert.strictEqual(RH.line({ ...h, run_build: h.build }).startsWith('belay@0.3.3+bbbbbbbbbbbb (dirty checkout)'), true);
  const f = await HF.collect({ promptText: 'x', marker: '1'.repeat(40), root: __dirname });
  assert.strictEqual(f.prompt_marker, null);
  assert.strictEqual(f.run_build, ST.writtenBy());
  const dir = sandbox(), op = await open(dir, 'operator', 'r9');
  try {
    const a = await op.run.attach({ adapter_pid: process.pid, harness: { run_build: 'belay@0.0.1+aaaaaaaaaaaa', dirty: false } });
    assert.strictEqual(a.run.harness.run_build, 'belay@0.0.1+aaaaaaaaaaaa');
  } finally { await op.shutdownOwner(); await op.close(); cleanup(dir); }
});
