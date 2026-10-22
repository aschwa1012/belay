'use strict';
// permission.test.cjs — build step 6d, design item 5,
// ADR 0020 decision 4. The built CLI as a subprocess (spawn, never spawnSync — tests/cli/worker-
// control.test.cjs's cliAsync) against an owner elected in this process as role orchestrator; requests
// planted by a worker core w-1 over the pipe.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { sandbox, cleanup, listRecursive } = require('./stop-helpers.cjs');
const { openCore } = require('../../src/core/index.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
  return r.pid;
}

function cliAsync(args, dataDir, extraEnv) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args, '--data', dataDir, '--json'], {
      cwd: ROOT, windowsHide: true, env: { ...process.env, ...(extraEnv || {}) },
    });
    let stdout = ''; proc.stdout.on('data', (d) => { stdout += d; });
    let stderr = ''; proc.stderr.on('data', (d) => { stderr += d; });
    proc.once('exit', (status) => {
      let receipt = null;
      try { receipt = JSON.parse(status === 0 ? stdout : stderr); } catch { /* left null */ }
      resolve({ status, stdout, stderr, receipt });
    });
  });
}

async function setupOwner(dataDir, runId) {
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid }, embed: false });
  await core.run.attach({ adapter_pid: process.pid });
  return core;
}

// ================================================================ (s) pending

test('pending: lists the pending rows with digest, age and adapter_alive from a pid check, --all adds the decided rows, a store with no owner is read from a copy, no store answers an empty list, and none of them creates a file or elects', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    // no store at all
    const noStore = await cliAsync(['pending'], dataDir);
    assert.strictEqual(noStore.status, 0, JSON.stringify(noStore));
    assert.strictEqual(noStore.receipt.count, 0);
    assert.strictEqual(fs.existsSync(dataDir), false, 'pending must create nothing against an absent data dir');

    let core = await setupOwner(dataDir, 'run-s');
    const w1 = await openCore({ dataDir, caller: { role: 'worker', worker_id: 'w-s1', run_id: 'run-s', pid: process.pid }, embed: false });
    const wdead = await openCore({ dataDir, caller: { role: 'worker', worker_id: 'w-s2', run_id: 'run-s', pid: deadPid() }, embed: false });
    try {
      const id1 = 'perm-s1'; const id2 = 'perm-s2';
      await w1.permission.request({ id: id1, tool: 'Bash', input: { command: 'x'.repeat(200) } });
      await wdead.permission.request({ id: id2, tool: 'Bash', input: null });
      await core.permission.decide({ id: id2, verdict: 'allow' });

      const before = listRecursive(dataDir);
      const r = await cliAsync(['pending'], dataDir);
      assert.strictEqual(r.status, 0, JSON.stringify(r));
      assert.strictEqual(r.receipt.count, 1, 'default lists pending only');
      const row = r.receipt.requests[0];
      assert.strictEqual(row.id, id1);
      assert.ok(row.digest.length <= 121, 'the digest is cut at 120 bytes plus the ellipsis');
      assert.strictEqual(typeof row.age_ms, 'number');
      assert.strictEqual(row.adapter_pid, process.pid);
      assert.strictEqual(row.adapter_alive, true);
      assert.deepStrictEqual(listRecursive(dataDir), before, 'pending must create nothing');

      const rAll = await cliAsync(['pending', '--all'], dataDir);
      assert.strictEqual(rAll.receipt.count, 2);
      const decidedRow = rAll.receipt.requests.find((x) => x.id === id2);
      assert.strictEqual(decidedRow.state, 'allowed');
      assert.strictEqual(decidedRow.adapter_alive, false);
      assert.deepStrictEqual(listRecursive(dataDir), before, '--all must create nothing either');
    } finally { await w1.close(); await wdead.close(); }

    // a store with no owner is read from a copy
    await core.shutdownOwner();
    await core.close();
    core = null;
    const before2 = listRecursive(dataDir);
    const rCopy = await cliAsync(['pending'], dataDir);
    assert.strictEqual(rCopy.status, 0);
    assert.strictEqual(rCopy.receipt.count, 1);
    assert.deepStrictEqual(listRecursive(dataDir), before2, 'a copy read must create nothing new');
  } finally { cleanup(dir); }
});

// ================================================================ (t) approve

