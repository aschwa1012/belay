'use strict';
// pause.test.cjs — build step 6e-4, ADR 0023 amendment 2,
// the pattern of tests/cli/worker-control.test.cjs: this process elects the owner as role orchestrator,
// run.attach with its own pid as adapter_pid, createRunManager over the fake, createWorkerControl over it.
// Every CLI invocation uses `spawn`, never `spawnSync`, so this process's own event loop can serve both
// pipes.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { sandbox, cleanup, listRecursive, readStoreCopy } = require('./stop-helpers.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { createRunManager, createWorkerControl } = require('../../src/run/index.cjs');
const P = require('../../src/run/process.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const FAKE_WITH_CHILD = `${ROOT}/tests/run/fakes/fake-claude-with-child.cjs`;
const FAKE_CODEX = `${ROOT}/tests/run/fakes/fake-codex.cjs`;
const USER_SETTINGS = `${ROOT}/tests/run/fixtures/user-settings.json`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Never spawnSync here — this process is itself the owner and the worker adapter, and spawnSync would
// block the very event loop the CLI subprocess is dialling into. This is cliAsync without --json.
function cliTextAsync(args, dataDir) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args, '--data', dataDir], { cwd: ROOT, windowsHide: true });
    let stdout = ''; proc.stdout.on('data', (d) => { stdout += d; });
    let stderr = ''; proc.stderr.on('data', (d) => { stderr += d; });
    proc.once('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

// A snapshot's PowerShell is one of this process's children, so the count waits for the gate to be idle first (ADR 0048).
const { ownChildCount } = require('../helpers/own-children.cjs'); // children created at or after this process (a reused pid's orphans are not its own)

function workerWorktree(dir, id) {
  const wt = `${dir}/${id}-wt`;
  fs.mkdirSync(wt, { recursive: true });
  return wt;
}

async function setupOwnerAndManager(dataDir, runId, exe = FAKE_CLAUDE) {
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
  await core.run.attach({ adapter_pid: process.pid });
  const m = createRunManager({ core, dataDir, runId, paths: { claudeExe: exe, codexExe: FAKE_CODEX, userSettings: USER_SETTINGS } });
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

// ================================================================ (c1) pause over the adapter's pipe

test('pause: over the adapter pipe a mid-turn worker is parked, the receipt is the manager\'s own with the ladder, and exit is 0', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  let core = null, m = null, control = null;
  process.env.FAKE_ANSWER_DELAY_MS = '4000';
  try {
    ({ core, m, control } = await setupOwnerAndManager(dataDir, 'run-c1'));
    await m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' });
    await sleep(200);

    const r = await cliAsync(['pause', 'w1'], dataDir);
    assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
    assert.strictEqual(r.receipt.paused, true);
    assert.strictEqual(r.receipt.interrupted, true);
    assert.strictEqual(r.receipt.interrupt.response_subtype, 'success');
    assert.strictEqual(r.receipt.channel, 'adapter-pipe');
    assert.strictEqual(r.receipt.adapter_pid, process.pid);
    assert.strictEqual(r.receipt.ladder.length, 5, JSON.stringify(r.receipt.ladder));
    assert.ok(r.receipt.ladder.every((rung) => rung.ok === true), JSON.stringify(r.receipt.ladder));

    const stored = readStoreCopy(dataDir, (db) => db.prepare('SELECT * FROM worker WHERE id = ? ORDER BY seq DESC LIMIT 1').get('w1'));
    assert.strictEqual(stored.state, 'paused');
    assert.match(stored.paused_by, /^operator:\d+$/, 'paused_by must come from the CLI\'s own caller identity');
  } finally {
    delete process.env.FAKE_ANSWER_DELAY_MS;
    await teardown({ core, m, control, dir });
  }
});

// ================================================================ (c2) message/restart refused, stop not

test('message and worker restart against a paused worker exit 1 naming E_PAUSED, and worker stop exits 0', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  let core = null, m = null, control = null;
  try {
    ({ core, m, control } = await setupOwnerAndManager(dataDir, 'run-c2'));
    await m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    const paused = await cliAsync(['pause', 'w1'], dataDir);
    assert.strictEqual(paused.status, 0, `${paused.stdout} / ${paused.stderr}`);

    const msg = await cliAsync(['message', 'w1', 'hi'], dataDir);
    assert.strictEqual(msg.status, 1, `${msg.stdout} / ${msg.stderr}`);
    assert.strictEqual(msg.receipt.error.code, 'E_PAUSED');

    const restart = await cliAsync(['worker', 'restart', 'w1'], dataDir);
    assert.strictEqual(restart.status, 1, `${restart.stdout} / ${restart.stderr}`);
    assert.strictEqual(restart.receipt.error.code, 'E_PAUSED');

    const stop = await cliAsync(['worker', 'stop', 'w1'], dataDir);
    assert.strictEqual(stop.status, 0, `${stop.stdout} / ${stop.stderr}`);
    assert.strictEqual(stop.receipt.stopped, true);
    // Fix round, blocking finding: a stop of a parked worker used to leave the row 'paused' forever
    // (api.md §5's own "never reads back paused" promise), which a later resume could still relaunch.
    const rowAfterStop = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(rowAfterStop.state, 'stopped', 'a stopped parked worker\'s row must read stopped, never paused');
  } finally { await teardown({ core, m, control, dir }); }
});

