'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// review-live-close.test.cjs — ADR 0052: the panel's review button during a LIVE run. The review attaches to the run's store owner as an
// operator client, and the run's close waits for it (run-review-wait.cjs) before it shuts the owner down; a closing owner takes no new
// claim; a review whose owner was lost still releases its claim with the outcome; and `--start` says started only on the claim. This
// process stands in for `belay run` (it owns the real store owner), the review runs in process with a fake manager, nothing is paid.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { setup } = require('../core/lifecycle-env.cjs');
const { cleanup, callerFor } = require('../core/helpers.cjs');
const { withTeardown } = require('../helpers/teardown.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { run } = require('../../src/cli/cmd-memory.cjs');
const { waitForReviews } = require('../../src/cli/run-review-wait.cjs');

const cmd = (T, argv, stageDeps, extra = {}) => run({ argv, cwd: T.dir, dataDir: T.dir, dataDirGiven: true, stageDeps, ...extra });
const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
const never = () => assert.fail('no child may be spawned');
const held = new Set(); // every held child, answered at teardown so a failed test cannot leave a review pending
const unhold = () => { for (const m of held) m.answer.resolve({ event: 'stopped', is_error: true, timed_out: false }); held.clear(); };
const ME = { createdOf: async () => ({ created: 7, image: 'node.exe' }) };
const ARGS = ['review', '--project', 'lc', '--run', 'lc-apply', '--all'];

// A planted store: one hold of project lc, lc-apply ENDED (the run the review acts for) and lc-propose LIVE (the run whose close is
// tested). This process becomes the store owner as `belay run` does, for lc-propose.
async function planted(fn) {
  const T = await setup();
  const n = T.note('held by the scrubber', { reported_wrong: [T.report()] });
  await T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: [{ id: n, action: 'hold', kind: 'wrong', ground: 'report_confirmed', reason: 'the loader throws', cites: [T.cite] }], scope: [n], ...T.evidence });
  await T.endOthers('propose');
  T.store.close();
  const runCore = await openCore({ dataDir: T.dir, caller: callerFor('operator', { run_id: 'lc-propose' }), embed: false });
  return withTeardown(async () => {
    const became = await runCore.becomeOwner();
    assert.strictEqual(became.owner, true, 'this process owns the store, as belay run does');
    return fn(T, runCore, n);
  }, [unhold, () => runCore.shutdownOwner(), () => runCore.close(), () => cleanup(T.dir)]);
}

