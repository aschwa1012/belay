'use strict';
// spawn-check-first.test.cjs — ADR 0030 decision 4. A spawn whose task cannot be assigned is refused
// before it writes anything: no worker row, no worker directory or config files, and the worker id stays
// free. The real core and the real run manager, a fake claude binary, a sandbox under the OS temp dir.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { cleanup } = require('../core/helpers.cjs');
const { pidAlive, killPid, waitPidGone } = require('../../src/run/process.cjs');
const { createFakeCore } = require('./fake-core.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };

function mgr(core, data, runId) {
  return createRunManager({
    core, dataDir: data, runId,
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
}

test('a spawn refused by its task writes no row and no files, and the same worker_id succeeds once the task is assignable', async () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-spawn-check-'));
  const data = path.join(sb, 'data').replace(/\\/g, '/');
  const worktree = path.join(sb, 'wt').replace(/\\/g, '/');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  const runId = 'run-spawn-check-' + process.pid;
  const core = await openCore({ dataDir: data, caller: { role: 'orchestrator', run_id: runId, pid: process.pid }, embed: false });
  let m = null;
  try {
    await core.run.attach({ adapter_pid: process.pid });
    m = mgr(core, data, runId);

    const dep = await core.task.create({ spec: 'the dependency', acceptance: PASS });
    const task = await core.task.create({ spec: 'blocked work', depends_on: [dep.id] });
    const before = await core.task.get({ task_id: task.id });
    const workersBefore = (await core.worker.list({})).workers.length;

    await assert.rejects(
      m.spawn({ substrate: 'claude-code', worktree, prompt: 'go', worker_id: 'wchk', task_id: task.id }),
      (e) => {
        assert.strictEqual(e.code, 'E_DEPENDENCY_OPEN', `${e.code}: ${e.message}`);
        assert.strictEqual(e.detail.blocked_by, dep.id);
        return true;
      },
    );
    assert.strictEqual((await core.worker.list({})).workers.length, workersBefore, 'no worker row of any state was written');
    await assert.rejects(core.worker.get({ worker_id: 'wchk' }), (e) => e.code === 'E_NOT_FOUND');
    assert.strictEqual(fs.existsSync(path.join(data, 'workers', 'wchk')), false, 'no worker directory, so no mcp.json, settings.json or argv.json');
    const after = await core.task.get({ task_id: task.id });
    assert.strictEqual(after.seq, before.seq, 'the task row was not touched');
    assert.strictEqual(after.lease, null);

    // Clear the dependency; the same worker_id now spawns, because the id was never used.
    const ev = await core.task.evaluate({ task_id: dep.id, worktree });
    assert.strictEqual(ev.state, 'done');
    const row = await m.spawn({ substrate: 'claude-code', worktree, prompt: 'go', worker_id: 'wchk', task_id: task.id });
    assert.strictEqual(row.state, 'running');
    assert.strictEqual(row.id, 'wchk');
    assert.strictEqual((await core.task.get({ task_id: task.id })).state, 'assigned');
  } finally {
    if (m) await m.shutdown();
    try { await core.shutdownOwner(); } finally { await core.close(); cleanup(sb); }
  }
});

test('with the fake core: a refused check writes no row; a refusal after the check still takes the write-dead path', async () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-spawn-check2-'));
  const data = path.join(sb, 'data').replace(/\\/g, '/');
  const worktree = path.join(sb, 'wt').replace(/\\/g, '/');
  fs.mkdirSync(worktree, { recursive: true });
  const fake1 = createFakeCore({ failing: { 'task.assign:check': 'E_DEPENDENCY_OPEN' } });
  const m1 = mgr(fake1, data, 'run-test');
  const fake2 = createFakeCore({ failing: { 'task.assign': 'E_DEPENDENCY_OPEN' } });
  const m2 = mgr(fake2, data, 'run-test');
  try {
    await assert.rejects(m1.spawn({ substrate: 'claude-code', worktree, prompt: 'x', worker_id: 'wa', task_id: 't1' }), (e) => e.code === 'E_DEPENDENCY_OPEN');
    assert.deepStrictEqual(fake1.rowsFor('wa'), []);
    assert.strictEqual(fs.existsSync(path.join(data, 'workers', 'wa')), false);
    assert.ok(fake1.calls.every((c) => c.method !== 'worker.write'), 'nothing was written to the core');

    await assert.rejects(m2.spawn({ substrate: 'claude-code', worktree, prompt: 'x', worker_id: 'wb', task_id: 't2' }), (e) => e.code === 'E_DEPENDENCY_OPEN');
    assert.deepStrictEqual(fake2.rowsFor('wb').map((r) => r.state), ['starting', 'dead']);
  } finally {
    await m1.shutdown();
    await m2.shutdown();
    cleanup(sb);
  }
});

test('two concurrent spawns with one worker_id and a task_id: one wins, the other is E_ARGS, one child exists', async () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-spawn-check3-'));
  const data = path.join(sb, 'data').replace(/\\/g, '/');
  const worktree = path.join(sb, 'wt').replace(/\\/g, '/');
  fs.mkdirSync(worktree, { recursive: true });
  const fake = createFakeCore();
  const m = mgr(fake, data, 'run-test');
  const pids = [];
  const gone = [];
  try {
    const args = { substrate: 'claude-code', worktree, prompt: 'go', worker_id: 'wrace', task_id: 't-race' };
    const results = await Promise.allSettled([m.spawn(args), m.spawn(args)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    for (const r of ok) if (r.value && r.value.pid) pids.push({ pid: r.value.pid, created: r.value.pid_created }); // before any assertion can throw
    const bad = results.filter((r) => r.status === 'rejected');
    assert.strictEqual(ok.length, 1);
    assert.strictEqual(bad.length, 1);
    assert.strictEqual(bad[0].reason.code, 'E_ARGS');
    assert.match(bad[0].reason.message, /already exists/);
    assert.strictEqual((await m.list()).workers.length, 1, 'one child exists');
    assert.strictEqual(fake.callsTo('task.assign').filter((c) => !c.args.check_only).length, 1, 'one real assign');
    assert.deepStrictEqual(fake.rowsFor('wrace').map((r) => r.state), ['starting', 'starting', 'running']);
  } finally {
    try { await m.shutdown(); } finally {
      // A regressed reservation leaves a child the manager no longer tracks; stop each recorded pid by its exact pid.
      for (const { pid, created } of pids) {
        if (pidAlive(pid) && require('../crash.cjs').crash(pid, created)) gone.push(await waitPidGone(pid));
      }
      cleanup(sb);
    }
  }
  assert.ok(pids.length >= 1, 'a pid was recorded');
  assert.ok(gone.every((g) => g !== null), 'waitPidGone timed out on a surviving pid');
  for (const pid of pids) assert.strictEqual(pidAlive(pid), false, 'shutdown left no live child');
});

test('a refused spawn releases the id reservation: a retry with the same worker_id is not E_ARGS', async () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-spawn-check4-'));
  const data = path.join(sb, 'data').replace(/\\/g, '/');
  const worktree = path.join(sb, 'wt').replace(/\\/g, '/');
  fs.mkdirSync(worktree, { recursive: true });
  const failing = { 'task.assign:check': 'E_DEPENDENCY_OPEN' };
  const fake = createFakeCore({ failing });
  const m = mgr(fake, data, 'run-test');
  try {
    const args = { substrate: 'claude-code', worktree, prompt: 'go', worker_id: 'wretry', task_id: 't-retry' };
    await assert.rejects(m.spawn(args), (e) => e.code === 'E_DEPENDENCY_OPEN');
    delete failing['task.assign:check'];
    const row = await m.spawn(args);
    assert.strictEqual(row.state, 'running');
  } finally {
    await m.shutdown();
    cleanup(sb);
  }
});
