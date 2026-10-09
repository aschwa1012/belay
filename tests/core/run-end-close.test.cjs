'use strict';
// run-end-close.test.cjs — ADR 0029 decisions 1 and 2: run.end closes the ending epoch's worker rows that
// claim a life over a dead pid, and run.attach's suspect set gains `stopping`. Every store lives under the
// OS temp dir; every worktree is a temp directory, a real git repo or not.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { core, sandbox, cleanup, callerFor, deadPid, sleep } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const { pidAlive } = core('lock.cjs');

const fwd = (p) => String(p).replace(/\\/g, '/');
const SHA_RE = /^[0-9a-f]{40,64}$/;

function makeRepo() {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-close-repo-')));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(git('init', '-q').status, 0, 'git init');
  assert.strictEqual(git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--allow-empty', '-q', '-m', 'x').status, 0, 'git commit');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  assert.match(head, SHA_RE);
  return { dir, head };
}

function makePlainDir() { return fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-close-plain-'))); }

async function setup() {
  const dir = sandbox();
  const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  return { dir, orch };
}

async function teardown(ctx, extraDirs = []) {
  await ctx.orch.shutdownOwner();
  await ctx.orch.close();
  cleanup(ctx.dir);
  for (const d of extraDirs) cleanup(d);
}

// A live child whose row can be written `running` and which is then killed by its exact pid.
async function deadRunningPid() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
  const pid = child.pid;
  return { pid, kill: async () => { child.kill('SIGKILL'); for (let i = 0; i < 100 && pidAlive(pid); i += 1) await sleep(25); assert.ok(!pidAlive(pid)); } };
}

test('run.end marks a dead-pid worker row in each of starting, running, idle and stopping, with the exact fields', async () => {
  const ctx = await setup();
  const repo = makeRepo();
  const plain = makePlainDir();
  try {
    const { orch } = ctx;
    const dead = deadPid();
    const started = Date.now() - 5000;
    const rc = await deadRunningPid();
    await orch.worker.write({ id: 'w-starting', substrate: 'claude-code', pid: dead, state: 'starting', worktree: repo.dir, started_at: started });
    await orch.worker.write({ id: 'w-running', substrate: 'claude-code', pid: rc.pid, state: 'running', worktree: repo.dir, started_at: started });
    await orch.worker.write({ id: 'w-idle', substrate: 'claude-code', pid: dead, state: 'idle', worktree: repo.dir, started_at: started, exited_at: 4242 });
    await orch.worker.write({ id: 'w-stopping', substrate: 'claude-code', pid: dead, state: 'stopping', worktree: plain, started_at: started });
    await rc.kill();
    const before = {};
    for (const id of ['w-starting', 'w-running', 'w-idle', 'w-stopping']) before[id] = (await orch.worker.get({ worker_id: id }));

    const t0 = Date.now();
    const ended = await orch.run.end({ exit_reason: 'test end' });
    assert.ok(ended.ended_at >= t0 - 1, 'the run row keeps its fields');
    assert.strictEqual(ended.exit_reason, 'test end');
    assert.strictEqual(ended.workers_marked_dead.length, 4);
    const byId = Object.fromEntries(ended.workers_marked_dead.map((m) => [m.worker_id, m]));
    assert.strictEqual(byId['w-starting'].from_state, 'starting');
    assert.strictEqual(byId['w-running'].from_state, 'running');
    assert.strictEqual(byId['w-idle'].from_state, 'idle');
    assert.strictEqual(byId['w-stopping'].from_state, 'stopping');
    for (const id of ['w-starting', 'w-running', 'w-idle']) assert.strictEqual(byId[id].head_sha, repo.head, `${id} head in the result`);
    assert.strictEqual(byId['w-stopping'].head_sha, null);
    assert.ok(byId['w-stopping'].head_error && byId['w-stopping'].head_error.length > 10, 'a non-repo worktree reports why head_sha is null');
    assert.ok(!('head_error' in byId['w-starting']));

    for (const id of ['w-starting', 'w-running', 'w-idle', 'w-stopping']) {
      const w = await orch.worker.get({ worker_id: id });
      const b = before[id];
      assert.strictEqual(w.state, 'dead', id);
      assert.ok(w.seq > b.seq, `${id} got one appended row`);
      assert.strictEqual(w.death_established_by, `run.end: pid ${b.pid} not alive when the run ended; no adapter wrote its exit (ADR 0029)`);
      assert.strictEqual(w.exited_at, b.exited_at == null ? w.exited_at : b.exited_at, `${id} exited_at kept when present`);
      assert.ok(Number.isInteger(w.exited_at) && (b.exited_at != null || w.exited_at >= t0 - 1000), `${id} exited_at is set`);
      assert.strictEqual(w.exit_code, b.exit_code, `${id} exit_code untouched`);
      assert.strictEqual(w.exit_signal, b.exit_signal, `${id} exit_signal untouched`);
      assert.strictEqual(w.paused_at, null);
      assert.strictEqual(w.paused_by, null);
      assert.strictEqual(w.head_sha, id === 'w-stopping' ? null : repo.head, `${id} head_sha on the row`);
    }
    assert.strictEqual((await orch.worker.get({ worker_id: 'w-idle' })).exited_at, 4242, 'a row that already had exited_at keeps it');
  } finally { await teardown(ctx, [repo.dir, plain]); }
});

test('run.end leaves a live-pid row, a paused row and stopped, dead rows untouched', async () => {
  const ctx = await setup();
  try {
    const { orch } = ctx;
    const dead = deadPid();
    const t = Date.now();
    await orch.worker.write({ id: 'w-live', substrate: 'claude-code', pid: process.pid, state: 'running', started_at: t });
    await orch.worker.write({ id: 'w-paused', substrate: 'claude-code', pid: dead, state: 'paused', paused_at: t, paused_by: 'operator:1', started_at: t });
    await orch.worker.write({ id: 'w-stopped', substrate: 'claude-code', pid: dead, state: 'stopped', exited_at: t, started_at: t });
    await orch.worker.write({ id: 'w-dead', substrate: 'claude-code', pid: dead, state: 'dead', exited_at: t, started_at: t });
    const ids = ['w-live', 'w-paused', 'w-stopped', 'w-dead'];
    const before = {};
    for (const id of ids) before[id] = await orch.worker.get({ worker_id: id });
    const ended = await orch.run.end({ exit_reason: 'test end' });
    assert.deepStrictEqual(ended.workers_marked_dead, []);
    for (const id of ids) {
      const w = await orch.worker.get({ worker_id: id });
      assert.strictEqual(w.seq, before[id].seq, `${id} was not written`);
      assert.strictEqual(w.state, before[id].state);
    }
  } finally { await teardown(ctx); }
});

test('run.end closes only its own run: another run id\'s row is left alone', async () => {
  const ctx = await setup();
  try {
    const { orch } = ctx;
    const dead = deadPid();
    await orch.worker.write({ id: 'w-other', run_id: 'some-other-run', substrate: 'claude-code', pid: dead, state: 'stopping', started_at: Date.now() });
    const ended = await orch.run.end({ exit_reason: 'test end' });
    assert.deepStrictEqual(ended.workers_marked_dead, []);
    assert.strictEqual((await orch.worker.get({ worker_id: 'w-other' })).state, 'stopping');
  } finally { await teardown(ctx); }
});

test('run.attach on a new epoch now marks a previous epoch\'s stopping row dead', async () => {
  const ctx = await setup();
  try {
    const { orch } = ctx;
    await orch.worker.write({ id: 'w-stop', substrate: 'claude-code', pid: deadPid(), state: 'stopping', started_at: Date.now() });
    const r = await orch.run.attach({ adapter_pid: process.pid });
    assert.strictEqual(r.reattached, true);
    assert.deepStrictEqual(r.workers_marked_dead, ['w-stop']);
    assert.strictEqual((await orch.worker.get({ worker_id: 'w-stop' })).state, 'dead');
  } finally { await teardown(ctx); }
});

test('run.end marks a Codex idle row dead whatever its pid says (amendment 1 item 1); a Claude Code idle row over a live pid is left alone', async () => {
  const ctx = await setup();
  const repo = makeRepo();
  const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    const { orch } = ctx;
    const t = Date.now();
    await orch.worker.write({ id: 'cx-live', substrate: 'codex', pid: live.pid, state: 'idle', worktree: repo.dir, started_at: t });
    await orch.worker.write({ id: 'cx-nopid', substrate: 'codex', pid: null, state: 'idle', worktree: repo.dir, started_at: t });
    await orch.worker.write({ id: 'cc-live-idle', substrate: 'claude-code', pid: live.pid, state: 'idle', worktree: repo.dir, started_at: t });
    const ccBefore = await orch.worker.get({ worker_id: 'cc-live-idle' });
    const ended = await orch.run.end({ exit_reason: 'test end' });
    const ids = ended.workers_marked_dead.map((m) => m.worker_id).sort();
    assert.deepStrictEqual(ids, ['cx-live', 'cx-nopid']);
    for (const id of ids) {
      const w = await orch.worker.get({ worker_id: id });
      assert.strictEqual(w.state, 'dead');
      assert.strictEqual(w.death_established_by, 'run.end: a Codex worker between turns has no process by design; its run ended (ADR 0029)');
      assert.strictEqual(w.head_sha, repo.head);
      assert.ok(Number.isInteger(w.exited_at));
    }
    assert.ok(pidAlive(live.pid), 'run.end never touches a process');
    assert.strictEqual((await orch.worker.get({ worker_id: 'cc-live-idle' })).seq, ccBefore.seq, 'a Claude Code row keeps the pid check');
  } finally { live.kill('SIGKILL'); await teardown(ctx, [repo.dir]); }
});

