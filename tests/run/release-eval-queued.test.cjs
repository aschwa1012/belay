'use strict';
// release-eval-queued.test.cjs — a wake's evaluation clause says when a failing command ran beside other evaluations, and when
// an evaluation waited for a slot under max_parallel_evaluations.

const test = require('node:test');
const assert = require('node:assert');
const RE = require('../../src/run/release-eval.cjs');

const row = (over = {}) => ({ id: 't1', state: 'released', results: { passed: false, executable: true, checks: [{ kind: 'command', argv: ['node', '--test'], exit_code: 1, passed: false, concurrent: [{ task_id: 'a', overlap_ms: 5 }, { task_id: 'b', overlap_ms: 9 }] }], ...over } });

test('a failing check that overlapped other evaluations names how many', () => {
  const s = RE.summaryOf(row());
  assert.deepStrictEqual(s.failing, ['command node --test exit 1 (ran beside 2 other evaluations)']);
  assert.match(RE.clause([s], 400), /failing: command node --test exit 1 \(ran beside 2 other evaluations\)/);
  const alone = RE.summaryOf(row({ checks: [{ kind: 'command', argv: ['node'], exit_code: 1, passed: false }] }));
  assert.deepStrictEqual(alone.failing, ['command node exit 1']);
});

test('an evaluation that waited for a slot says behind how many and for how long', () => {
  const s = RE.summaryOf({ id: 't2', state: 'done', results: { passed: true, executable: true, checks: [], queued: { ahead: 2, waited_ms: 4600 } } });
  assert.deepStrictEqual(s.queued, { ahead: 2, waited_ms: 4600 });
  assert.match(RE.clause([s], 400), /passed, done \(queued behind 2, waited 5 s\)\.$/);
  assert.ok(!/queued/.test(RE.clause([RE.summaryOf({ id: 't3', state: 'done', results: { passed: true, executable: true, checks: [] } })], 400)));
});