// ================================================================ (c3) resume over the pipe

test('resume: over the pipe the parked worker is relaunched on its session, the receipt carries the new pid and the text sent, and --message appends the operator\'s text', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  let core = null, m = null, control = null;
  process.env.FAKE_ANSWER_DELAY_MS = '4000';
  try {
    ({ core, m, control } = await setupOwnerAndManager(dataDir, 'run-c3'));
    await core.task.create({ id: 't-c3', spec: 'the task the resumed worker is bound to' });
    await m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1', task_id: 't-c3' });
    await sleep(200);
    const paused = await m.pause({ worker_id: 'w1', by: 'operator:1' });
    assert.strictEqual(paused.interrupted, true);
    const oldPid = paused.row.pid;
    delete process.env.FAKE_ANSWER_DELAY_MS;
    const r = await cliAsync(['resume', 'w1', '--message', 'and also do X'], dataDir);
    assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
    assert.strictEqual(r.receipt.resumed, true);
    assert.notStrictEqual(r.receipt.new_pid, oldPid);
    assert.strictEqual(r.receipt.session_id, paused.session_id);
    assert.ok(r.receipt.text_bytes > Buffer.byteLength('and also do X', 'utf8'), 'the operator\'s text must be appended, not sent alone');
    const waited = await m.wait({ worker_ids: ['w1'], timeout_ms: 8000 });
    assert.strictEqual(waited.timed_out, false, 'the resumed worker never took another turn');
    assert.match(m._worker('w1').lastAssistantText, /paused you a moment ago/);
    assert.match(m._worker('w1').lastAssistantText, /and also do X/);
  } finally {
    delete process.env.FAKE_ANSWER_DELAY_MS;
    await teardown({ core, m, control, dir });
  }
});

// ================================================================ (c4) take-control pauses the holder

test('take-control: the worker holding the superseded lease is parked over its adapter\'s pipe and paused_worker is that receipt', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  let core = null, m = null, control = null;
  try {
    ({ core, m, control } = await setupOwnerAndManager(dataDir, 'run-c4'));
    await m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    const t = await core.task.create({ spec: 'held by w1, then taken by the operator' });
    await core.task.assign({ task_id: t.id, worker_id: 'w1' });

    const r = await cliAsync(['take-control', t.id], dataDir);
    assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
    assert.strictEqual(r.receipt.taken, true);
    assert.strictEqual(r.receipt.paused_worker.paused, true);
    assert.strictEqual(r.receipt.paused_worker.worker_id, 'w1');
    assert.strictEqual(r.receipt.paused_worker.channel, 'adapter-pipe');

    const stored = readStoreCopy(dataDir, (db) => db.prepare('SELECT * FROM worker WHERE id = ? ORDER BY seq DESC LIMIT 1').get('w1'));
    assert.strictEqual(stored.state, 'paused');
  } finally { await teardown({ core, m, control, dir }); }
});

