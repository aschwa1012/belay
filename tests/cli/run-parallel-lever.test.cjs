'use strict';
// run-parallel-lever.test.cjs — the run lever max_parallel_evaluations in the run spec: a positive integer, absent from the levers
// (and so the receipt) unless set, and a bad value is a usage error before anything starts.

const { test } = require('node:test');
const assert = require('node:assert');
const { parseLevers } = require('../../src/cli/run-levers.cjs');
const { KNOWN_KEYS } = require('../../src/cli/run-spec.cjs');

test('max_parallel_evaluations is a known spec key, recorded when set and absent otherwise', () => {
  assert.ok(KNOWN_KEYS.has('max_parallel_evaluations'));
  assert.ok(!('max_parallel_evaluations' in parseLevers({})), 'unset: the levers are as they always were');
  assert.strictEqual(parseLevers({ max_parallel_evaluations: 1 }).max_parallel_evaluations, 1);
  assert.strictEqual(parseLevers({ max_parallel_evaluations: 4 }).max_parallel_evaluations, 4);
});

test('a limit that is not a positive integer is refused', () => {
  for (const bad of [0, -2, 1.5, '2', null, true, NaN, Infinity]) {
    assert.match(parseLevers({ max_parallel_evaluations: bad }).error, /max_parallel_evaluations must be a positive integer/, String(bad));
  }
});
