'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// review-live-run.test.cjs — `belay memory review` waits for any other live run (audit D35). A run's close shuts the store
// owner down under every connection, so a minutes-long, paid review begun beside a live run could lose its calls and leave a
// stray owner that refuses the next `belay run`. The run it acts for is the operator's own word and is not counted.

const { test } = require('node:test');
const assert = require('node:assert');
const { setup } = require('../core/lifecycle-env.cjs');
const { cleanup, deadPid } = require('../core/helpers.cjs');
const { run } = require('../../src/cli/cmd-memory.cjs');

const cmd = (T, argv, stageDeps) => run({ argv, cwd: T.dir, dataDir: T.dir, dataDirGiven: true, stageDeps });
async function planted(fn) {
  const T = await setup();
  try { return await fn(T); } finally { try { T.store.close(); } catch { /* closed by the test */ } cleanup(T.dir); }
}
const never = () => assert.fail('nothing may be spawned or launched while another run is live');

test('a review with --project, which picks an ended run, is refused while another run is live, and spawns nothing', async () => {
  await planted(async (T) => {
    await T.call(T.who.operator('apply'), 'run.end', { exit_reason: 'test' }); // the newest ended run with notes on; five others stay live
    T.store.close();
    const r = await cmd(T, ['review', '--project', 'lc', '--all', '--worktree', T.repo], { makeManager: never, spawnDetached: never });
    assert.strictEqual(r.code, 1, r.text);
    assert.strictEqual(r.json.error.code, 'E_BUSY');
    assert.match(r.text, /is live in this data dir/);
    assert.ok(r.json.error.message.slice(0, 160).includes('try again'), 'the panel toast cuts the message at 160 characters, so the instruction comes first');
    assert.ok(r.json.error.live_runs.includes('lc-propose') && !r.json.error.live_runs.includes('lc-apply'), 'it names the live runs, not the one acted for');
  });
});

test('--run naming an ended run is refused the same way, and so is the detached launcher (--start)', async () => {
  await planted(async (T) => {
    await T.call(T.who.operator('apply'), 'run.end', { exit_reason: 'test' });
    T.store.close();
    const r = await cmd(T, ['review', '--run', 'lc-apply', '--all', '--worktree', T.repo], { makeManager: never });
    assert.strictEqual(r.json.error.code, 'E_BUSY');
    const s = await cmd(T, ['review', '--run', 'lc-apply', '--project', 'lc', '--start', '--worktree', T.repo], { spawnDetached: never });
    assert.strictEqual(s.code, 1);
    assert.strictEqual(s.json.error.code, 'E_BUSY');
  });
});

test('with no other live run the review proceeds (the acted-for run itself may be live)', async () => {
  await planted(async (T) => {
    await T.endOthers('apply');
    T.store.close();
    const r = await cmd(T, ['review', '--run', 'lc-apply', '--all', '--worktree', T.repo], { makeManager: never });
    assert.notStrictEqual(r.json && r.json.error && r.json.error.code, 'E_BUSY');
    assert.strictEqual(r.code, 0, r.text); // an empty queue: nothing to do, nothing spawned
  });
});

// The residual of the D35 fix: a review of a LIVE run, on the operator's word, is not refused, but its run's close will cut it off, so
// the result says so. An ended run it acts for carries no such warning.
test('a review of a live run by --run carries a warning that the run close will cut it off; an ended run carries none', async () => {
  await planted(async (T) => {
    await T.endOthers('apply');
    T.store.close();
    const live = await cmd(T, ['review', '--run', 'lc-apply', '--all', '--worktree', T.repo], { makeManager: never });
    assert.strictEqual(live.code, 0, live.text);
    assert.match(live.json.closing_warning, /will shut the store owner under this review/);
    assert.match(live.text, /^warning: this run is live; its close will shut the store owner/);
  });
  await planted(async (T) => {
    await T.endOthers('apply');
    await T.call(T.who.operator('apply'), 'run.end', { exit_reason: 'test' });
    T.store.close();
    const ended = await cmd(T, ['review', '--run', 'lc-apply', '--all', '--worktree', T.repo], { makeManager: never });
    assert.strictEqual(ended.code, 0, ended.text);
    assert.strictEqual(ended.json.closing_warning, undefined);
    assert.doesNotMatch(ended.text, /warning/);
  });
});

// The close window: the orchestrator's attach left adapter_pid on a process that has exited, the run has no ended_at, and
// `belay run` still owns the store. The run reads as not alive, and only the owner lock says it is closing.
async function closing(T) {
  await T.endOthers('apply');
  await T.call(T.who.operator('propose'), 'run.attach', { adapter_pid: deadPid() }); // an unended epoch over a dead adapter
  T.store.close();
}