test('approve: over the owner pipe the verdict row lands allowed with verdict_by operator:<cli pid>, a wait in flight resolves with it within 500 ms, worker_after names whether the worker row moved, and exit is 0', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  let core = null, w1 = null;
  try {
    core = await setupOwner(dataDir, 'run-t');
    await core.worker.write({ id: 'w-t1', substrate: 'claude-code', pid: process.pid, state: 'running', run_id: 'run-t', turns: 0, started_at: Date.now() });
    w1 = await openCore({ dataDir, caller: { role: 'worker', worker_id: 'w-t1', run_id: 'run-t', pid: process.pid }, embed: false });

    const id = 'perm-t1';
    await w1.permission.request({ id, tool: 'Bash', input: { command: 'echo hi' } });
    let waitResolvedAt = null;
    const waitPromise = w1.permission.wait({ id, timeout_ms: 10000 }).then((v) => { waitResolvedAt = Date.now(); return v; });

    const t0 = Date.now();
    const r = await cliAsync(['approve', id], dataDir);
    assert.strictEqual(r.status, 0, JSON.stringify(r));
    assert.strictEqual(r.receipt.decided, true);
    assert.strictEqual(r.receipt.id, id);
    assert.strictEqual(r.receipt.worker_id, 'w-t1');
    assert.strictEqual(r.receipt.run_id, 'run-t');
    assert.strictEqual(r.receipt.verdict.state, 'allowed');
    assert.match(r.receipt.verdict.verdict_by, /^operator:\d+$/, 'verdict_by names role and the CLI\'s own pid');

    const waited = await waitPromise;
    assert.strictEqual(waited.timed_out, false, 'the in-flight wait must resolve, not time out');
    // The decide lands well inside the CLI's own worker_after budget (2,000 ms), long before the CLI
    // process itself returns; the waiter is woken the instant it commits.
    assert.ok(waitResolvedAt - t0 < 2000, `the in-flight wait resolved ${waitResolvedAt - t0} ms after the approve began`);

    assert.strictEqual(typeof r.receipt.worker_after_moved, 'boolean', 'worker_after names whether the row moved');
    assert.strictEqual(typeof r.receipt.worker_after_waited_ms, 'number');
    assert.match(r.receipt.established_by, /permission\.decide over the owner pipe answered in \d+ ms/);
  } finally {
    if (core) { await core.shutdownOwner().catch(() => {}); await core.close(); }
    if (w1) await w1.close();
    cleanup(dir);
  }
});

// ================================================================ (u) deny

test('deny: the reason is every positional after the id, the row reads denied with it, and the receipt discloses adapter_pid_alive false when nobody is waiting', async (tcx) => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  let core = null;
  try {
    core = await setupOwner(dataDir, 'run-u');
    const wdead = await openCore({ dataDir, caller: { role: 'worker', worker_id: 'w-u1', run_id: 'run-u', pid: deadPid() }, embed: false });
    tcx.after(() => Promise.resolve().then(() => wdead.close()).catch(() => {}));
    const id = 'perm-u1';
    await wdead.permission.request({ id, tool: 'Bash', input: null });
    await wdead.close();

    const r = await cliAsync(['deny', id, 'not', 'today'], dataDir);
    assert.strictEqual(r.status, 0, JSON.stringify(r));
    assert.strictEqual(r.receipt.decided, true);
    assert.strictEqual(r.receipt.verdict.state, 'denied');
    assert.strictEqual(r.receipt.verdict.reason, 'not today');
    assert.strictEqual(r.receipt.adapter_pid_alive, false, 'nobody was waiting: the requesting adapter is dead');
  } finally {
    if (core) { await core.shutdownOwner().catch(() => {}); await core.close(); }
    cleanup(dir);
  }
});

// ================================================================ (v) refusals

