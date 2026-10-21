'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// shutdown-drain-2.test.cjs — build step 6i-2 fix round (reviewer should-fix on item 3). shutdown-drain
// (h14) assembles write-row.cjs and lifecycle.cjs's shutdown() by hand, so it never exercises manager.cjs's
// own wiring (the shutdownFlags object it builds and the markClosed closure it passes) nor worker.cjs's
// onTurnEnd path. These two drive a real RunManager (createRunManager, src/run/index.cjs) over a real
// core (openCore) and a real spawned tests/run/fakes/fake-claude.cjs child, seeded from the reviewer's own
// probe-late-turn.cjs and probe-late-write.cjs: after m.shutdown() has run, the settled child's own
// process object (still holding every listener attach() registered) is made to deliver a late channel
// directly, exactly as the probes do, so the race is deterministic rather than timing-dependent.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openCore } = require('../../src/core/index.cjs');
const { createRunManager } = require('../../src/run/index.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const USER_SETTINGS = path.join(__dirname, 'fixtures', 'user-settings.json');

function sandbox(tag) {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), `belay-shutdown-drain2-${tag}-`));
  const dataDir = path.join(sb, 'data').split(path.sep).join('/');
  const wt = path.join(sb, 'wt').split(path.sep).join('/');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  return { sb, dataDir, wt };
}

function cleanup(sb) {
  try { fs.rmSync(sb, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------- (h18)
// Should-fix (item 3): onTurnEnd's own continuity.checkpoint/memory.store calls (now turn-record.cjs)
// bypassed the closed flag write-row.cjs checks — a turn_end parsed from a buffered stdout chunk after
// shutdown() re-elected a real store owner in this process (probe-late-turn, 2 of 2 at the reviewed head).
// Plant (worker.cjs or turn-record.cjs): drop the `ctx.shutdownFlags.closed` check in turn-record.cjs —
// this test must turn red.
test('shutdown: a turn_end arriving after shutdown writes nothing and elects no store owner', async () => {
  const { sb, dataDir, wt } = sandbox('h18');
  const runId = 'run-h18';
  let core;
  try {
    core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
    await core.run.attach({ adapter_pid: process.pid });
    const m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: USER_SETTINGS } });
    await m.spawn({ substrate: 'claude-code', worktree: wt, prompt: 'one', worker_id: 'w1' });
    const w = m._worker('w1');

    await m.shutdown();
    assert.strictEqual(core.isOwner(), false, 'shutdown must leave no owner elected in this process, or this test proves nothing');

    // The late channel: a turn_end line delivered on the settled child's own stdout, exactly as
    // probe-late-turn.cjs drives it — the listener attach() installed is still there after settle().
    const child = w.settledChild;
    assert.ok(child, 'the worker must have a settled child to deliver the late line on');
    const line = JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, session_id: 'late', num_turns: 2,
      total_cost_usd: 0, result: 'late text', usage: { output_tokens: 1 },
    }) + '\n';
    child.stdout.emit('data', Buffer.from(line));
    await new Promise((r) => setTimeout(r, 500));

    assert.strictEqual(core.isOwner(), false, 'a turn_end arriving after shutdown must elect no store owner');
    // onTurnEnd's own trailing writeRow call (unconditional here, since w.parkRequested is null) also
    // gates on the same flag and runs after recordTurn, so it is `where` that names the drop, whichever
    // of the two gates is the last to touch `w.lastError` — the invariant this test exists to show is
    // `core.isOwner()` above, never re-electing an owner through either call.
    assert.strictEqual(w.lastError && w.lastError.where, 'after-shutdown', 'the dropped write must be named on the record');
  } finally {
    if (core) {
      if (core.isOwner()) { try { await core.shutdownOwner(); } catch { /* best effort */ } }
      try { await core.close(); } catch { /* best effort */ }
    }
    cleanup(sb);
  }
});

