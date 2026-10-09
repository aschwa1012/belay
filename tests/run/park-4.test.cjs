'use strict';
// park-4.test.cjs — build step 6f-2, closing what both
// second reviews found in the merged pause: a turn still in the pipe beats the exit (r7, worker.cjs:318,
// rebuilt at build step 6i design item 7c against a synthetic child — C1); a stale row carrying this
// adapter's own pid is only "ours" for an active row, never a forgotten one (r8, pause.cjs:105); a
// retried resume after a committed-but-timed-out starting write is not refused stale (r9, pause.cjs:78);
// a restart's receipt reads paused when a pause ends its first turn, as the row does (r10,
// manager.cjs:467). A real RunManager over tests/run/fakes/fake-claude.cjs, with tests/run/fake-core.cjs
// standing in for the store — the same fixtures park-3.test.cjs uses, except (r7) below.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createRunManager } = require('../../src/run/index.cjs');
const { newWorkerRecord, attach } = require('../../src/run/worker.cjs');
const { createFakeCore, FakeCoreError } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-park4-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}
function mgr(sb, core, exe = FAKE) {
  return createRunManager({
    core, dataDir: sb.data, runId: 'run-park4-test',
    paths: { claudeExe: exe, codexExe: exe, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
}
async function teardown({ m, sb }) {
  if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
  if (sb) cleanup(sb.data);
}
async function pollUntil(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(20);
  }
  return false;
}

// ---------------------------------------------------------------- (r7)
// Rebuilt at build step 6i design item 7c (C1): the real-process version above (FAKE_EXIT_WITH_RESULT
// plus a 4 MB EXIT_PAD in fake-claude.cjs) never actually reordered 'exit' ahead of the final 'data' on
// this host, so a planted revert of exit.cjs's own close-wait (the review's plant v) stayed green 5/5.
// Driving exit.cjs's settle() directly with a synthetic child (an EventEmitter with stdout/stderr) makes
// the race deterministic: no process, no pad, no host-dependent buffering.
// Rebuilt again at build step 6i-2 design item 6 (R10): the review found this still resolved the waiter
// by hand rather than through the child's own stdout, so exit.cjs's `pendingTurnEnd` guard (worker.cjs:
// 318) had no test here. `newWorkerRecord`/`attach` (worker.cjs) wire up the record's real parser and
// exit handler; the child's own channels alone now carry the race, in the review's own order — exit,
// then the turn's result as a stdout `data` event, then close — no waiter ever resolved by hand.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}
test('restart: a first turn whose result is still unread when the process exits is reported as the turn, not the exit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-park4-r7-'));
  try {
    const w = newWorkerRecord({ id: 'w1', substrate: 'claude-code', worktree: dir, dataDir: dir });
    const ctx = { writeRow: async () => {} };
    const child = fakeChild();
    attach(w, child, ctx);
    const waiterP = new Promise((res) => w.turnWaiters.push((v) => res(v)));

    // The process has exited, but its own child object is still attached (no 'close' event yet): the
    // exact shape a real exit-before-data race leaves the record in.
    child.emit('exit', 0, null);
    assert.strictEqual(w.settled, true);
    assert.strictEqual(w.turnWaiters.length, 1, "the exit alone must not resolve the waiter: the child hasn't closed and a turn is still owed");

    // The turn's own result, as a real stream-json line the parser turns into a turn_end event — still
    // well inside the close-wait bound. No hand-built waiter resolution anywhere in this test.
    const resultLine = JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, session_id: 'fake-r7', num_turns: 1,
      total_cost_usd: 0.001, result: '', usage: { output_tokens: 1 },
    }) + '\n';
    child.stdout.emit('data', Buffer.from(resultLine));
    child.emit('close');

    const r = await waiterP;
    assert.ok(r.usage, 'a completed turn must report its own usage, not null');
    assert.strictEqual(r.exited, undefined, 'the turn must win; the exit facts must never answer this waiter');
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------- (r8)
test('stop and resume: a worker forgotten and relaunched under the same adapter pid is not taken for this adapter\'s own write', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    await m.pause({ worker_id: 'w1', by: 'operator:1' });
    const rowBefore = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(rowBefore.state, 'paused');
    // worker.forget's own shape (methods-run.cjs): supersedes the row 'forgotten', carrying the same
    // adapter_pid forward (the row now claims this adapter's own pid without this adapter writing it),
    // paused_at/paused_by nulled.
    await core.worker.write({ ...rowBefore, state: 'forgotten', paused_at: null, paused_by: null });

    await assert.rejects(m.resume({ worker_id: 'w1', by: 'operator:2' }), (e) => { assert.strictEqual(e.code, 'E_SUBSTRATE'); return true; });
    const rowAfterResume = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(rowAfterResume.state, 'forgotten', 'a forgotten row must never be relaunched as this adapter\'s own resume');

    const stopped = await m.stop({ worker_id: 'w1', mode: 'kill', timeout_ms: 2000 });
    assert.strictEqual(stopped.stale, true, 'a forgotten row carrying this adapter\'s own pid must never be taken for its own live write');
    const rowAfterStop = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(rowAfterStop.state, 'forgotten', 'the forgotten row must be left untouched, never overwritten stopped');
  } finally { await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (r9)
test('resume: a retried resume after a starting write that committed but answered E_TIMEOUT is not refused as stale', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    await m.pause({ worker_id: 'w1', by: 'operator:1' });

    // Case R (review 1's own probe): the relaunch's own 'starting' write commits to the store but
    // throws E_TIMEOUT to this caller (api.md §6's may_have_committed).
    const origWrite = core.worker.write.bind(core.worker);
    let failOnce = true;
    core.worker.write = async (r) => {
      if (failOnce && r.id === 'w1' && r.state === 'starting') {
        failOnce = false;
        await origWrite(r);
        throw new FakeCoreError('E_TIMEOUT', 'fake core: simulated committed-but-timed-out starting write');
      }
      return origWrite(r);
    };
    await assert.rejects(m.resume({ worker_id: 'w1', by: 'operator:1' }));
    core.worker.write = origWrite;

    const w = m._worker('w1');
    assert.strictEqual(w.staleSince, null, 'this adapter\'s own committed starting row must never be marked stale against its own pid');

    const retried = await m.resume({ worker_id: 'w1', by: 'operator:1' });
    assert.strictEqual(retried.resumed, true, 'a retry after this adapter\'s own committed write must succeed, not be refused stale');
  } finally { await teardown({ m, sb }); }
});

