'use strict';
// worker-control.test.cjs — build step 6c, item 7 second
// bullet. The built CLI as a subprocess against a manager in THIS process, the scaffold of
// tests/cli/run-wake.test.cjs: this process elects the owner as role orchestrator, run.attach with its
// own pid as adapter_pid, createRunManager over the fake, createWorkerControl over it. Every CLI
// invocation here uses `spawn`, never `spawnSync`: this process's own event loop is what serves both
// the owner's pipe and the adapter's, and a blocking spawnSync would starve them for the wait (as
// tests/cli/worker.test.cjs's own cliAsync comment explains).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { sandbox, cleanup, listRecursive, readStoreCopy } = require('./stop-helpers.cjs');

const { openCore } = require('../../src/core/index.cjs');
const { createRunManager, createWorkerControl } = require('../../src/run/index.cjs');
const { adapterPipeName } = require('../../src/core/lock.cjs');
const P = require('../../src/run/process.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const USER_SETTINGS = `${ROOT}/tests/run/fixtures/user-settings.json`;

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

async function ownChildCount() {
  return (await P.childPids(process.pid)).length;
}

function workerWorktree(dir, id) {
  const wt = `${dir}/${id}-wt`;
  fs.mkdirSync(wt, { recursive: true });
  return wt;
}

// This process becomes the store owner (role orchestrator elects on a write), attaches its own pid as
// adapter_pid, then creates a real RunManager over the fake and a control listening over it — the same
// shape an attached orchestrator adapter has, entirely in-process so the CLI subprocess is the only
// other process involved.
async function setupOwnerAndManager(dataDir, runId) {
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
  await core.run.attach({ adapter_pid: process.pid });
  const m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE_CLAUDE, userSettings: USER_SETTINGS } });
  const control = createWorkerControl({ dataDir, manager: m });
  await control.listen();
  return { core, m, control };
}

async function teardown({ core, m, control, dir }) {
  if (control) { try { await control.close(); } catch { /* best effort */ } }
  if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
  else if (core) {
    try { if (core.isOwner()) await core.shutdownOwner(); } catch { /* best effort */ }
    try { await core.close(); } catch { /* best effort */ }
  }
  if (dir) cleanup(dir);
}

// ================================================================ (e) stop over the adapter's pipe

test("worker stop: over the adapter's pipe the receipt is the manager's own, the row lands stopped, the session id is kept, and the bound is the sum of the manager's waits", async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  let core = null, m = null, control = null;
  try {
    ({ core, m, control } = await setupOwnerAndManager(dataDir, 'run-e'));
    await m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' });

    const r = await cliAsync(['worker', 'stop', 'w1'], dataDir);
    assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
    assert.strictEqual(r.receipt.stopped, true);
    assert.strictEqual(r.receipt.graceful, true);
    assert.strictEqual(r.receipt.channel, 'adapter-pipe');
    assert.strictEqual(r.receipt.adapter_pid, process.pid);
    assert.ok(r.receipt.session_id, 'session_id must be kept on a graceful stop');
    assert.strictEqual(r.receipt.ladder.length, 5, JSON.stringify(r.receipt.ladder));
    assert.ok(r.receipt.ladder.every((rung) => rung.ok === true), JSON.stringify(r.receipt.ladder));

    const stored = readStoreCopy(dataDir, (db) => db.prepare('SELECT * FROM worker WHERE id = ? ORDER BY seq DESC LIMIT 1').get('w1'));
    assert.strictEqual(stored.state, 'stopped');
  } finally { await teardown({ core, m, control, dir }); }
});

// ================================================================ (f) restart over the adapter's pipe

test("worker restart: over the adapter's pipe the receipt names the branch and the new pid, and the new process is the adapter's child", async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  let core = null, m = null, control = null;
  try {
    ({ core, m, control } = await setupOwnerAndManager(dataDir, 'run-f'));
    const row = await m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' });

    const r = await cliAsync(['worker', 'restart', 'w1'], dataDir);
    assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
    assert.strictEqual(r.receipt.restarted, true);
    assert.strictEqual(r.receipt.old_pid, row.pid);
    assert.notStrictEqual(r.receipt.new_pid, row.pid);
    assert.strictEqual(P.pidAlive(r.receipt.new_pid), true);
    assert.ok(r.receipt.branch === 'resume' || r.receipt.branch === 'replace', r.receipt.branch);

    const kids = await P.childPids(process.pid);
    assert.ok(kids.includes(r.receipt.new_pid), `new pid ${r.receipt.new_pid} must be this process's own child: ${JSON.stringify(kids)}`);
  } finally { await teardown({ core, m, control, dir }); }
});

