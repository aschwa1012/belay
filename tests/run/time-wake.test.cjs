'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// time-wake.test.cjs — ADR 0074 amendment 4, phase B: a headless run with a timeout wakes its orchestrator once, when 80% of the bound has
// passed on the run's own clock (a pause stops it), as a cap (E9) the digest follows.

const { test } = require('node:test');
const assert = require('node:assert');
const { createTimeWake } = require('../../src/run/time-wake.cjs');
const PW = require('../../src/run/policy-wakes.cjs');

test('once at 80% of the bound, never while the clock is stopped, never with no bound', () => {
  let left = 600000;
  const w = createTimeWake({ totalMs: 600000, remaining: () => left });
  assert.deepStrictEqual(w.poll(), [], 'at the start');
  left = 120001; assert.deepStrictEqual(w.poll(), [], 'just under 80%');
  left = null; assert.deepStrictEqual(w.poll(), [], 'paused: the clock is stopped, nothing is said');
  left = 120000;
  const [ev] = w.poll();
  assert.strictEqual(ev.event, 'time_bound');
  assert.match(ev.text, /^belay: the run's time bound is near: 120 s of 600 s left \(paused time not counted\)\./);
  assert.ok(Buffer.byteLength(ev.text) <= PW.WAKE_TEXT_MAX);
  left = 1000; assert.deepStrictEqual(w.poll(), [], 'once per run');
  assert.deepStrictEqual(createTimeWake({ totalMs: 0, remaining: () => 0 }).poll(), [], 'no bound, no wake');
});

test('the time wake is a cap: E9, its text passed through, the digest follows it, the receipt names the clock', () => {
  const [ev] = createTimeWake({ totalMs: 1000, remaining: () => 100 }).poll();
  assert.strictEqual(PW.exceptionOf(ev), 'E9');
  assert.strictEqual(require('../../src/run/wake.cjs').wakeText(ev), ev.text);
  assert.ok(require('../../src/run/digest-wake.cjs').ridesDigest(ev));
  assert.strictEqual(require('../../src/run/wake-record.cjs').wakeRecord(ev, ev.text, 0, true).established_by, "the run's timeout clock: 100 ms of 1000 left");
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../src/run/orchestrator.cjs'), 'utf8');
  assert.match(src, /createTimeWake\(\{ totalMs: timeoutMs, remaining: \(\) => hold\.getTimeoutRemaining\(\) \}\)\)\)\.poll\(\)/, 'the headless poll asks it');
});