// A manager whose child is held until the test lets it answer. `spawned` settles when the review has taken its claim and spawned.
function heldManager(answer) {
  const m = { spawned: deferred(), answer: deferred(), stopped: [] };
  held.add(m);
  m.spawn = async (a) => { m.rec = { lastAssistantText: answer, costUsd: 0.01, pid: 424242 }; m.spawned.resolve(a); return {}; };
  m.wait = () => m.answer.p;
  m.stop = async ({ worker_id }) => { m.stopped.push(worker_id); m.answer.resolve({ event: 'stopped', is_error: true, timed_out: false }); };
  m._worker = () => m.rec;
  return m;
}
// The child's spawn, or the review's own end if it never got that far (a refusal fails the test instead of hanging it).
const spawnedOr = (m, review) => Promise.race([m.spawned.p, review.then((r) => assert.fail(`the review ended before its child spawned: ${r.text}`))]);
// A wait that has not settled within `ms` fails the test in seconds, instead of hanging the file (a regression must not cost 240 s).
const bounded = (p, ms, what) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms} ms`)), ms); })]).finally(() => clearTimeout(t)); };
const SHORT_MS = 5000;
const reviewState = (core) => core.memory.reviewState({ project: 'lc' }).then((r) => r.reviews.lc);

test('a review started during a live run survives the run\'s close: the close waits, the review applies and releases, then the owner stops', async () => {
  await planted(async (T, runCore, n) => {
    const m = heldManager(JSON.stringify({ verdicts: [{ id: n, verdict: 'archive', reason: 'the code confirms the hold', cites: [T.cite] }] }));
    const review = cmd(T, ARGS.concat(['--worktree', T.repo]), { ...ME, makeManager: async () => m });
    await spawnedOr(m, review); // the claim is taken and the child is running
    const st = await reviewState(runCore);
    assert.deepStrictEqual([st.state, st.claim.pid], ['running', process.pid]);
    // The live run ends mid-review, and its close reaches the owner shutdown: it waits for the attached review first.
    await runCore.run.end({ exit_reason: 'test' });
    const waiting = deferred();
    const said = [];
    const wait = waitForReviews({ core: runCore, say: (line) => { said.push(line); waiting.resolve(); }, pollMs: 20 });
    await Promise.race([waiting.p, wait.then((x) => assert.fail(`the close did not wait for the review: ${JSON.stringify(x)}`))]);
    assert.match(said[0], /waiting for the archive review of lc \(pid \d+, job archreview-lc-apply-\S+, claim me-\S+\) attached to the store owner/);
    assert.ok(runCore.isOwner() && fs.existsSync(`${T.dir}/owner.lock`), 'the owner still serves the review');
    // A closing owner takes no new claim, so the close cannot miss a review claimed after it looked.
    await assert.rejects(runCore.memory.reviewClaim({ project: 'other', pid: process.pid, job: 'archreview-x' }), (e) => e.code === 'E_BUSY' && e.detail.reason === 'owner_closing');
    m.answer.resolve({ event: 'turn_end', is_error: false, timed_out: false }); // the child answers
    const r = await review;
    assert.strictEqual(r.code, 0, r.text);
    assert.deepStrictEqual([r.json.result.counts.applied, r.json.claim.released], [1, true]);
    const w = await bounded(wait, SHORT_MS, 'the close after the review detached');
    assert.deepStrictEqual([w.outcome, w.waited_for.map((x) => x.project)], ['detached', ['lc']]);
    const after = await reviewState(runCore);
    assert.deepStrictEqual([after.state, after.release.ok], ['ended', true], 'the release landed before the owner stopped');
    await runCore.shutdownOwner();
    assert.ok(!fs.existsSync(`${T.dir}/owner.lock`), 'the owner stops after the review detached');
  });
});

test('the close waits for nothing when no review is attached, and a console close cuts a wait at once', async () => {
  await planted(async (T, runCore) => {
    // A running claim whose process holds no connection to this owner (a CLI that died, or a review on another owner) is not waited for.
    await runCore.memory.reviewClaim({ project: 'lc', pid: process.pid, job: 'archreview-unattached' });
    assert.strictEqual((await reviewState(runCore)).state, 'running');
    const said = [];
    assert.strictEqual(await bounded(waitForReviews({ core: runCore, say: (l) => said.push(l), pollMs: 20 }), SHORT_MS, 'an unattached claim'), null);
    assert.deepStrictEqual(said, [], 'nothing to wait for, nothing said');
  });
  await planted(async (T, runCore) => {
    const m = heldManager(JSON.stringify({ verdicts: [] }));
    const review = cmd(T, ARGS.concat(['--worktree', T.repo]), { ...ME, makeManager: async () => m });
    await spawnedOr(m, review);
    const said = [];
    const w = await bounded(waitForReviews({ core: runCore, fast: { requested: () => true }, say: (l) => said.push(l), pollMs: 20 }), SHORT_MS, 'a wait under a console close');
    assert.deepStrictEqual([w.outcome, w.cut_by, w.waited_for.length, said.length], ['cut', 'interrupt', 1, 0]);
    m.answer.resolve({ event: 'turn_end', is_error: false, timed_out: false });
    assert.strictEqual((await review).code, 0);
  });
});

// A headless run has no console: a review CLI that is wedged (its pid alive, its socket open) must not hold the owner forever. The clock
// seam jumps past the deadline once the close has said it waits; the deadline is the claim time plus review_wall_s plus the margin.
test('a review that never detaches is cut at its deadline (review_wall_s plus the margin), the receipt and the message name it, and the close goes on', async () => {
  await planted(async (T, runCore) => {
    const { MARGIN_MS } = require('../../src/cli/run-review-wait.cjs');
    const m = heldManager(JSON.stringify({ verdicts: [] }));
    const review = cmd(T, ARGS.concat(['--worktree', T.repo]), { ...ME, makeManager: async () => m });
    await spawnedOr(m, review);
    const claim = (await reviewState(runCore)).claim;
    let jump = 0;
    const said = [];
    const w = await bounded(waitForReviews({ core: runCore, clock: () => Date.now() + jump, say: (l) => { said.push(l); jump = 1e10; }, pollMs: 20 }), SHORT_MS, 'a wait past its deadline');
    const wallS = require('../../src/core/memory-levers.cjs').DEFAULTS.review_wall_s; // lc-apply sets none
    assert.deepStrictEqual([w.outcome, w.cut_by, w.deadline_at, w.waited_for[0].wall_s], ['cut', 'deadline', claim.at + wallS * 1000 + MARGIN_MS, wallS]);
    assert.match(said[0], /at most until \S+ \(its review_wall_s \d+ s plus 120 s\)/);
    assert.match(said[1], /archive review of lc \(pid \d+, job archreview-\S+\) is still attached past its deadline .*stopping the store owner now/);
    assert.ok(runCore.isOwner(), 'the wait itself stops nothing: the close goes on to its own shutdown');
    m.answer.resolve({ event: 'turn_end', is_error: false, timed_out: false });
    await bounded(review, 30000, 'the review after the cut');
  });
});

test('a review that reaches a closing owner is refused before it spawns, and says why', async () => {
  await planted(async (T, runCore) => {
    runCore.owner.closeReviewClaims('the run that owns the store is closing');
    const r = await cmd(T, ARGS.concat(['--worktree', T.repo]), { ...ME, makeManager: never });
    assert.strictEqual(r.code, 1, r.text);
    assert.deepStrictEqual([r.json.error.code, r.json.error.reason], ['E_BUSY', 'owner_closing']);
    assert.match(r.text, /no archive review can start now: the run that owns the store is closing/);
    assert.strictEqual((await reviewState(runCore)).state, 'none', 'no claim was written');
  });
});

// The first release is lost with its outcome unknown (the owner went away after it was sent). The review must still end where the
// operator looks: a fresh core writes the release, or finds the one that landed.
for (const landed of [false, true]) {
  test(`a failed review whose release is lost${landed ? ' after it landed' : ''} still ends as review_ended ok:false with the reason, once`, async () => {
    await planted(async (T, runCore) => {
      let calls = 0, lost = 0;
      const lose = async (o) => { // every core the command opens: the FIRST release call anywhere is lost, the next goes through
        const c = await openCore(o);
        const real = c.memory.reviewRelease;
        c.memory.reviewRelease = async (a) => {
          if (++calls > 1) return real(a);
          lost += 1;
          if (landed) await real(a);
          throw Object.assign(new Error('the owner was lost after memory.reviewRelease was sent'), { code: 'E_OWNER_LOST', detail: { sent: true, outcome: 'unknown' } });
        };
        return c;
      };
      const m = heldManager('not a hand-back at all');
      const review = cmd(T, ARGS.concat(['--worktree', T.repo]), { ...ME, makeManager: async () => m }, { openCore: lose });
      await spawnedOr(m, review);
      m.answer.resolve({ event: 'turn_end', is_error: false, timed_out: false });
      const r = await review;
      assert.strictEqual(r.code, 1, r.text);
      assert.strictEqual(r.json.claim.released, true, r.text);
      assert.deepStrictEqual([lost, calls], [1, 2], 'the first release was lost and tried again through a fresh core');
      const st = await reviewState(runCore);
      assert.deepStrictEqual([st.state, st.release.ok, st.release.code], ['ended', false, 'E_ARGS']);
      assert.match(st.release.summary, /^E_ARGS: /, 'the reason is in the release the notices show');
      const releases = (await runCore.memory.events({ kinds: ['review_claim'], limit: 50 })).events.filter((e) => /"phase":"release"/.test(e.message));
      assert.strictEqual(releases.length, 1, 'one release, never two');
    });
  });
}

// --start's honesty: the launcher says started only when the detached child's claim shows; a child that exits before it is quoted.
test('--start beside a live run: a child that exits before its claim is exit 1 with the child\'s own words, never "started"', async () => {
  await planted(async (T) => {
    let log = null;
    const r = await cmd(T, ['review', '--project', 'lc', '--start', '--worktree', T.repo], {
      spawnDetached: (a) => { log = a.logFile; fs.mkdirSync(require('node:path').dirname(log), { recursive: true }); fs.writeFileSync(log, 'belay memory review: the refusal the child printed\n'); return { pid: 424351, exited: () => 1 }; },
    });
    assert.ok(log && log.includes('reviews'), 'the child\'s output goes to a file under the data dir');
    assert.strictEqual(r.code, 1, r.text);
    assert.notStrictEqual(r.json.started, true);
    assert.ok(r.text.includes('exited (1) before it took the claim; nothing was reviewed: belay memory review: the refusal the child printed'), r.text);
  });
});