test('run.end reports the head_sha the row carries, and says so when the worktree is missing', async () => {
  const ctx = await setup();
  try {
    const { orch } = ctx;
    const missing = `${makePlainDir()}/gone`;
    await orch.worker.write({ id: 'w-old-head', substrate: 'claude-code', pid: deadPid(), state: 'stopping', worktree: missing, head_sha: 'a'.repeat(40), started_at: Date.now() });
    await orch.worker.write({ id: 'w-no-head', substrate: 'claude-code', pid: deadPid(), state: 'stopping', worktree: missing, started_at: Date.now() });
    const ended = await orch.run.end({ exit_reason: 'test end' });
    const by = Object.fromEntries(ended.workers_marked_dead.map((m) => [m.worker_id, m]));
    assert.strictEqual(by['w-old-head'].head_sha, 'a'.repeat(40), 'the entry says what the row carries, not null');
    assert.strictEqual((await orch.worker.get({ worker_id: 'w-old-head' })).head_sha, 'a'.repeat(40));
    assert.strictEqual(by['w-old-head'].head_error, `worktree ${missing} does not exist`);
    assert.strictEqual(by['w-no-head'].head_sha, null);
    assert.strictEqual(by['w-no-head'].head_error, `worktree ${missing} does not exist`);
    assert.strictEqual((await orch.worker.get({ worker_id: 'w-no-head' })).head_sha, null);
  } finally { await teardown(ctx); }
});

