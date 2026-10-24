'use strict';
require('../helpers/tmp.cjs');
// A worker record with no process by construction (a settled death, an adopted terminal row, a Codex worker between turns) is never
// read as alive because its pid number answers a signal-0 check: Windows reuses pid numbers, and ADR 0039 makes identity, not the
// number, the proof. A stop of such a worker writes nothing over its terminal row; an idle Codex worker takes its next turn; restart,
// list, a refused launch and a stage job's survivor check all leave a reused pid alone. The reused pid is stood in for by a sleeper this
// test spawns, ended by its own handle; on the own-adapter cases the record's pid is pointed at the sleeper after its process has gone.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createRunManager } = require('../../src/run/index.cjs');
const PI = require('../../src/run/pid-identity.cjs');
const SJ = require('../../src/run/stage-job.cjs');
const L = require('../../src/run/launch.cjs');
const { createFakeCore } = require('./fake-core.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const FAKE_CODEX = fwd(path.join(__dirname, 'fakes', 'fake-codex.cjs'));
const USER_SETTINGS = fwd(path.join(__dirname, 'fixtures', 'user-settings.json'));

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-reuse-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { root: d, data: fwd(d), worktree: fwd(path.join(d, 'wt')) };
}

function sleeper() {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  return new Promise((res) => c.once('spawn', () => res(c)));
}

// A sandbox, a fake core, a sleeper standing in for the process that reused the pid, and their cleanup.
async function setup(t, runId = 'run-new', extraPaths = {}) {
  const sb = sandbox();
  const core = createFakeCore();
  const other = await sleeper();
  const m = createRunManager({ core, dataDir: sb.data, runId, paths: { claudeExe: FAKE, userSettings: USER_SETTINGS, ...extraPaths } });
  t.after(async () => { await m.shutdown().catch(() => {}); try { other.kill(); } catch { /* gone */ } try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch { /* tmp */ } });
  return { sb, core, other, m };
}

async function plantDead(core, sb, id, pid, identity) {
  await core.worker.write({
    id, run_id: 'run-old', substrate: 'claude-code', pid, session_id: 's-old', adapter_pid: 1, state: 'dead',
    worktree: sb.worktree, task_id: null, started_at: Date.now() - 60000, exited_at: Date.now() - 30000,
    exit_code: 1, exit_signal: null, death_established_by: 'exit-event', turns: 1, ...identity,
  });
}

// A worker this manager spawned and stopped, whose pid number now names the sleeper.
async function stoppedThenReused(m, sb, other, id) {
  await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: id });
  await m._waitTurn(id, 20000);
  await m.stop({ worker_id: id, mode: 'kill', timeout_ms: 8000 });
  const w = m._worker(id);
  assert.equal(w.state, 'stopped');
  w.pid = other.pid;
  return w;
}

for (const [name, identity] of [
  ['a recorded creation time that does not match (mismatch)', { pid_created: 1000, pid_created_error: null, pid_image: 'node.exe' }],
  ['no recorded creation time (unverifiable)', { pid_created: null, pid_created_error: 'never read: the worker exited before its creation time was read (1 try)', pid_image: 'node.exe' }],
]) {
  test(`stop of a dead worker whose pid was reused, ${name}, leaves the dead row as it was`, async (t) => {
    const { sb, core, other, m } = await setup(t);
    const id = 'w-reuse-' + (identity.pid_created ? 'm' : 'u');
    await plantDead(core, sb, id, other.pid, identity);
    const r = await m.stop({ worker_id: id, mode: 'kill', timeout_ms: 2000 });
    const cur = core.currentWorker(id);
    assert.equal(other.exitCode, null, 'the unrelated process must not have been killed');
    assert.deepEqual(core.rowsFor(id).map((x) => x.state), ['dead'], 'nothing may be written over a terminal row for a process that died long ago');
    assert.equal(cur.state, 'dead');
    assert.equal(cur.run_id, 'run-old', 'a terminal row is never moved into the current run');
    assert.equal(r.killed, false);
    assert.ok(r.ms_to_exit >= 0, `ms_to_exit is never negative (got ${r.ms_to_exit})`);
    assert.equal(m.list().workers.find((x) => x.id === id).pid_alive, false, 'list never reads the reused pid as the worker');
  });
}

// An `idle` Codex worker has no process between turns by design, so its row's pid is free for reuse while it idles. An adopting
// adapter must not read the reused pid as "a live process this adapter did not spawn" and refuse every later turn.
test('a message to an adopted idle Codex worker whose pid was reused starts its next turn', async (t) => {
  const { sb, core, other, m } = await setup(t, 'run-new', { codexExe: FAKE_CODEX });
  await core.worker.write({
    id: 'w-codex', run_id: 'run-new', substrate: 'codex', pid: other.pid, session_id: 'thread-old', adapter_pid: 1, state: 'idle',
    worktree: sb.worktree, task_id: null, started_at: Date.now() - 60000, exited_at: Date.now() - 30000, exit_code: 0, exit_signal: null,
    turns: 1, pid_created: 1000, pid_created_error: null, pid_image: 'node.exe',
  });
  const got = await m.message({ worker_id: 'w-codex', text: 'next turn' }).then((x) => ({ ok: x.channel }), (e) => ({ err: e.code, message: e.message }));
  assert.equal(other.exitCode, null);
  assert.equal(got.ok, 'codex-resume', `the next turn must start; got ${JSON.stringify(got)}`);
});