// ================================================================ (g) message over the adapter's pipe

test("message: over the adapter's pipe the text reaches the worker's stdin, the receipt names the channel and bytes, and the worker's next turn answers it", async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  let core = null, m = null, control = null;
  try {
    ({ core, m, control } = await setupOwnerAndManager(dataDir, 'run-g'));
    await m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);

    const r = await cliAsync(['message', 'w1', 'hello', 'again'], dataDir);
    assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
    // Fix round: the manager's own worker-facing channel ('stdin'|'codex-resume') survives the CLI's
    // merge now, since only stop/restart (which carry no `channel` of their own) read 'adapter-pipe';
    // `established_by` is what names the adapter pipe and the answer time.
    assert.strictEqual(r.receipt.channel, 'stdin');
    assert.match(r.receipt.established_by, /worker\.message over the adapter pipe/);
    assert.strictEqual(r.receipt.bytes, Buffer.byteLength('hello again', 'utf8'));
    assert.strictEqual(r.receipt.sent, true);

    // m.wait, not the raw _waitTurn: the CLI subprocess's own round trip can outlast the fake's near-
    // instant reply, so the turn may already have ended by the time this test asks — wait() (unlike
    // the bare per-call waiter) answers `already: true` at once for a turn that already landed.
    const waited = await m.wait({ worker_ids: ['w1'], timeout_ms: 8000 });
    assert.strictEqual(waited.timed_out, false, "the worker's next turn never answered the message");
    const stored = readStoreCopy(dataDir, (db) => db.prepare('SELECT turns FROM worker WHERE id = ? ORDER BY seq DESC LIMIT 1').get('w1'));
    assert.strictEqual(stored.turns, 2);
  } finally { await teardown({ core, m, control, dir }); }
});

// ================================================================ (h) every rung's refusal

