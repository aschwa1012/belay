'use strict';
require('../helpers/tmp.cjs');
// stall-wake-relaunch.test.cjs — a builder died and the plan's relaunch is due: the executor lists it from the worker rows, so the stall wake, which
// asks the same due(), must be given the same rows and not call the task "nobody assigned". The REAL core, the REAL policy watcher.

const test = require('node:test');
const assert = require('node:assert');
const { deadPid } = require('../core/helpers.cjs');
const R = require('./policy-review-env.cjs');
const PW = require('../../src/run/policy-wakes.cjs');
const { untaken } = require('../../src/run/policy-carried.cjs');
const { due } = require('../../src/run/policy-exec.cjs');

test('a dead builder with a relaunch due is carried by the plan: the watcher snapshot has the worker rows, so the stall wake names nothing', async () => {
  const e = await R.env('stall-relaunch');
  try {
    const t = await e.orch.task.create({ spec: 'write b.txt', acceptance: R.PASS, policy: { build: { worker: 'b1' }, ...R.REST } });
    await e.worker('b1');
    await e.exec().tick();
    await e.orch.worker.write({ id: 'b1', state: 'dead', pid: deadPid(), exit_code: 1, death_established_by: 'exit-event' });
    const w = PW.createPolicyWatcher({ core: e.h, runId: R.RUN, enabled: true, dataDir: e.dir });
    await w.poll({});
    const snap = w.snapshot();
    const workers = (await e.h.worker.list({})).workers;
    assert.deepStrictEqual(due({ ...snap, workers }).map((c) => [c.step, c.task_id]), [['relaunch', t.id]], 'the executor lists the relaunch');
    assert.ok(Array.isArray(snap.workers), 'the snapshot carries the worker rows');
    assert.deepStrictEqual(untaken(snap), [], 'so the stall wake does not call the task untaken');
  } finally { await e.close(); }
});