// ---------------------------------------------------------------- (r10)
test('restart: when a pause ends the first turn, the receipt\'s worker reads paused, as the row does', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    const launchesBefore = m._worker('w1').launches;
    process.env.FAKE_ANSWER_DELAY_MS = '8000';
    const restartP = m.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000 });
    // `launches` must itself have grown before the other two conditions are trusted (r1/r2's own guard),
    // or a check made right after `restart()` is called can read the *previous* launch's stale state.
    assert.ok(await pollUntil(() => m._worker('w1').launches > launchesBefore && m._worker('w1').readyAt !== null
      && m._worker('w1').op === null, 5000), 'the relaunch never completed and released the operation slot');
    delete process.env.FAKE_ANSWER_DELAY_MS;

    const paused = await m.pause({ worker_id: 'w1', by: 'operator:2' });
    assert.strictEqual(paused.interrupted, true, 'the pause must have interrupted the restart\'s own first turn');

    const r = await restartP;
    assert.strictEqual(r.worker.state, 'paused', 'the receipt\'s worker must read paused, the way the row does');
    const row = await core.worker.get({ worker_id: 'w1' });
    assert.strictEqual(row.state, 'paused');
  } finally { delete process.env.FAKE_ANSWER_DELAY_MS; await teardown({ m, sb }); }
});