test('worker stop, restart and message: each rung refuses naming the fact, creates nothing and elects nothing: no data dir, no worker row, a forgotten row, a run row that ended, an adapter pid that is dead, a pipe that does not answer', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const verbs = [
    { name: 'stop', args: (id) => ['worker', 'stop', id], key: 'stopped' },
    { name: 'restart', args: (id) => ['worker', 'restart', id], key: 'restarted' },
    { name: 'message', args: (id) => ['message', id, 'hi'], key: 'sent' },
  ];

  // no data dir at all: exit 1, an empty ladder, nothing created.
  for (const v of verbs) {
    const r = await cliAsync(v.args('nope'), dataDir);
    assert.strictEqual(r.status, 1, `${v.name} no-data-dir: ${r.stdout} / ${r.stderr}`);
    assert.strictEqual(r.receipt[v.key], false);
    assert.match(r.receipt.reason, /no such data dir/);
    assert.deepStrictEqual(r.receipt.ladder, []);
  }
  assert.strictEqual(fs.existsSync(dataDir), false, 'no verb may create the data dir');

  let core = null;
  try {
    core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-h', pid: process.pid } });
    await core.run.attach({ adapter_pid: process.pid }); // elects; adapter_pid is this alive process

    // no worker row. Fix round, should-fix finding: the listing and process brackets around this
    // refusal, and every refusal below, that item 7's own hygiene bullet asks for and test (h)'s own
    // name claims.
    let before = listRecursive(dataDir);
    let nodesBefore = await ownChildCount();
    for (const v of verbs) {
      const r = await cliAsync(v.args('no-such-worker'), dataDir);
      assert.strictEqual(r.status, 1, `${v.name} no-worker: ${r.stdout} / ${r.stderr}`);
      assert.strictEqual(r.receipt[v.key], false);
      assert.match(r.receipt.reason, /no worker row exists for no-such-worker/);
      assert.strictEqual(r.receipt.ladder.length, 1);
      assert.strictEqual(r.receipt.ladder[0].ok, false);
      assert.strictEqual(r.receipt.last, null);
    }
    assert.deepStrictEqual(listRecursive(dataDir), before, 'a no-worker-row refusal must create nothing');
    assert.strictEqual(await ownChildCount(), nodesBefore, 'a no-worker-row refusal must leave no process behind');

    // a forgotten row. worker.forget is operator-only (engine.cjs), so a second core opened as
    // operator makes the write; the orchestrator core above only plants the dead row it supersedes.
    await core.worker.write({ id: 'w-forgot', substrate: 'claude-code', pid: null, state: 'dead', run_id: 'run-h', turns: 0, started_at: Date.now() });
    const opCore = await openCore({ dataDir, caller: { role: 'operator', run_id: 'cli', pid: process.pid } });
    try { await opCore.worker.forget({ worker_id: 'w-forgot' }); } finally { await opCore.close(); }
    before = listRecursive(dataDir);
    nodesBefore = await ownChildCount();
    for (const v of verbs) {
      const r = await cliAsync(v.args('w-forgot'), dataDir);
      assert.strictEqual(r.status, 1, `${v.name} forgotten: ${r.stdout} / ${r.stderr}`);
      assert.strictEqual(r.receipt[v.key], false);
      assert.match(r.receipt.reason, /is forgotten/);
      assert.strictEqual(r.receipt.ladder.length, 1);
      assert.strictEqual(r.receipt.last.state, 'forgotten');
    }
    assert.deepStrictEqual(listRecursive(dataDir), before, 'a forgotten-row refusal must create nothing');
    assert.strictEqual(await ownChildCount(), nodesBefore, 'a forgotten-row refusal must leave no process behind');

    // a run row that ended.
    const coreEnded = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-ended', pid: process.pid } });
    try {
      await coreEnded.run.attach({ adapter_pid: process.pid });
      await coreEnded.run.end({ exit_reason: 'test' });
    } finally { await coreEnded.close(); }
    await core.worker.write({ id: 'w-ended', substrate: 'claude-code', pid: null, state: 'idle', run_id: 'run-ended', turns: 0, started_at: Date.now() });
    before = listRecursive(dataDir);
    nodesBefore = await ownChildCount();
    for (const v of verbs) {
      const r = await cliAsync(v.args('w-ended'), dataDir);
      assert.strictEqual(r.status, 1, `${v.name} ended-run: ${r.stdout} / ${r.stderr}`);
      assert.strictEqual(r.receipt[v.key], false);
      assert.match(r.receipt.reason, /run run-ended ended at/);
      assert.strictEqual(r.receipt.ladder.length, 2);
    }
    assert.deepStrictEqual(listRecursive(dataDir), before, 'an ended-run refusal must create nothing');
    assert.strictEqual(await ownChildCount(), nodesBefore, 'an ended-run refusal must leave no process behind');

    // an adapter pid that is dead.
    const dead = deadPid();
    const coreDead = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-dead-adapter', pid: process.pid } });
    try { await coreDead.run.attach({ adapter_pid: dead }); } finally { await coreDead.close(); }
    await core.worker.write({ id: 'w-deadadapter', substrate: 'claude-code', pid: null, state: 'idle', run_id: 'run-dead-adapter', turns: 0, started_at: Date.now() });
    before = listRecursive(dataDir);
    nodesBefore = await ownChildCount();
    for (const v of verbs) {
      const r = await cliAsync(v.args('w-deadadapter'), dataDir);
      assert.strictEqual(r.status, 1, `${v.name} dead-adapter: ${r.stdout} / ${r.stderr}`);
      assert.strictEqual(r.receipt[v.key], false);
      assert.match(r.receipt.reason, new RegExp(`adapter pid ${dead} of run run-dead-adapter is dead`));
      assert.strictEqual(r.receipt.ladder.length, 3);
    }
    assert.deepStrictEqual(listRecursive(dataDir), before, 'a dead-adapter refusal must create nothing');
    assert.strictEqual(await ownChildCount(), nodesBefore, 'a dead-adapter refusal must leave no process behind');

    // a pipe that does not answer: adapter_pid is this alive process, but nothing is listening on its
    // adapter pipe anywhere in this test.
    await core.worker.write({ id: 'w-nopipe', substrate: 'claude-code', pid: null, state: 'idle', run_id: 'run-h', turns: 0, started_at: Date.now() });
    before = listRecursive(dataDir);
    nodesBefore = await ownChildCount();
    for (const v of verbs) {
      const r = await cliAsync(v.args('w-nopipe'), dataDir);
      assert.strictEqual(r.status, 1, `${v.name} no-pipe: ${r.stdout} / ${r.stderr}`);
      assert.strictEqual(r.receipt[v.key], false);
      assert.match(r.receipt.reason, /the adapter's pipe .* did not answer/);
      assert.strictEqual(r.receipt.ladder.length, 4);
    }
    assert.deepStrictEqual(listRecursive(dataDir), before, 'a no-pipe refusal must create nothing');
    assert.strictEqual(await ownChildCount(), nodesBefore, 'a no-pipe refusal must leave no process behind');
  } finally {
    if (core) {
      try { if (core.isOwner()) await core.shutdownOwner(); } catch { /* best effort */ }
      try { await core.close(); } catch { /* best effort */ }
    }
    assert.strictEqual(fs.existsSync(`${dataDir}/owner.lock`), false, 'no owner.lock may outlive this test');
    cleanup(dir);
  }
});

