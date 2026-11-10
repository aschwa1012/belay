'use strict';
require('../helpers/tmp.cjs');
// run-wait-done.test.cjs — ADR 0074 amendment 4: the run wait (worker_wait with no worker ids, under a plan) returns at the done wake as it does
// at an exception, answered as `done`, and the done wake has one delivery: the wait or the wake, never both (its claim key, run-digest wakeUid).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunWait } = require('../../src/run/run-wait.cjs');
const D = require('../../src/run/run-digest.cjs');
const { doneOf, wakeOf } = require('../../src/run/done-wake.cjs');

const RUN = 'r1';
const PLAN = { review: { worker: 'rv' }, integrate: 'on_hold' };
const tasks = [
  { id: 'A', seq: 10, run_id: RUN, state: 'done', policy: PLAN, policy_rev: 1, depends_on: [], repairs: null, lease: null, acceptance: { commands: [] }, review: { review_id: 'R', state: 'holds' }, integration: { state: 'merged' }, results: { trigger: 'release', executable: true, passed: true, checks: [] } },
  { id: 'R', seq: 11, run_id: RUN, state: 'done', policy: null, depends_on: ['A'], repairs: null, lease: null, acceptance: { verdict: true }, results: { trigger: 'release', evaluated_at: 9, executable: true, passed: true, checks: [{ kind: 'verdict', executable: true, passed: true }] } },
];
const ints = [{ id: 'i1', seq: 20, run_id: RUN, state: 'evaluated', passed: true, into_branch: `belay/integrate/${RUN}`, head_sha: '0123456789abcdef' }];
const core = {
  task: { list: async () => ({ tasks }) },
  integration: { list: async () => ({ integrations: ints }) },
  policy: { list: async () => ({ rows: [], last_seq: 0 }) },
  memory: { events: async () => ({ events: [] }) },
};
const clock = () => { const c = { t: 0, now: () => c.t, sleep: async (ms) => { c.t += ms; } }; return c; };

test('the run wait returns at the done wake, answered as done, and once', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-rw-done-')).replace(/\\/g, '/');
  const rw = createRunWait({ core, runId: RUN, dataDir, pollMs: 50, clock: clock(), claimant: { pid: process.pid, created: 'own' } });
  const r = await rw.wait({ ms: 5000, t0: 0, workers: [] });
  assert.strictEqual(r.event, 'done');
  assert.strictEqual(r.timed_out, false);
  assert.match(r.done.text, /^belay: implementation done: 1 planned task done, reviewed and merged/);
  assert.strictEqual(r.exceptions, undefined);
  const again = await rw.wait({ ms: 200, t0: 0, workers: [] });
  assert.strictEqual(again.done, undefined, 'once');
  // The wake path finds it claimed: the done wake's key is the same on both paths.
  const d = wakeOf(RUN, doneOf({ runId: RUN, tasks, integrations: ints, steps: [] }));
  assert.ok(D.isClaimed({ dataDir, runId: RUN, uid: D.wakeUid(d) }), 'claimed by the wait, so the wake does not deliver it too');
  fs.rmSync(dataDir, { recursive: true, force: true });
});
