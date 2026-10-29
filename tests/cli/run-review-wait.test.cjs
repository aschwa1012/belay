'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// run-review-wait.test.cjs — ADR 0052 wired into `belay run`: an archive review attached to the run's store owner (as the panel's button
// starts one during the run) holds the owner shutdown until it releases its claim and detaches, and the run receipt names the wait.
// Headless, in this process, with the fake executable; the "review" is an operator client of the run's owner that holds a claim.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const H = require('./stop-helpers.cjs');
const cmdRun = require('../../src/cli/cmd-run.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { withTeardown } = require('../helpers/teardown.cjs');

const FAKE = `${H.ROOT}/tests/run/fakes/fake-claude.cjs`;

test('belay run waits for an attached review before it shuts the owner down, and the receipt names the wait', async () => {
  const dir = H.sandbox();
  const saved = process.env.BELAY_CLAUDE_EXE;
  process.env.BELAY_CLAUDE_EXE = FAKE;
  let rev = null;
  await withTeardown(async () => {
    const dataDir = `${dir}/.belay`;
    const seen = { claim: null, said: [], lockWhileWaiting: null, released: null, finished: null };
    // During the close stages (the run is live), the review attaches to the owner and takes its claim, as `belay memory review` does.
    const closeStagesModule = { closeStages: async (a) => {
      rev = await openCore({ dataDir: a.dataDir, caller: { role: 'operator', run_id: a.runId, pid: process.pid }, embed: false });
      seen.claim = (await rev.memory.reviewClaim({ project: 'p', pid: process.pid, job: 'archreview-wiring' })).claim;
      return { scrub: { ran: false, reason: 'seam' }, review: null };
    } };
    // When the close says it waits, the review finishes: it releases its claim and detaches.
    const reviewWaitDeps = { pollMs: 20, say: (line) => {
      seen.said.push(line);
      seen.lockWhileWaiting = fs.existsSync(`${dataDir}/owner.lock`);
      seen.finished = (async () => { seen.released = (await rev.memory.reviewRelease({ project: 'p', claim_id: seen.claim.id, ok: true, message: 'ran' })).release; await rev.close(); rev = null; })();
      void seen.finished.catch(() => {}); // the test awaits it below; this keeps a failure from being unhandled meanwhile
    } };
    const { specPath } = H.makeSpec(dir, { timeout_ms: 4000, memory: { project: 'p', notes: true } });
    const res = await cmdRun.run({ argv: [specPath], cwd: H.ROOT, dataDir, json: true, closeStagesModule, reviewWaitDeps });
    assert.strictEqual(res.code, 0, res.json.ended_by);
    assert.ok(seen.claim, 'the review took its claim while the run was live');
    assert.strictEqual(seen.said.length, 1, 'the close said once that it waits');
    assert.match(seen.said[0], /waiting for the archive review of p \(pid \d+, job archreview-wiring, claim me-\S+\)/);
    assert.strictEqual(seen.lockWhileWaiting, true, 'the owner was up while the close waited');
    // The review's release is its own call over the pipe; the run's owner may stop as soon as the claim leaves running, so wait for the call to finish.
    await seen.finished;
    assert.ok(seen.released, 'the review released its claim through the run\'s owner');
    const w = res.json.store.review_wait;
    assert.deepStrictEqual([w.outcome, w.waited_for.map((x) => [x.project, x.job])], ['detached', [['p', 'archreview-wiring']]]);
    assert.ok(!res.json.store.shutdown.error, JSON.stringify(res.json.store.shutdown));
    assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'the owner stopped after the review detached');
  }, [
    async () => { if (rev) await rev.close(); },
    () => { if (saved === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = saved; },
    () => H.cleanup(dir),
  ]);
});
