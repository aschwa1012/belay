'use strict';
// observe.test.cjs — build step 4b, amended by the
// orchestrator's Amendment section (B1, B3, B4, B5). Drives the built CLI's `tasks` and `briefing`
// as subprocesses, with the scaffolding of tests/cli/status.test.cjs and tests/cli/stop-helpers.cjs.
// `memory search`/`memory stats` are tests/cli/memory.test.cjs's own file (B4).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { openCore } = require('../../src/core/index.cjs');
const { ROOT, CLI, sandbox, cleanup, listRecursive } = require('./stop-helpers.cjs');

function tasksJson(args, dataDir) {
  return spawnSync(process.execPath, [CLI, 'tasks', ...args, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
}
function briefingJson(args, dataDir) {
  return spawnSync(process.execPath, [CLI, 'briefing', ...args, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
}

// B3: reading never writes, asserted by the sorted NAME listing (immune to an owner's own background
// heartbeat/WAL churn) — the same comparison tests/cli/status.test.cjs's checkedStatusJson uses.
function checked(fn, dataDir, label) {
  const before = listRecursive(dataDir);
  const r = fn();
  assert.deepStrictEqual(listRecursive(dataDir), before, `${label}: changed the data dir listing`);
  return r;
}

const vec = (seed) => Array.from({ length: 384 }, (_, i) => (((i + seed) % 7) + 1) / 10);

// B5's planting recipe, exactly as tests/core/methods.test.cjs plants rows: run.attach, worker.write
// (state running, this test's own live pid), task.create twice (the second depends_on the first),
// task.assign of the first to the worker, continuity.checkpoint (source 'harness' since the caller is
// orchestrator), and three memory.store rows with a supplied 384-float embedding. The unassigned second
// task is what `belay briefing --task <id>` prints with no lease.
async function plant(dataDir, runId, pid) {
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
  try {
    await core.run.attach({ adapter_pid: pid });
    await core.worker.write({ id: 'w1', substrate: 'claude-code', pid, state: 'running', turns: 0, started_at: Date.now() });
    const t1 = await core.task.create({ spec: 'first task, assigned to w1 and checkpointed' });
    const t2 = await core.task.create({ spec: 'second task, depends on the first', depends_on: [t1.id] });
    await core.task.assign({ task_id: t1.id, worker_id: 'w1' });
    await core.continuity.checkpoint({ task_id: t1.id, worker_id: 'w1', turn: 1, files_touched: ['a.txt'] });
    for (let i = 0; i < 3; i += 1) {
      await core.memory.store({ namespace: `run/${runId}`, text: `note ${i} about task ${t1.id}`, tags: [t1.id], embedding: vec(i), embedding_model: 'fixture', dim: 384 });
    }
    return { t1, t2 };
  } finally {
    await core.shutdownOwner();
    await core.close();
  }
}

// ================================================================ tasks

test("tasks: lists the run's tasks with lease, holder liveness, checkpoint age and dependencies; filters to the run; --all lists every run; a store with no tasks prints (no tasks)", async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { t1, t2 } = await plant(dataDir, 'run-a', process.pid);

  // A second run in the same store, written after run-a, so the default (no-argument) selection names it.
  const coreB = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-b', pid: process.pid } });
  let t3;
  try {
    await coreB.run.attach({ adapter_pid: process.pid });
    t3 = await coreB.task.create({ spec: 'a lone task on the other run' });
  } finally {
    await coreB.shutdownOwner();
    await coreB.close();
  }

  const rDefault = checked(() => tasksJson([], dataDir), dataDir, 'tasks (default run)');
  assert.strictEqual(rDefault.status, 0, `tasks: ${rDefault.stdout} / ${rDefault.stderr}`);
  const jDefault = JSON.parse(rDefault.stdout);
  assert.strictEqual(jDefault.run_id, 'run-b');
  assert.strictEqual(jDefault.run_id_source, 'run.list');
  assert.strictEqual(jDefault.tasks.length, 1);
  assert.strictEqual(jDefault.tasks[0].id, t3.id);

  const rA = checked(() => tasksJson(['run-a'], dataDir), dataDir, 'tasks run-a');
  assert.strictEqual(rA.status, 0, `tasks run-a: ${rA.stdout} / ${rA.stderr}`);
  const jA = JSON.parse(rA.stdout);
  assert.strictEqual(jA.run_id_source, 'argument');
  assert.strictEqual(jA.tasks.length, 2);
  const row1 = jA.tasks.find((t) => t.id === t1.id);
  const row2 = jA.tasks.find((t) => t.id === t2.id);
  assert.ok(row1.lease, 'the assigned task must carry a lease');
  assert.strictEqual(row1.lease.holder, 'w1');
  assert.strictEqual(row1.lease.holder_role, 'worker');
  assert.strictEqual(row1.holder_pid_alive, true);
  assert.ok(row1.last_checkpoint_id, 'the checkpointed task must carry a checkpoint id');
  assert.strictEqual(row2.lease, null, 'the unassigned task must carry no lease');
  assert.strictEqual(row2.holder_pid_alive, null);
  assert.strictEqual(row2.last_checkpoint_id, null);
  assert.deepStrictEqual(row2.depends_on, [t1.id]);

  const rAll = checked(() => tasksJson(['--all'], dataDir), dataDir, 'tasks --all');
  assert.strictEqual(rAll.status, 0, `tasks --all: ${rAll.stdout} / ${rAll.stderr}`);
  const jAll = JSON.parse(rAll.stdout);
  assert.strictEqual(jAll.run_id_source, 'all');
  assert.deepStrictEqual(jAll.tasks.map((t) => t.id).sort(), [t1.id, t2.id, t3.id].sort());

  // Text output: the header and one row's leading fields (B3), not only --json.
  const rText = checked(
    () => spawnSync(process.execPath, [CLI, 'tasks', 'run-a', '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }),
    dataDir, 'tasks run-a (text)',
  );
  assert.strictEqual(rText.status, 0, `tasks run-a text: ${rText.stdout} / ${rText.stderr}`);
  assert.match(rText.stdout, /^id\s+state\s+spec/, 'the table must start with a header naming id, state, spec');
  assert.match(rText.stdout, new RegExp(t1.id));

  // A store with no tasks: an absent data dir. Two empty listings prove nothing (B3), so the dir's
  // continued absence is asserted too, not only the (unchanged, trivially empty) listing comparison.
  const emptyDir = `${dir}/.belay-absent`;
  const before = listRecursive(emptyDir);
  const rEmpty = spawnSync(process.execPath, [CLI, 'tasks', '--data', emptyDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
  assert.strictEqual(rEmpty.status, 0, `tasks (absent dir): ${rEmpty.stdout} / ${rEmpty.stderr}`);
  assert.strictEqual(rEmpty.stdout.trim(), '(no tasks)');
  assert.deepStrictEqual(listRecursive(emptyDir), before);
  assert.ok(!fs.existsSync(emptyDir), 'tasks created the data dir');

  cleanup(dir);
});

// ================================================================ briefing

test('briefing: prints the resume line under 400 bytes and the document under 4,096 bytes for a worker and for a task, names the unverified section, and an unknown id is E_NOT_FOUND with exit 1', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { t1, t2 } = await plant(dataDir, 'run-c', process.pid);

  const rWorker = checked(() => briefingJson(['w1'], dataDir), dataDir, 'briefing w1');
  assert.strictEqual(rWorker.status, 0, `briefing w1: ${rWorker.stdout} / ${rWorker.stderr}`);
  const jWorker = JSON.parse(rWorker.stdout);
  assert.deepStrictEqual(jWorker.selector, { worker_id: 'w1' });
  assert.ok(jWorker.line.bytes <= 400, `line.bytes ${jWorker.line.bytes} exceeds 400`);
  assert.ok(jWorker.doc.bytes <= 4096, `doc.bytes ${jWorker.doc.bytes} exceeds 4096`);
  assert.strictEqual(jWorker.line.task_id, t1.id, "briefing w1 must resolve through the worker's own lease");
  assert.ok(jWorker.doc.sections.some((s) => /unverified/i.test(s)), `no section names 'unverified': ${JSON.stringify(jWorker.doc.sections)}`);
  // Blocking finding: the memory section must carry the rows planted in the task's OWN run namespace
  // (run/run-c), not read as empty because the CLI asked the placeholder namespace run/cli.
  const memSection = (jWorker.doc.text.split(/## recent memory rows tagged[^\n]*\n/)[1] || '').trim();
  assert.ok(!/^\(none\)/.test(memSection), `the memory section must show the planted rows, not '(none)': ${jWorker.doc.text}`);
  assert.match(memSection, /note \d about task/, `expected a planted memory row line: ${memSection}`);

  const rTask = checked(() => briefingJson(['--task', t2.id], dataDir), dataDir, 'briefing --task t2');
  assert.strictEqual(rTask.status, 0, `briefing --task: ${rTask.stdout} / ${rTask.stderr}`);
  const jTask = JSON.parse(rTask.stdout);
  assert.deepStrictEqual(jTask.selector, { task_id: t2.id });
  assert.strictEqual(jTask.line.lease_id, null, 'the unassigned task must carry no lease id');
  assert.ok(jTask.doc.sections.some((s) => /unverified/i.test(s)));

  // Text mode: the line, a blank line, then the document, with the unverified heading present.
  const rText = checked(
    () => spawnSync(process.execPath, [CLI, 'briefing', 'w1', '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }),
    dataDir, 'briefing w1 (text)',
  );
  assert.strictEqual(rText.status, 0, `briefing w1 text: ${rText.stdout} / ${rText.stderr}`);
  const lines = rText.stdout.split(/\r?\n/);
  assert.strictEqual(lines[0], jWorker.line.text, 'the first line must be the resume line');
  assert.strictEqual(lines[1], '', 'the second line must be blank');
  assert.match(rText.stdout, /unverified/i);

  const rUnknownWorker = checked(() => briefingJson(['no-such-worker'], dataDir), dataDir, 'briefing unknown worker');
  assert.strictEqual(rUnknownWorker.status, 1, `unknown worker: ${rUnknownWorker.stdout} / ${rUnknownWorker.stderr}`);
  assert.strictEqual(JSON.parse(rUnknownWorker.stderr).error.code, 'E_NOT_FOUND');

  const rUnknownTask = checked(() => briefingJson(['--task', 'no-such-task'], dataDir), dataDir, 'briefing unknown task');
  assert.strictEqual(rUnknownTask.status, 1, `unknown task: ${rUnknownTask.stdout} / ${rUnknownTask.stderr}`);
  assert.strictEqual(JSON.parse(rUnknownTask.stderr).error.code, 'E_NOT_FOUND');

  cleanup(dir);
});

// ================================================================ import graph and cold start

test('tasks, memory and briefing: no CLI path to any of them loads the embedder', async () => {
  const probe = `
    require(${JSON.stringify(CLI)});
    require(${JSON.stringify(`${ROOT}/src/cli/cmd-tasks.cjs`)});
    require(${JSON.stringify(`${ROOT}/src/cli/cmd-memory.cjs`)});
    require(${JSON.stringify(`${ROOT}/src/cli/cmd-briefing.cjs`)});
    const hit = Object.keys(require.cache).filter(k => /src[\\\\/]core[\\\\/]embedder\\.cjs$/i.test(k));
    process.stdout.write(JSON.stringify(hit));
  `;
  const rProbe = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(rProbe.status, 0, `probe failed: ${rProbe.stderr}`);
  assert.deepStrictEqual(JSON.parse(rProbe.stdout), [], 'requiring the command modules reached the embedder');

  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  await plant(dataDir, 'run-d', process.pid); // dead store: the owner elected above is already shut down
  const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-observe-dump-'));
  const dumper = path.join(dumpDir, 'dump-cache.cjs');
  fs.writeFileSync(dumper, [
    "process.on('exit', () => {",
    '  try {',
    "    require('fs').writeFileSync(process.env.BELAY_CACHE_DUMP, JSON.stringify(Object.keys(require.cache)));",
    '  } catch (e) { /* best effort */ }',
    '});',
    '',
  ].join('\n'));
  try {
    for (const args of [['tasks'], ['memory', 'stats'], ['briefing', 'w1']]) {
      const dumpFile = path.join(dumpDir, `${args.join('-')}.json`);
      const beforeListing = listRecursive(dataDir);
      const r = spawnSync(process.execPath, [CLI, ...args, '--data', dataDir, '--json'], {
        cwd: ROOT, windowsHide: true, encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: `--require ${dumper}`, BELAY_CACHE_DUMP: dumpFile },
      });
      assert.strictEqual(r.status, 0, `${args.join(' ')}: ${r.stdout} / ${r.stderr}`);
      assert.deepStrictEqual(listRecursive(dataDir), beforeListing, `${args.join(' ')} (cache-dump run) changed the data dir listing`);
      const cache = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
      const bad = cache.filter((k) => /embedder\.cjs$/i.test(k) || /@huggingface/i.test(k));
      assert.deepStrictEqual(bad, [], `${args.join(' ')} reached the embedder: ${bad.join(', ')}`);
    }
  } finally {
    fs.rmSync(dumpDir, { recursive: true, force: true });
    cleanup(dir);
  }
});