test('run.end fills a missing head on a stopped and a dead row, touching nothing else (amendment 2)', async () => {
  const ctx = await setup();
  const repo = makeRepo();
  try {
    const { orch } = ctx;
    const dead = deadPid();
    const t = Date.now() - 3000;
    await orch.worker.write({ id: 'w-stopped', substrate: 'claude-code', pid: dead, state: 'stopped', worktree: repo.dir, started_at: t, exited_at: t + 1, exit_code: 0, exit_signal: null, death_established_by: 'adapter exit' });
    await orch.worker.write({ id: 'w-dead', substrate: 'claude-code', pid: dead, state: 'dead', worktree: repo.dir, started_at: t, exited_at: t + 2, exit_code: 137, exit_signal: 'SIGKILL', death_established_by: 'pid check' });
    const before = {};
    for (const id of ['w-stopped', 'w-dead']) before[id] = await orch.worker.get({ worker_id: id });
    const ended = await orch.run.end({ exit_reason: 'test end' });
    assert.deepStrictEqual(ended.workers_marked_dead, []);
    const by = Object.fromEntries(ended.heads_filled.map((h) => [h.worker_id, h]));
    assert.deepStrictEqual(by['w-stopped'], { worker_id: 'w-stopped', state: 'stopped', head_sha: repo.head });
    assert.deepStrictEqual(by['w-dead'], { worker_id: 'w-dead', state: 'dead', head_sha: repo.head });
    for (const id of ['w-stopped', 'w-dead']) {
      const w = await orch.worker.get({ worker_id: id });
      const b = before[id];
      assert.ok(w.seq > b.seq, `${id} got an appended row`);
      assert.strictEqual(w.head_sha, repo.head);
      for (const k of ['state', 'exited_at', 'exit_code', 'exit_signal', 'death_established_by', 'paused_at', 'paused_by', 'pid', 'worktree', 'started_at']) {
        assert.strictEqual(w[k], b[k], `${id}.${k} untouched`);
      }
    }
  } finally { await teardown(ctx, [repo.dir]); }
});

