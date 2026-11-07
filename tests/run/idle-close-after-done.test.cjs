'use strict';
require('../helpers/tmp.cjs');
// idle-close-after-done.test.cjs — once the done wake has gone and the rows still read done, the idle close tells the orchestrator nothing
// more about the trees it keeps: that would be one more model turn at full context for a run that is finished. Without a done wake the
// pre-close notice goes as before.

const test = require('node:test');
const assert = require('node:assert');
const { idleClose } = require('../../src/run/orchestrator-idle-close.cjs');

const RUN = 'r1';
const pre = { event: 'pre_close', worker_id: `close:${RUN}`, turn: 0, seq: null, text: 'belay: the run closes when you next end a turn ...' };
function ctx(doneCurrent) {
  const out = { written: [], closed: null };
  const c = {
    state: { pendingWrites: [], idle: true }, rows: [], runId: RUN, pending_deaths: [], turnAtCall: 1, hold: { isPaused: () => false }, awaitingWakeIds: () => [],
    callWatcher: { holds: () => [] }, recordHold() {}, writeWake: (w) => out.written.push(w), closeThenKillOnDeadline: (why) => { out.closed = why; },
    preClose: { check: async () => ({ ran: true, wake: { ...pre } }) },
    policyWatcher: { snapshot: () => null, active: () => [], doneCurrent: () => doneCurrent },
  };
  return { c, out };
}

test('after the done wake, with nothing moved, the pre-close notice is not written', async () => {
  const { c, out } = ctx(true);
  assert.strictEqual(await idleClose(c), false);
  assert.deepStrictEqual(out.written, [], 'no extra wake');
});

test('without a done wake the pre-close notice is written, as before', async () => {
  const { c, out } = ctx(false);
  assert.strictEqual(await idleClose(c), false);
  assert.deepStrictEqual(out.written.map((w) => w.event), ['pre_close']);
});
