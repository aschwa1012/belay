'use strict';
// fit-budget-mutation.test.cjs — claims of fit-budget.cjs that a mutation run showed no other test pins down.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fit, cutBytes } = require('../../src/core/fit-budget.cjs');

test('a zero budget returns an empty block and says it is over budget', () => {
  const r = fit([{ id: 'a', text: 'aa' }], { max_bytes: 0, header: 'H', footer: 'F' });
  assert.deepEqual(r, { text: '', bytes: 0, kept: [], dropped: 1, over_budget: true });
  assert.equal(cutBytes('abc', 0), '');
  assert.equal(cutBytes('abc', -3), '');
});

test('zero is an accepted budget and an empty frame fits it', () => {
  assert.deepEqual(fit([], { max_bytes: 0 }), { text: '', bytes: 0, kept: [], dropped: 0, over_budget: false });
  assert.throws(() => fit([], { max_bytes: -1 }), { message: /^fit: max_bytes must be a non-negative integer$/ });
  assert.throws(() => fit([], { max_bytes: 1.5 }), TypeError);
});

test('a cut that lands inside a two-byte or four-byte character drops the whole character', () => {
  assert.equal(cutBytes('ab\u00e9\u00e9', 3), 'ab');
  assert.equal(cutBytes('ab\u00e9\u00e9', 4), 'ab\u00e9');
  assert.equal(cutBytes('a\u{1F600}', 3), 'a');
  assert.equal(cutBytes('a\u{1F600}', 5), 'a\u{1F600}');
  const r = fit([], { max_bytes: 3, header: 'ab\u00e9\u00e9\u00e9', footer: 'F' });
  assert.equal(r.text, 'ab');
  assert.equal(r.bytes, 2);
  assert.equal(r.over_budget, true);
});

test('a string that is exactly the budget is returned whole', () => {
  assert.equal(cutBytes('abcd', 4), 'abcd');
  assert.equal(cutBytes('ab\u00e9', 4), 'ab\u00e9');
});

test('a null header or footer adds no line', () => {
  const r = fit([{ id: 'a', text: 'x' }], { max_bytes: 100, header: null, footer: null });
  assert.equal(r.text, 'x');
});

test('an item with no priority counts as priority 0, and ties drop the oldest first', () => {
  const r = fit([{ id: 'old', text: 'oooooo', priority: 0 }, { id: 'new', text: 'nnnnnn' }], { max_bytes: 6 });
  assert.deepEqual(r.kept, ['new']);
  const r2 = fit([{ id: 'old', text: 'oooooo' }, { id: 'new', text: 'nnnnnn', priority: 0 }], { max_bytes: 6 });
  assert.deepEqual(r2.kept, ['new']);
  const r3 = fit([{ id: 'a', text: 'aaaaaa', priority: 1 }, { id: 'b', text: 'bbbbbb' }, { id: 'c', text: 'cccccc' }], { max_bytes: 6 });
  assert.deepEqual(r3.kept, ['a']);
});