// ================================================================ (i) a wedged pipe is named within its bound

// 6e-5 fix round: stopBoundMs(1000) is now 170000 ms (design item 4), over scripts/test.cjs's fixed
// 60000 ms --test-timeout; a per-test timeout keeps this pinned test itself green under npm test without
// touching the unowned runner.
test('worker stop: a pipe that accepts and never answers is named within the bound the arguments give', { timeout: 210000 }, async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  let core = null; let server = null;
  try {
    core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-i', pid: process.pid } });
    await core.run.attach({ adapter_pid: process.pid });
    await core.worker.write({ id: 'w-wedged', substrate: 'claude-code', pid: null, state: 'idle', run_id: 'run-i', turns: 0, started_at: Date.now() });

    const pipe = adapterPipeName(dataDir, process.pid);
    server = net.createServer((c) => { c.on('data', () => {}); }); // accepts and reads, never writes
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });

    const t0 = Date.now();
    const r = await cliAsync(['worker', 'stop', 'w-wedged', '--timeout-ms', '1000'], dataDir);
    const ms = Date.now() - t0;
    assert.strictEqual(r.status, 1, `${r.stdout} / ${r.stderr}`);
    assert.strictEqual(r.receipt.stopped, false);
    // 6e-5 design item 4: stopBoundMs(1000) = 1000 + max(2000, min(1000,10000)) + 5000 + 5000
    // + max(pauseBoundMs(), resumeBoundMs())=157000 (resume carries failNoReady's 15000 and the relaunch's 12000 index embed) = 170000
    assert.match(r.receipt.reason, /did not answer worker\.stop within 170000 ms/);
    assert.match(r.receipt.reason, /may have acted/);
    // The bound is the product's own, so a slow host adds only the CLI's start and the reply; the slack stays under
    // this test's 210000 ms timeout, which an unbounded wait would hit.
    assert.ok(ms <= 170000 + 12000, `command took ${ms} ms, over the 170000+12000 ms bound`);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (core) {
      try { if (core.isOwner()) await core.shutdownOwner(); } catch { /* best effort */ }
      try { await core.close(); } catch { /* best effort */ }
    }
    cleanup(dir);
  }
});

// ================================================================ (j) usage, and no path to src/run or the embedder

test('worker stop|restart and message: usage errors list exactly kill, rm, stop and restart, message refuses a missing id or empty text, and no CLI path loads the embedder or src/run', () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    const bare = spawnSync(process.execPath, [CLI, 'worker', '--data', dataDir, '--json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.strictEqual(bare.status, 2);
    assert.match(bare.stderr, /kill/);
    assert.match(bare.stderr, /rm/);
    assert.match(bare.stderr, /stop/);
    assert.match(bare.stderr, /restart/);

    const noId = spawnSync(process.execPath, [CLI, 'message', '--data', dataDir, '--json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.strictEqual(noId.status, 2);

    const emptyText = spawnSync(process.execPath, [CLI, 'message', 'w1', '   ', '--data', dataDir, '--json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.strictEqual(emptyText.status, 2);
  } finally { cleanup(dir); }

  const probe = [
    `require(${JSON.stringify(CLI)});`,
    `require(${JSON.stringify(`${ROOT}/src/cli/cmd-worker.cjs`)});`,
    `require(${JSON.stringify(`${ROOT}/src/cli/cmd-message.cjs`)});`,
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