test('restart of a stopped worker whose pid was reused kills nothing before the relaunch', async (t) => {
  const { sb, other, m } = await setup(t);
  const w = await stoppedThenReused(m, sb, other, 'w-rs');
  const r = await m.restart({ worker_id: 'w-rs', first_turn_timeout_ms: 20000 });
  assert.equal(w.adoptedKill, undefined, 'no kill may be attempted on the reused pid');
  assert.equal(r.old_pid, other.pid);
  assert.notEqual(r.new_pid, other.pid);
  assert.equal(other.exitCode, null);
});

test('a refused relaunch of a stopped worker whose pid was reused still settles dead', async (t) => {
  const { sb, core, other, m } = await setup(t);
  await stoppedThenReused(m, sb, other, 'w-nm');
  const settings = path.join(L.workerDir(sb.data, 'w-nm'), 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ ...JSON.parse(fs.readFileSync(settings, 'utf8')), autoDreamEnabled: true }));
  await assert.rejects(m.restart({ worker_id: 'w-nm', first_turn_timeout_ms: 20000 }), (e) => e.code === 'E_NATIVE_MEMORY_MISMATCH');
  assert.equal(core.currentWorker('w-nm').state, 'dead', 'the refusal writes its dead row: no process of this worker is alive');
  assert.equal(other.exitCode, null);
});

test('a stage job does not name a reused pid as its survivor', async (t) => {
  const other = await sleeper();
  t.after(() => { try { other.kill(); } catch { /* gone */ } });
  let stops = 0;
  const rec = { id: 'job-x', pid: other.pid, child: null, state: 'stopped', settledState: 'stopped', lastAssistantText: 'done', costUsd: 0 };
  const manager = {
    spawn: async () => ({}), wait: async () => ({ worker_id: 'job-x', event: 'turn_end', is_error: false }),
    stop: async () => { stops += 1; return {}; }, _worker: () => rec,
  };
  const sink = { pids: [], survivors: [] };
  const r = await SJ.runChild({ manager, workerId: 'job-x', worktree: '.', model: 'm', capUsd: 0.1, wallMs: 5000, prompt: 'p', label: 'test job', sink });
  assert.equal(r.survivor, null);
  assert.deepEqual(sink.survivors, []);
  assert.equal(stops, 1, 'a settled child is not killed again');
  assert.equal(other.exitCode, null);
});

test('verifiedLive: no process by construction, the handle, and the identity against one snapshot', async () => {
  const pid = process.pid; // a pid that answers signal 0
  const snapOf = (created) => async () => ({ snap: new Map([[pid, { ppid: null, created, image: 'node.exe' }]]) });
  const rec = (over) => ({ pid, child: null, state: 'running', settledState: null, pidCreated: 5000, pidCreatedError: null, pidImage: 'node.exe', substrate: 'claude-code', ...over });
  for (const state of ['dead', 'stopped', 'paused', 'idle']) {
    assert.equal(PI.noProcess(rec({ state })), true, state);
    assert.equal(PI.pidLive(rec({ state })), false, state);
    assert.equal(await PI.verifiedLive(rec({ state }), { snapshot: () => assert.fail('no snapshot for a record with no process') }), false, state);
  }
  assert.equal(PI.pidLive(rec({ settledState: 'dead' })), false, 'a death this adapter settled');
  assert.equal(PI.pidLive(rec({})), true, 'a running row whose pid answers');
  assert.equal(PI.noProcess(rec({ state: 'idle', child: { pid, exitCode: null, signalCode: null } })), false, 'a live handle is never overruled by the state word');
  assert.equal(await PI.verifiedLive(rec({}), { snapshot: snapOf(5000) }), true, 'the same creation time');
  assert.equal(await PI.verifiedLive(rec({}), { snapshot: snapOf(9999) }), false, 'another process holds the pid');
  assert.equal(await PI.verifiedLive(rec({}), { snapshot: async () => ({ snap: null }) }), true, 'an unreadable snapshot proves nothing');
  assert.equal(await PI.verifiedLive(rec({ pidCreated: null }), { snapshot: () => assert.fail('nothing to check against') }), true, 'no creation time proves nothing');
});

// An adopted row that still claims a process (`stopping`) and carries an old exited_at: the stop proves by identity that another
// process holds the pid, writes the terminal row, and reports ms_to_exit as 0, never a negative span from the old exit to this stop.
test('stop of an adopted stopping row whose pid was reused reports no negative ms_to_exit', async (t) => {
  const { sb, core, other, m } = await setup(t);
  await core.worker.write({
    id: 'w-neg', run_id: 'run-new', substrate: 'claude-code', pid: other.pid, session_id: 's-old', adapter_pid: 1, state: 'stopping',
    worktree: sb.worktree, task_id: null, started_at: Date.now() - 60000, exited_at: Date.now() - 30000, exit_code: null, exit_signal: null,
    turns: 1, pid_created: 1000, pid_created_error: null, pid_image: 'node.exe',
  });
  const r = await m.stop({ worker_id: 'w-neg', mode: 'kill', timeout_ms: 2000 });
  assert.equal(r.kind, 'mismatch');
  assert.ok(r.ms_to_exit >= 0, `ms_to_exit is never negative (got ${r.ms_to_exit})`);
  assert.equal(other.exitCode, null);
});
