'use strict';
// Restart across a session boundary: ADR 0009's A3 row, the one the whole design is for. A new
// adapter, a new RunManager, an empty in-memory map, and a worker row in the store left by an
// adapter that is gone. `restart` has to find that worker, decide resume or replace from what the
// store holds, and relaunch it — the session id, the worktree, the task and the last event are all
// in the row, and none of them are in this process's memory.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const P = require('../../src/run/process.cjs');
const { SNAPSHOT_TIMEOUT_MS } = require('../../src/core/proc-identity.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const USER_SETTINGS = path.join(__dirname, 'fixtures', 'user-settings.json').replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ADR 0039: a kill needs the creation time the manager restates about a second after spawn; an adopter acts long after that.
// ADR 0048: the read is one snapshot attempt, so the wait is a hang guard of what one caller can wait for a snapshot (a wait behind one
// in flight, then its own) plus the restate, never a bound the snapshot's speed decides.
const waitCreated = async (core, id) => { const t0 = Date.now(); const guard = 2 * SNAPSHOT_TIMEOUT_MS + 5000; while (Date.now() - t0 < guard) { const c = core.currentWorker(id); if (c && c.pid_created) return; await sleep(100); } throw new Error(`precondition: pid_created never landed for ${id} in ${guard} ms (the snapshot read failed or the machine is too loaded for this setup)`); };

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-adopt-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { root: d, data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}

// Two managers over one store and one data dir, as two adapters of the same run would be.
const mgr = (sb, core) => createRunManager({
  core, dataDir: sb.data, runId: 'run-a3', paths: { claudeExe: FAKE, userSettings: USER_SETTINGS },
});

// An upper bound on a wait for a real event (a relaunched worker's first turn), not a budget: the wait returns the moment
// the event happens, so a generous bound costs nothing on a fast machine and keeps a loaded one from reading as a failure.
const SLOW = 45000;
const cleanup = (sb) => { try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch { /* temp dir */ } };

test('a new adapter restarts a worker of a session that has ended', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const first = mgr(sb, core);
  let second = null;
  try {
    const born = await first.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-a3', task_id: 't-a3' });
    await first._waitTurn('w-a3', SLOW);
    await sleep(120);
    const checkpointBefore = core.checkpoints[core.checkpoints.length - 1].id;

    // The session ends the way A3 ends it: the worker is gone and the adapter with it. What is left
    // is the store and the worker directory.
    await first.stop({ worker_id: 'w-a3', mode: 'kill', timeout_ms: 8000 });
    assert.equal(P.pidAlive(born.pid), false);

    // A new adapter, which has never heard of this worker.
    second = mgr(sb, core);
    assert.deepEqual(second.list().workers, [], 'the new manager starts with an empty view');

    const r = await second.restart({ worker_id: 'w-a3', first_turn_timeout_ms: SLOW });
    assert.equal(r.branch, 'resume', 'the session id and last event came from the store: ' + r.reason);
    assert.match(r.reason, /inside the 3300000 ms claude-code window/);
    assert.equal(r.old_pid, born.pid, 'the old pid is the one the store held');
    assert.ok(r.new_pid > 0 && r.new_pid !== r.old_pid);
    assert.equal(r.first_turn_timed_out, false);
    assert.ok(r.first_turn_usage, 'the relaunched worker completed a turn');
    assert.ok(r.checkpoint_id && r.checkpoint_id !== checkpointBefore, 'and checkpointed it');
    assert.equal(r.worker.state, 'running');
    assert.equal(r.worker.task_id, 't-a3', 'the task came from the row, not from this process');

    // Effects, not the return value: the store holds a running row with the new pid, and the
    // relaunch really passed --resume with the session id the store knew.
    const cur = core.currentWorker('w-a3');
    assert.equal(cur.state, 'running');
    assert.equal(cur.pid, r.new_pid);
    assert.equal(cur.session_id, born.session_id);
    const argv = JSON.parse(fs.readFileSync(path.join(sb.data, 'workers', 'w-a3', 'argv.json'), 'utf8'));
    assert.deepEqual(argv.spec.args.slice(-2), ['--resume', born.session_id]);
    // What was adopted, and where from, is recorded rather than assumed.
    const w = second._worker('w-a3');
    assert.equal(w.adopted.from_run_id, 'run-a3');
    assert.equal(w.adopted.pid, born.pid);
    assert.equal(w.adopted.state, 'stopped');
    assert.equal(w.adopted.last_checkpoint_id, checkpointBefore, 'the last checkpoint came from task.get');
    assert.equal(w.adopted.argv_hash_before, born.argv_hash);
  } finally {
    if (second) await second.shutdown().catch(() => {});
    await first.shutdown().catch(() => {});
    cleanup(sb);
  }
});

test('an adopted worker whose pid is still alive is taken by that exact pid before the relaunch', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const first = mgr(sb, core);
  let second = null;
  try {
    const born = await first.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-live', task_id: 't-live' });
    // The adapter died without stopping its worker: the row still says running and the process is
    // still there. belay is not its parent any more, so it cannot be resumed in place — and two
    // workers must never share one worktree.
    assert.equal(P.pidAlive(born.pid), true);
    await waitCreated(core, 'w-live');

    second = mgr(sb, core);
    const r = await second.restart({ worker_id: 'w-live', first_turn_timeout_ms: SLOW });
    assert.equal(r.old_pid, born.pid);
    assert.ok(r.new_pid !== born.pid);
    assert.equal(P.pidAlive(born.pid), false, "the previous adapter process must not outlive the restart");
    assert.equal(P.pidAlive(r.new_pid), true);
    assert.equal(core.currentWorker('w-live').pid, r.new_pid);
  } finally {
    if (second) await second.shutdown().catch(() => {});
    await first.shutdown().catch(() => {});
    cleanup(sb);
  }
});