test('an unended run whose adapter is gone is live while another process holds the store owner (the close window)', async () => {
  await planted(async (T) => {
    await closing(T);
    const deps = { makeManager: never, spawnDetached: never, ownerLock: () => ({ pid: process.ppid }) };
    const r = await cmd(T, ['review', '--run', 'lc-apply', '--all', '--worktree', T.repo], deps);
    assert.strictEqual(r.json.error.code, 'E_BUSY', r.text);
    assert.deepStrictEqual(r.json.error.live_runs, ['lc-propose']);
  });
});

test('an unended run with a dead adapter and no owner is a crashed run and blocks nothing', async () => {
  await planted(async (T) => {
    await closing(T);
    for (const ownerLock of [() => null, () => ({ pid: process.pid }), () => ({ pid: deadPid() })]) {
      const r = await cmd(T, ['review', '--run', 'lc-apply', '--all', '--worktree', T.repo], { makeManager: never, ownerLock });
      assert.notStrictEqual(r.json && r.json.error && r.json.error.code, 'E_BUSY', r.text);
      assert.strictEqual(r.code, 0, r.text);
    }
  });
});

// The rest of the close window: `belay run` has set ended_at and is running the run-end memory jobs, and still owns the store. The
// run's first epoch names that process (the orchestrator's attach overwrote the current row's adapter pid).
async function endedByLauncher(T, launchPid, created = null, endApply = false) {
  await T.endOthers('apply');
  if (endApply) await T.call(T.who.operator('apply'), 'run.end', { exit_reason: 'test' });
  const op = require('../core/helpers.cjs').callerFor('operator', { run_id: 'lc-closing' });
  await T.call(op, 'run.attach', { adapter_pid: launchPid, ...(created == null ? {} : { adapter_pid_created: created }), project: 'lc', memory_levers: JSON.stringify({ project: 'lc', notes: true }) });
  await T.call(op, 'run.attach', { adapter_pid: deadPid() }); // the orchestrator's adapter takes over the row and exits
  await T.call(op, 'run.end', { exit_reason: 'test' });
  T.store.close();
}
const review = (T, runId, deps) => cmd(T, ['review', '--run', runId, '--all', '--worktree', T.repo], { makeManager: never, spawnDetached: never, ...deps });

test('an ended run whose launching process still holds the store owner is closing: a review is refused whichever run it acts for', async () => {
  await planted(async (T) => {
    await endedByLauncher(T, process.ppid, null, true);
    const deps = { ownerLock: () => ({ pid: process.ppid }) };
    for (const runId of ['lc-apply', 'lc-closing']) {
      const r = await review(T, runId, deps);
      assert.strictEqual(r.code, 1, `${runId}: ${r.text}`);
      assert.strictEqual(r.json.error.code, 'E_BUSY', runId);
      assert.deepStrictEqual(r.json.error.live_runs, ['lc-closing'], runId);
      assert.match(r.text, /has ended but its process \(pid \d+\) still holds the store owner/);
    }
    const s = await cmd(T, ['review', '--run', 'lc-apply', '--project', 'lc', '--start', '--worktree', T.repo], { spawnDetached: never, ...deps });
    assert.strictEqual(s.json.error.code, 'E_BUSY', 'the detached launcher is refused the same way');
  });
});

test('a historical ended run blocks nothing: its process is gone, or another process holds its pid, or nobody holds the owner', async () => {
  await planted(async (T) => {
    await endedByLauncher(T, deadPid(), 5);
    for (const deps of [
      { ownerLock: () => ({ pid: process.ppid }) },              // the owner is someone else's: this run's launcher is not the holder
      { ownerLock: () => null },                                  // nothing holds it
      { ownerLock: () => ({ pid: process.pid }) },                // this very process holds it
    ]) {
      const r = await review(T, 'lc-apply', deps);
      assert.notStrictEqual(r.json && r.json.error && r.json.error.code, 'E_BUSY', r.text);
      assert.strictEqual(r.code, 0, r.text);
    }
  });
});

test('the launching pid is matched by creation time: a pid another process now holds is not closing, and an unreadable time is', async () => {
  await planted(async (T) => {
    await endedByLauncher(T, process.ppid, 111);
    const lock = { ownerLock: () => ({ pid: process.ppid }) };
    const other = await review(T, 'lc-apply', { ...lock, createdOf: async () => ({ created: 222 }) });
    assert.strictEqual(other.code, 0, `another process holds the pid: ${other.text}`);
    const same = await review(T, 'lc-apply', { ...lock, createdOf: async () => ({ created: 111 }) });
    assert.strictEqual(same.json.error.code, 'E_BUSY', 'the same process is closing');
    const unreadable = await review(T, 'lc-apply', { ...lock, createdOf: async () => null });
    assert.strictEqual(unreadable.json.error.code, 'E_BUSY', 'unprovable counts as closing, never as free');
  });
});

