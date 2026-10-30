'use strict';
// run-hold.cjs resume(): when the orchestrator's stdin pipe has broken between the pause and the resume, the
// resume line and every held wake are refused by the write, so none is recorded as written; each is a suppressed wake.

const test = require('node:test');
const assert = require('node:assert');

const { createRunHold } = require('../../src/run/run-hold.cjs');

test('a resume after the orchestrator stdin broke records no wake as written and suppresses the line and the held wakes', async () => {
  const wakes = []; const suppressed = []; const written = [];
  let broken = false;
  const hold = createRunHold({
    child: { pid: null, stdin: { destroyed: true } }, getIdle: () => true, onDeadline: () => {},
    writeStdinLine: (text) => { if (broken) return false; written.push(text); return true; },
    wakeText: (w) => `wake ${w.worker_id}`, pushWake: (r) => wakes.push(r), suppressWake: (r) => suppressed.push(r), nowMs: () => 0,
  });
  await hold.pause('operator');
  assert.strictEqual(hold.holdWake({ worker_id: 'w1', event: 'death' }), true);
  assert.strictEqual(hold.holdWake({ worker_id: 'w2', event: 'turn_end' }), true);
  broken = true;
  const out = hold.resume('operator', 'resume now');
  assert.deepStrictEqual(written, [], 'nothing reached the stream');
  assert.deepStrictEqual(wakes, [], 'no unwritten wake is recorded');
  assert.deepStrictEqual(suppressed.map((r) => r.event), ['resume_line', 'death', 'turn_end']);
  assert.deepStrictEqual(out.held, [], 'no held wake is reported as delivered');
  assert.deepStrictEqual(hold.wakesHeld.map((w) => !!w.delivered), [false, false], 'a suppressed held wake is not marked delivered');
});

test('a resume with a working pipe still records the line and every held wake', async () => {
  const wakes = [];
  const hold = createRunHold({
    child: { pid: null, stdin: { destroyed: true } }, getIdle: () => true, onDeadline: () => {},
    writeStdinLine: () => true, wakeText: () => 'x', pushWake: (r) => wakes.push(r), suppressWake: () => assert.fail('nothing is refused'), nowMs: () => 0,
  });
  await hold.pause('operator');
  hold.holdWake({ worker_id: 'w1', event: 'death' });
  const out = hold.resume('operator', 'resume now');
  assert.deepStrictEqual(wakes.map((r) => r.event), ['resume_line', 'death']);
  assert.strictEqual(out.held.length, 1);
});