// ================================================================ (c5) take-control, the holder cannot be paused

test('take-control: when the holder cannot be paused the lease still moves, paused_worker names the failed rung, and exit is 1', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  let core = null, m = null, control = null;
  process.env.FAKE_CODEX_TURN_MS = '10000'; // stays 'running' with a live pid long enough to assign it
  try {
    ({ core, m, control } = await setupOwnerAndManager(dataDir, 'run-c5', FAKE_CODEX));
    await m.spawn({ substrate: 'codex', worktree: workerWorktree(dir, 'w-codex'), prompt: 'hello', worker_id: 'w-codex' });
    const t = await core.task.create({ spec: 'held by a Codex worker, whose pause is docked' });
    await core.task.assign({ task_id: t.id, worker_id: 'w-codex' });

    const r = await cliAsync(['take-control', t.id], dataDir);
    assert.strictEqual(r.status, 1, `${r.stdout} / ${r.stderr}`);
    assert.strictEqual(r.receipt.taken, true, 'the lease moves even though the worker could not be paused');
    assert.strictEqual(r.receipt.paused_worker.paused, false);
    assert.match(r.receipt.paused_worker.reason, /docked for Codex/);

    const after = await core.task.get({ task_id: t.id });
    assert.strictEqual(after.lease.holder_role, 'operator');
  } finally {
    delete process.env.FAKE_CODEX_TURN_MS;
    await teardown({ core, m, control, dir });
  }
});

// ================================================================ (c6) refusals, usage, no src/run or embedder