test('run.end leaves a terminal row that has a head, another run\'s row and a non-terminal row alone for heads', async () => {
  const ctx = await setup();
  const repo = makeRepo();
  try {
    const { orch } = ctx;
    const dead = deadPid();
    const t = Date.now();
    await orch.worker.write({ id: 'w-has', substrate: 'claude-code', pid: dead, state: 'stopped', worktree: repo.dir, head_sha: 'b'.repeat(40), exited_at: t, started_at: t });
    await orch.worker.write({ id: 'w-other', run_id: 'some-other-run', substrate: 'claude-code', pid: dead, state: 'stopped', worktree: repo.dir, exited_at: t, started_at: t });
    await orch.worker.write({ id: 'w-paused', substrate: 'claude-code', pid: dead, state: 'paused', paused_at: t, paused_by: 'operator:1', worktree: repo.dir, started_at: t });
    const ids = ['w-has', 'w-other', 'w-paused'];
    const before = {};
    for (const id of ids) before[id] = await orch.worker.get({ worker_id: id });
    const ended = await orch.run.end({ exit_reason: 'test end' });
    assert.deepStrictEqual(ended.heads_filled, []);
    for (const id of ids) assert.strictEqual((await orch.worker.get({ worker_id: id })).seq, before[id].seq, `${id} was not written`);
  } finally { await teardown(ctx, [repo.dir]); }
});

test('run.end names head_error and appends nothing when a terminal row\'s worktree is not a repository', async () => {
  const ctx = await setup();
  const plain = makePlainDir();
  try {
    const { orch } = ctx;
    const t = Date.now();
    await orch.worker.write({ id: 'w-plain', substrate: 'claude-code', pid: deadPid(), state: 'stopped', worktree: plain, exited_at: t, started_at: t });
    const before = await orch.worker.get({ worker_id: 'w-plain' });
    const ended = await orch.run.end({ exit_reason: 'test end' });
    assert.strictEqual(ended.heads_filled.length, 1);
    const h = ended.heads_filled[0];
    assert.strictEqual(h.worker_id, 'w-plain');
    assert.strictEqual(h.state, 'stopped');
    assert.strictEqual(h.head_sha, null);
    assert.ok(h.head_error && h.head_error.length > 10);
    const w = await orch.worker.get({ worker_id: 'w-plain' });
    assert.strictEqual(w.seq, before.seq, 'nothing appended');
    assert.strictEqual(w.head_sha, null);
  } finally { await teardown(ctx, [plain]); }
});

test('a row run.end marks dead in the same call is named only in workers_marked_dead, once', async () => {
  const ctx = await setup();
  const repo = makeRepo();
  try {
    const { orch } = ctx;
    await orch.worker.write({ id: 'w-marked', substrate: 'claude-code', pid: deadPid(), state: 'stopping', worktree: repo.dir, started_at: Date.now() });
    const before = await orch.worker.get({ worker_id: 'w-marked' });
    const ended = await orch.run.end({ exit_reason: 'test end' });
    assert.deepStrictEqual(ended.workers_marked_dead.map((m) => m.worker_id), ['w-marked']);
    assert.deepStrictEqual(ended.heads_filled, []);
    const w = await orch.worker.get({ worker_id: 'w-marked' });
    assert.ok(w.seq > before.seq, 'one appended row'); assert.strictEqual((await orch.worker.list({ states: ['dead'] })).workers.filter((x) => x.id === 'w-marked').length, 1);
    assert.strictEqual(w.head_sha, repo.head);
  } finally { await teardown(ctx, [repo.dir]); }
});

// Build 12b (review S1): a row never carries both a head_sha and a head_error. The adapter writes head_error on
// a terminal row whose head lookup failed; when run.end later supplies the head (closeEpochWorkers on a dead-pid
// row, fillMissingHeads on a stopped one), the appended row clears it.
test('a head run.end supplies clears the head_error the row carried, on both paths', async () => {
  const ctx = await setup();
  const repo = makeRepo();
  try {
    const { orch } = ctx;
    const dead = deadPid();
    const t = Date.now() - 3000;
    const reason = 'git rev-parse HEAD timed out after 5000 ms';
    await orch.worker.write({ id: 'w-running', substrate: 'claude-code', pid: dead, state: 'starting', worktree: repo.dir, started_at: t, head_error: reason });
    await orch.worker.write({ id: 'w-stopped', substrate: 'claude-code', pid: dead, state: 'stopped', worktree: repo.dir, started_at: t, exited_at: t + 1, exit_code: 0, exit_signal: null, death_established_by: 'adapter exit', head_error: reason });
    for (const id of ['w-running', 'w-stopped']) assert.strictEqual((await orch.worker.get({ worker_id: id })).head_error, reason, `${id} starts with the error`);
    await orch.run.end({ exit_reason: 'test end' });
    for (const id of ['w-running', 'w-stopped']) {
      const w = await orch.worker.get({ worker_id: id });
      assert.strictEqual(w.head_sha, repo.head, `${id} got the head`);
      assert.strictEqual(w.head_error, null, `${id} no longer carries an error beside its head`);
    }
  } finally { await teardown(ctx, [repo.dir]); }
});