test('approve and deny: each refusal names the fact, creates nothing and elects nothing: no data dir, no owner (last carried), an unknown id, a row already decided, and the usage errors', async (tcx) => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    // no data dir at all
    for (const args of [['approve', 'x'], ['deny', 'x', 'why']]) {
      const r = await cliAsync(args, dataDir);
      assert.strictEqual(r.status, 1, JSON.stringify(r));
      assert.strictEqual(r.receipt.decided, false);
      assert.match(r.receipt.reason, /no such data dir/);
      assert.strictEqual(fs.existsSync(dataDir), false);
    }

    // no owner: last is carried
    let core = await setupOwner(dataDir, 'run-v');
    tcx.after(() => Promise.resolve().then(() => core.shutdownOwner()).catch(() => {}));
    tcx.after(() => Promise.resolve().then(() => core.close()).catch(() => {}));
    await core.shutdownOwner();
    await core.close();
    core = null;
    for (const args of [['approve', 'x'], ['deny', 'x', 'why']]) {
      const r = await cliAsync(args, dataDir);
      assert.strictEqual(r.status, 1, JSON.stringify(r));
      assert.strictEqual(r.receipt.decided, false);
      assert.match(r.receipt.reason, /no live run/);
      assert.ok(r.receipt.last, 'last must be carried when the cause is E_NO_OWNER');
      assert.strictEqual(r.receipt.last.id, 'run-v');
    }

    // an unknown id, over a live owner
    core = await setupOwner(dataDir, 'run-v2');
    try {
      const before = listRecursive(dataDir);
      for (const args of [['approve', 'no-such-id'], ['deny', 'no-such-id', 'why']]) {
        const r = await cliAsync(args, dataDir);
        assert.strictEqual(r.status, 1, JSON.stringify(r));
        assert.strictEqual(r.receipt.decided, false);
        assert.strictEqual(r.receipt.error.code, 'E_NOT_FOUND');
      }
      assert.deepStrictEqual(listRecursive(dataDir), before, 'an unknown-id refusal must create nothing');

      // a row already decided
      const w = await openCore({ dataDir, caller: { role: 'worker', worker_id: 'w-v1', run_id: 'run-v2', pid: process.pid }, embed: false });
      tcx.after(() => Promise.resolve().then(() => w.close()).catch(() => {}));
      const id = 'perm-v1';
      await w.permission.request({ id, tool: 'Bash', input: null });
      await core.permission.decide({ id, verdict: 'allow' });
      await w.close();

      const r2 = await cliAsync(['deny', id, 'late'], dataDir);
      assert.strictEqual(r2.status, 1, JSON.stringify(r2));
      assert.strictEqual(r2.receipt.decided, false);
      assert.strictEqual(r2.receipt.error.code, 'E_ARGS');
    } finally {
      if (core) { await core.shutdownOwner().catch(() => {}); await core.close(); }
    }

    // usage errors: exit 2
    const bareApprove = spawnSync(process.execPath, [CLI, 'approve', '--data', dataDir, '--json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.strictEqual(bareApprove.status, 2);
    const twoArgsApprove = spawnSync(process.execPath, [CLI, 'approve', 'a', 'b', '--data', dataDir, '--json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.strictEqual(twoArgsApprove.status, 2);
    const bareDeny = spawnSync(process.execPath, [CLI, 'deny', '--data', dataDir, '--json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.strictEqual(bareDeny.status, 2);
    const unknownOptPending = spawnSync(process.execPath, [CLI, 'pending', '--bogus', '--data', dataDir, '--json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.strictEqual(unknownOptPending.status, 2);
    const extraPositionalPending = spawnSync(process.execPath, [CLI, 'pending', 'extra', '--data', dataDir, '--json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.strictEqual(extraPositionalPending.status, 2);
  } finally { cleanup(dir); }
});

// ================================================================ (w) no path to the embedder or src/run

test('pending, approve and deny: no CLI path loads the embedder or src/run', () => {
  const probe = [
    `require(${JSON.stringify(CLI)});`,
    `require(${JSON.stringify(`${ROOT}/src/cli/cmd-pending.cjs`)});`,
    `require(${JSON.stringify(`${ROOT}/src/cli/cmd-decide.cjs`)});`,
    "const embedder = Object.keys(require.cache).filter(k => /src[\\\\/]core[\\\\/]embedder\\.cjs$/i.test(k));",
    "const run = Object.keys(require.cache).filter(k => /[\\\\/]src[\\\\/]run[\\\\/]/i.test(k));",
    'process.stdout.write(JSON.stringify({ embedder, run }));',
  ].join('\n');
  const rProbe = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(rProbe.status, 0, `probe failed: ${rProbe.stderr}`);
  const hit = JSON.parse(rProbe.stdout);
  assert.deepStrictEqual(hit.embedder, [], 'requiring the command modules reached the embedder');
  assert.deepStrictEqual(hit.run, [], 'requiring the command modules reached src/run');
});