test('pause and resume: each rung refuses naming the fact, creates nothing and elects nothing, the usage errors exit 2, and no CLI path loads the embedder or src/run', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const verbs = [
    { name: 'pause', args: (id) => ['pause', id], key: 'paused' },
    { name: 'resume', args: (id) => ['resume', id], key: 'resumed' },
  ];
  // no data dir at all.
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
    core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-c6', pid: process.pid } });
    await core.run.attach({ adapter_pid: process.pid });
    let before = listRecursive(dataDir);
    let nodesBefore = await ownChildCount();
    for (const v of verbs) {
      const r = await cliAsync(v.args('no-such-worker'), dataDir);
      assert.strictEqual(r.status, 1, `${v.name} no-worker: ${r.stdout} / ${r.stderr}`);
      assert.strictEqual(r.receipt[v.key], false);
      assert.match(r.receipt.reason, /no worker row exists for no-such-worker/);
      assert.strictEqual(r.receipt.ladder.length, 1);
    }
    assert.deepStrictEqual(listRecursive(dataDir), before, 'a no-worker-row refusal must create nothing');
    assert.strictEqual(await ownChildCount(), nodesBefore);

    await core.worker.write({ id: 'w-forgot', substrate: 'claude-code', pid: null, state: 'dead', run_id: 'run-c6', turns: 0, started_at: Date.now() });
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
    }
    assert.deepStrictEqual(listRecursive(dataDir), before, 'a forgotten-row refusal must create nothing');
    assert.strictEqual(await ownChildCount(), nodesBefore);

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
    assert.strictEqual(await ownChildCount(), nodesBefore);
  } finally {
    if (core) {
      try { if (core.isOwner()) await core.shutdownOwner(); } catch { /* best effort */ }
      try { await core.close(); } catch { /* best effort */ }
    }
    assert.strictEqual(fs.existsSync(`${dataDir}/owner.lock`), false, 'no owner.lock may outlive this test');
    cleanup(dir);
  }
  {
    const dir2 = sandbox();
    const dataDir2 = `${dir2}/.belay`;
    let core2 = null, m2 = null, control2 = null;
    try {
      ({ core: core2, m: m2, control: control2 } = await setupOwnerAndManager(dataDir2, 'run-c6-2', FAKE_CODEX));
      await m2.spawn({ substrate: 'codex', worktree: workerWorktree(dir2, 'w-codex'), prompt: 'hello', worker_id: 'w-codex' });
      await m2._waitTurn('w-codex', 8000);
      const r = await cliAsync(['pause', 'w-codex'], dataDir2);
      assert.strictEqual(r.status, 1, `${r.stdout} / ${r.stderr}`);
      assert.strictEqual(r.receipt.paused, false);
      assert.match(r.receipt.reason, /docked for Codex/);
      assert.strictEqual(r.receipt.ladder.length, 5);
      assert.strictEqual(r.receipt.ladder[4].ok, false);
    } finally { await teardown({ core: core2, m: m2, control: control2, dir: dir2 }); }
  }
  const dir3 = sandbox();
  const dataDir3 = `${dir3}/.belay`;
  try {
    for (const args of [['pause'], ['pause', 'a', 'b'], ['pause', 'a', '--message', 'x'], ['resume', 'a', '--message']]) {
      const r = spawnSync(process.execPath, [CLI, ...args, '--data', dataDir3, '--json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
      assert.strictEqual(r.status, 2, `${args.join(' ')}: ${r.stdout} / ${r.stderr}`);
    }
  } finally { cleanup(dir3); }
  const probe = [
    `require(${JSON.stringify(CLI)});`,
    `require(${JSON.stringify(`${ROOT}/src/cli/cmd-pause.cjs`)});`,
    "const embedder = Object.keys(require.cache).filter(k => /src[\\\\/]core[\\\\/]embedder\\.cjs$/i.test(k));",
    "const run = Object.keys(require.cache).filter(k => /[\\\\/]src[\\\\/]run[\\\\/]/i.test(k));",
    'process.stdout.write(JSON.stringify({ embedder, run }));',
  ].join('\n');
  const rProbe = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(rProbe.status, 0, `probe failed: ${rProbe.stderr}`);
  const hit = JSON.parse(rProbe.stdout);
  assert.deepStrictEqual(hit.embedder, [], 'requiring cmd-pause.cjs reached the embedder');
  assert.deepStrictEqual(hit.run, [], 'requiring cmd-pause.cjs reached src/run');
});

// ================================================================ (c7) E_BUSY from the adapter

test('pause: E_BUSY from the adapter exits 1 naming the operation in flight', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  let core = null, m = null, control = null;
  try {
    ({ core, m, control } = await setupOwnerAndManager(dataDir, 'run-c7', FAKE_WITH_CHILD));
    await m.spawn({ substrate: 'claude-code', worktree: workerWorktree(dir, 'w1'), prompt: 'hello', worker_id: 'w1' });
    // fake-claude-with-child.cjs never answers a control_request and never exits on stdin close, so this
    // pause's own bound (interrupt + the graceful-then-kill exit) holds the operation slot for a while.
    const busyP = m.pause({ worker_id: 'w1', by: 'operator:1', interrupt_timeout_ms: 800, exit_timeout_ms: 1200 });
    await sleep(150);
    const r = await cliAsync(['resume', 'w1'], dataDir);
    assert.strictEqual(r.status, 1, `${r.stdout} / ${r.stderr}`);
    assert.strictEqual(r.receipt.resumed, false);
    assert.strictEqual(r.receipt.error.code, 'E_BUSY');
    assert.strictEqual(r.receipt.error.detail.op, 'pause');
    assert.match(r.receipt.reason, /busy with pause/);
    await busyP;
  } finally { await teardown({ core, m, control, dir }); }
});