// A run id that is ended and run again: the process that owns the store through the second close is not the first life's launcher.
async function endedTwice(T, firstPid, secondPid) {
  await T.endOthers('apply');
  const op = require('../core/helpers.cjs').callerFor('operator', { run_id: 'lc-closing' });
  const levers = { project: 'lc', memory_levers: JSON.stringify({ project: 'lc', notes: true }) };
  await T.call(op, 'run.attach', { adapter_pid: firstPid, ...levers });
  await T.call(op, 'run.end', { exit_reason: 'first life' });
  await T.call(op, 'run.attach', { adapter_pid: secondPid, ...levers }); // the same run id, run again by another process
  await T.call(op, 'run.attach', { adapter_pid: deadPid() }); // its orchestrator's adapter takes over the row and exits
  await T.call(op, 'run.end', { exit_reason: 'second life' });
  T.store.close();
}

test("a run id ended and run again is closing by the process of its present life, not by its first life's", async () => {
  await planted(async (T) => {
    await endedTwice(T, deadPid(), process.ppid);
    const held = await review(T, 'lc-apply', { ownerLock: () => ({ pid: process.ppid }) });
    assert.strictEqual(held.json.error.code, 'E_BUSY', held.text);
    assert.ok(held.json.error.live_runs.includes('lc-closing'), JSON.stringify(held.json.error));
  });
});

test("the first life's pid, now holding the owner lock, does not make a re-run run closing", async () => {
  await planted(async (T) => {
    await endedTwice(T, process.ppid, deadPid());
    const r = await review(T, 'lc-apply', { ownerLock: () => ({ pid: process.ppid }) });
    assert.notStrictEqual(r.json && r.json.error && r.json.error.code, 'E_BUSY', r.text);
    assert.strictEqual(r.code, 0, r.text);
  });
});

// The same window without seams: this process stands in for `belay run` (it owns the real store owner and has ended its run, and the
// run-end memory jobs it would be running are the gap), and the built CLI runs the review as a separate process. The real owner lock, the
// real pid check and the run row's first epoch decide; the owner's shutdown call is what ends the window.
test('the built CLI refuses a review while the ended run\'s process still owns the store, and proceeds once the owner is shut down', async (tcx) => {
  const { spawnSync } = require('node:child_process');
  const { ROOT, CLI } = require('./stop-helpers.cjs');
  const { openCore } = require('../../src/core/index.cjs');
  const { callerFor } = require('../core/helpers.cjs');
  await planted(async (T) => {
    await T.endOthers('apply');
    T.store.close();
    const env = { ...process.env, BELAY_TEST_MODE: '1', BELAY_TEST_SKIP_EMBEDDER_WARMUP: '1' };
    const review = () => spawnSync(process.execPath, [CLI, 'memory', 'review', '--run', 'lc-apply', '--all', '--worktree', T.repo, '--data', T.dir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8', env, timeout: 120000 });
    const core = await openCore({ dataDir: T.dir, caller: callerFor('operator', { run_id: 'lc-closing' }), embed: false });
    tcx.after(() => Promise.resolve().then(() => core.shutdownOwner()));
    let owned = true;
    try {
      await core.becomeOwner(); // as belay run does
      assert.strictEqual(core.isOwner(), true, 'this process is the store owner');
      await core.run.attach({ adapter_pid: process.pid, project: 'lc', memory_levers: JSON.stringify({ project: 'lc', notes: true }) });
      await core.run.end({ exit_reason: 'test' }); // ended_at is set; the run-end memory jobs and the owner shutdown are still to come
      const held = review();
      const j = JSON.parse(held.stdout || held.stderr);
      assert.strictEqual(held.status, 1, held.stdout + held.stderr);
      assert.strictEqual(j.error.code, 'E_BUSY');
      // (the fixture's other runs were launched by this same process, so they read as closing too; a real run process hosts one run)
      assert.ok(j.error.live_runs.includes('lc-closing'), JSON.stringify(j.error));
      await core.shutdownOwner();
      owned = false;
      const after = review();
      assert.strictEqual(after.status, 0, after.stdout + after.stderr);
    } finally { if (owned) await core.shutdownOwner(); await core.close(); }
  });
});