test('adoption does not re-validate an inherited bad started_at: an adopted worker still writes', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const first = mgr(sb, core);
  let second = null;
  try {
    await first.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-badstart', task_id: 't-badstart' });
    await first._waitTurn('w-badstart', 8000);
    await first.stop({ worker_id: 'w-badstart', mode: 'kill', timeout_ms: 8000 });
    // A legacy row from before the core checked started_at.
    const rows = core.workerRows.get('w-badstart');
    rows[rows.length - 1].started_at = 'soon';
    const seeded = rows.length;

    second = mgr(sb, core);
    const r = await second.restart({ worker_id: 'w-badstart', first_turn_timeout_ms: SLOW });
    assert.equal(r.worker.state, 'running');
    assert.equal(core.currentWorker('w-badstart').state, 'running');
    const after = core.workerRows.get('w-badstart').slice(seeded);
    assert.ok(after.length >= 1, 'the adopted worker wrote rows');
    assert.ok(after.every((x) => !('started_at' in x) || Number.isInteger(x.started_at)), 'no write re-sent the bad value');
  } finally {
    if (second) await second.shutdown().catch(() => {});
    await first.shutdown().catch(() => {});
    cleanup(sb);
  }
});

test('restarting an id no store row names is still E_NOT_FOUND', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  await assert.rejects(
    () => m.restart({ worker_id: 'never-existed' }),
    (e) => {
      assert.equal(e.code, 'E_NOT_FOUND');
      assert.equal(e.detail.worker_id, 'never-existed');
      return true;
    }
  );
  await m.shutdown();
  cleanup(sb);
});

test('stop and message reach a worker that exists only in the store', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const first = mgr(sb, core);
  let second = null;
  try {
    // A worker whose adapter died without stopping it: the row says running and the process is
    // still there. A second adapter must be able to stop it by its exact pid.
    const born = await first.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-orphan' });
    await waitCreated(core, 'w-orphan');
    second = mgr(sb, core);
    const s = await second.stop({ worker_id: 'w-orphan', mode: 'kill', timeout_ms: 8000 });
    assert.equal(s.pid, born.pid);
    assert.equal(s.killed, true, 'nothing else was going to end it');
    assert.equal(s.graceful, false, 'there was no stdin of ours to close');
    assert.equal(P.pidAlive(born.pid), false);
    assert.equal(core.currentWorker('w-orphan').state, 'stopped', 'the stop wrote the row, because no exit event would');

    // message on an adopted claude-code worker has no stdin to write to and says so.
    await assert.rejects(
      () => second.message({ worker_id: 'w-orphan', text: 'hello' }),
      (e) => {
        assert.equal(e.code, 'E_SUBSTRATE');
        assert.equal(e.detail.worker_id, 'w-orphan');
        return true;
      }
    );
    // And an id no row names is E_NOT_FOUND from both.
    await assert.rejects(() => second.stop({ worker_id: 'nope' }), (e) => e.code === 'E_NOT_FOUND');
    await assert.rejects(() => second.message({ worker_id: 'nope', text: 'x' }), (e) => e.code === 'E_NOT_FOUND');
  } finally {
    if (second) await second.shutdown().catch(() => {});
    await first.shutdown().catch(() => {});
    cleanup(sb);
  }
});

// Build 12 A10: a write that fails after a relaunch must not leave the relaunched child alive past shutdown.
// Before the fix, doStop's `stopping` write threw the same E_ARGS and the kill behind it never ran.
test('a write failure after a relaunch still leaves no live child once shutdown returns', { timeout: 60000 }, async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const first = mgr(sb, core);
  let second = null;
  let pid = null; let child = null;
  try {
    await first.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-wfail', task_id: 't-wfail' });
    await first._waitTurn('w-wfail', 8000);
    await first.stop({ worker_id: 'w-wfail', mode: 'kill', timeout_ms: 8000 });

    second = mgr(sb, core);
    const realWrite = core.worker.write;
    core.worker.write = async () => { const e = new Error('forced write failure'); e.code = 'E_ARGS'; throw e; };
    await assert.rejects(second.restart({ worker_id: 'w-wfail', first_turn_timeout_ms: SLOW }), (e) => e.code === 'E_ARGS');
    pid = second._worker('w-wfail').pid;
    child = second._worker('w-wfail').child; // ADR 0039: the live handle, for the safety net below
    assert.ok(Number.isInteger(pid) && P.pidAlive(pid), 'the relaunched child is alive after the failed write');

    const sd = await second.shutdown();
    assert.equal(sd.stop_failed.length, 1);
    assert.equal(sd.stop_failed[0].worker_id, 'w-wfail');
    assert.equal(sd.stop_failed[0].code, 'E_ARGS');
    assert.equal(sd.stop_failed[0].pid, pid);
    assert.ok(Number.isInteger(sd.stop_failed[0].pid_gone_ms));
    await P.waitPidGone(pid, { timeoutMs: 5000 });
    assert.equal(P.pidAlive(pid), false, 'shutdown killed the relaunched child by its exact pid');
    core.worker.write = realWrite;
  } finally {
    if (child) require('../crash.cjs').crash(child); // the live handle, only if the assertion above failed
    await first.shutdown().catch(() => {});
    cleanup(sb);
  }
});
