'use strict';
require('../helpers/tmp.cjs');
// run-wait-cancel.test.cjs — ADR 0074: a cancelled worker_wait claims nothing. A cancel before the claim leaves the wait's exceptions and steps for
// the next wait. A cancel after the claim but before the reply is sent RELEASES the claim, because a cancelled request gets no reply and
// the orchestrator never saw what was claimed; a cancel after the reply is a no-op. The clock is the test's: no timers.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunWait } = require('../../src/run/run-wait.cjs');
const CS = require('../../src/run/call-signal.cjs');
const D = require('../../src/run/run-digest.cjs');

const RUN = 'r1';
let seqN = 500;
const step = (over = {}) => ({ seq: ++seqN, run_id: RUN, step: 'fix', task_id: 'W', outcome: 'done', row_ref: `task:fix${seqN}`, error: null, worker_id: 'coder', ...over });
const failed = (over = {}) => step({ outcome: 'exception', row_ref: null, error: 'E_ARGS: boom', ...over });
const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'belay-rw-cancel-')).replace(/\\/g, '/');
function fakeCore(steps) {
  return {
    task: { list: async () => ({ tasks: [] }) },
    integration: { list: async () => ({ integrations: [] }) },
    policy: { list: async () => ({ rows: steps.map((s) => ({ ...s })), last_seq: steps.length }) },
    memory: { events: async () => ({ events: [] }) },
  };
}
function clock(onSleep = async () => {}) {
  const c = { t: 1000, sleeps: 0, now: () => c.t, sleep: async (ms) => { c.t += ms; c.sleeps += 1; await onSleep(c); } };
  return c;
}
const args = (c, over = {}) => ({ ms: 5000, t0: c.t, workers: [], ...over });

test('a cancel while the wait sleeps: the call is dropped, nothing was claimed, the next wait has it all', async () => {
  const dir = dirOf();
  const core = fakeCore([failed({ task_id: 'W' })]);
  const quiet = fakeCore([]);
  // The first wait finds nothing, sleeps, and is cancelled in its sleep.
  const c = clock(async () => { assert.ok(CS.cancel('11')); });
  const rwQuiet = createRunWait({ core: quiet, runId: RUN, dataDir: dir, pollMs: 100, clock: c });
  const out = await CS.run('11', 'worker_wait', () => rwQuiet.wait(args(c)));
  assert.deepStrictEqual(out, { cancelled: true });
  // The same, with work to report: the cancel lands after the exceptions were polled and before the claim.
  const c2 = clock(); let cancelled = false;
  const rw = createRunWait({ core, runId: RUN, dataDir: dir, pollMs: 100, clock: c2, hooks: { afterRows: async () => { if (!cancelled) { cancelled = true; assert.ok(CS.cancel('12')); } } } });
  const out2 = await CS.run('12', 'worker_wait', () => rw.wait(args(c2)));
  assert.deepStrictEqual(out2, { cancelled: true });
  assert.strictEqual(D.readDigests(dir, RUN).length, 0, 'no digest was claimed');
  assert.strictEqual(rw.pending().length, 1, 'the polled exception waits');
  const next = await rw.wait(args(c2, { ms: 100 }));
  assert.strictEqual(next.exceptions.length, 1);
  assert.strictEqual(next.digest.steps, 1);
});

test('a cancel after the claim, before the reply: the claim is released and the next wait offers the same exception and steps', async () => {
  const dir = dirOf();
  const core = fakeCore([step({ task_id: 'A' }), failed({ task_id: 'W' })]);
  const c = clock();
  const rw = createRunWait({ core, runId: RUN, dataDir: dir, pollMs: 100, clock: c });
  let seen = null;
  const out = await CS.run('21', 'worker_wait', async () => {
    seen = await rw.wait(args(c));
    assert.strictEqual(seen.exceptions.length, 1, 'the wait did claim');
    assert.strictEqual(D.readDigests(dir, RUN).length, 1);
    assert.ok(CS.cancel('21'), 'the substrate cancels after the wait answered and before the adapter sent it');
    return seen;
  });
  assert.deepStrictEqual(out, { cancelled: true }, 'no reply for a cancelled request');
  assert.strictEqual(D.readDigests(dir, RUN).length, 0, 'the digest claim is gone');
  const again = await rw.wait(args(c, { ms: 100 }));
  assert.deepStrictEqual(again.exceptions.map((e) => [e.exception, e.task_id]), [['E8', 'W']], 'the exception is offered again');
  assert.strictEqual(again.digest.steps, 2, 'and so are both steps');
  const third = await rw.wait(args(c, { ms: 100 }));
  assert.strictEqual(third.exceptions, undefined, 'and then once');
  assert.strictEqual(third.digest, undefined);
});

test('a cancel after the reply was sent changes nothing, and other tools are not tracked', async () => {
  const dir = dirOf();
  const core = fakeCore([failed({ task_id: 'W' })]);
  const c = clock();
  const rw = createRunWait({ core, runId: RUN, dataDir: dir, pollMs: 100, clock: c });
  const out = await CS.run('31', 'worker_wait', () => rw.wait(args(c)));
  assert.strictEqual(out.value.exceptions.length, 1);
  assert.strictEqual(CS.cancel('31'), false, 'the call is no longer in flight');
  assert.strictEqual(D.readDigests(dir, RUN).length, 1, 'the delivered claim stands');
  const other = await CS.run('32', 'task_list', async () => 'ok');
  assert.deepStrictEqual(other, { value: 'ok' });
  assert.strictEqual(CS.cancel('32'), false);
  assert.strictEqual(CS.current(), null, 'no store outside a tracked call');
});