// ---------------------------------------------------------------- (h19)
// Should-fix (item 3's wiring): neither manager.cjs's markClosed wiring nor lifecycle.cjs's
// drain-before-owner order had a test that could fail without it — (h14) assembles both by hand. This
// drives the real wiring: manager.cjs's own shutdown() closure, over a real spawned, then parked, child,
// seeded from probe-late-write.cjs's exit-fill-in channel. A *parked* worker is used deliberately: shutdown's
// own per-worker loop (lifecycle.cjs) skips `stop()` for it entirely (`left_parked`, `continue`), and
// `doStop` is the only other place that awaits `w.queue` directly — so a parked worker's own queue is
// drained by nothing except the final `await Promise.all([...].map(w => w.queue))` step, the exact
// mechanism whose ordering this test exists to show. Plants: remove the `markClosed()` call in
// manager.cjs's `shutdown` closure — red; restore the start's order in lifecycle.cjs (`core.shutdownOwner()`
// before the queues drain) — red.
test('shutdown through the manager: a late exit fill-in after shutdown elects no store owner', async () => {
  const { sb, dataDir, wt } = sandbox('h19');
  const runId = 'run-h19';
  let core;
  try {
    core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
    await core.run.attach({ adapter_pid: process.pid });
    const m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: USER_SETTINGS } });
    await m.spawn({ substrate: 'claude-code', worktree: wt, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    await m.pause({ worker_id: 'w1', by: 'operator:1' });
    const w = m._worker('w1');
    assert.strictEqual(w.state, 'paused', 'the worker must be genuinely parked before shutdown runs');

    // The order half: a write queued on the parked worker's own w.queue when shutdown() begins — the same
    // channel exit.cjs's own fill-in and worker.cjs's onTurnEnd both use — is delayed deliberately, so it
    // is still in flight while shutdown()'s later steps run. The fixed order (drain every w.queue before
    // core.shutdownOwner()) must let it finish first; the start's order (shutdownOwner before the drain)
    // tears the owner down while it is still pending.
    let queuedWriteLandedAt = null;
    w.queue = w.queue.then(() => new Promise((resolve) => {
      setTimeout(() => { queuedWriteLandedAt = Date.now(); resolve(); }, 300);
    }));
    let shutdownOwnerCalledAt = null;
    const origShutdownOwner = core.shutdownOwner.bind(core);
    core.shutdownOwner = async (...args) => { shutdownOwnerCalledAt = Date.now(); return origShutdownOwner(...args); };

    const res = await m.shutdown();
    core.shutdownOwner = origShutdownOwner;
    assert.deepStrictEqual(res.left_parked, ['w1'], 'the parked worker must be left parked, not stopped, by shutdown');
    assert.ok(queuedWriteLandedAt !== null, 'the queued write must actually have run before shutdown() resolved');
    assert.ok(shutdownOwnerCalledAt !== null, 'shutdownOwner must actually have been called');
    assert.ok(shutdownOwnerCalledAt >= queuedWriteLandedAt, 'the owner must never be shut down before an already-queued write has drained');
    assert.strictEqual(core.isOwner(), false, 'shutdown must leave no owner elected in this process, or this test proves nothing');

    // The late channel: the settled child from the park's own exit (exit.cjs's already-settled fill-in
    // branch), exactly as probe-late-write.cjs drives it.
    const child = w.settledChild;
    assert.ok(child, 'the worker must have a settled child to deliver the late exit on');
    w.exitCode = null; w.exitSignal = null;
    child.emit('exit', 9, null);
    await w.queue;
    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(core.isOwner(), false, 'a late exit fill-in arriving after shutdown must elect no store owner');
    assert.strictEqual(w.exitCode, 9, 'the late exit code must still be set on the record');
    assert.deepStrictEqual(w.lastError, { where: 'after-shutdown', state: w.settledState }, 'the dropped write must be named on the record');
  } finally {
    if (core) {
      if (core.isOwner()) { try { await core.shutdownOwner(); } catch { /* best effort */ } }
      try { await core.close(); } catch { /* best effort */ }
    }
    cleanup(sb);
  }
});
