'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fit } = require('../../src/core/fit-budget.cjs');

const items = [
  { id: 'a', text: 'aaaaaaaaaa', priority: 1 },
  { id: 'b', text: 'bbbbbbbbbb', priority: 0 },
  { id: 'c', text: 'cccccccccc', priority: 1 },
  { id: 'd', text: 'dddddddddd', priority: 0 },
];

test('everything fits: nothing dropped, header and footer frame the items', () => {
  const r = fit(items, { max_bytes: 1000, header: 'H', footer: 'F' });
  assert.equal(r.text, 'H\naaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\ndddddddddd\nF');
  assert.deepEqual(r.kept, ['a', 'b', 'c', 'd']);
  assert.equal(r.dropped, 0);
  assert.equal(r.over_budget, false);
  assert.equal(r.bytes, Buffer.byteLength(r.text));
});

test('oldest order drops from the front, whole items only', () => {
  const r = fit(items, { max_bytes: 'H\nF'.length + 2 * 11, header: 'H', footer: 'F', drop_order: 'oldest' });
  assert.deepEqual(r.kept, ['c', 'd']);
  assert.equal(r.dropped, 2);
  assert.ok(r.bytes <= 'H\nF'.length + 22);
  assert.equal(r.text, 'H\ncccccccccc\ndddddddddd\nF');
});

test('priority-then-oldest drops low priority first, oldest among equals', () => {
  const r = fit(items, { max_bytes: 'H\nF'.length + 2 * 11, header: 'H', footer: 'F' });
  assert.deepEqual(r.kept, ['a', 'c']);
  assert.equal(r.dropped, 2);
  assert.equal(r.over_budget, false);
});

test('an item is never cut: a budget smaller than any item drops them all', () => {
  const r = fit(items, { max_bytes: 5, header: 'H', footer: 'F' });
  assert.deepEqual(r.kept, []);
  assert.equal(r.dropped, 4);
  assert.equal(r.text, 'H\nF');
  assert.equal(r.over_budget, false);
});

test('header and footer larger than the budget: header cut to fit, over_budget', () => {
  const r = fit(items, { max_bytes: 4, header: 'HEADER', footer: 'FOOTER' });
  assert.equal(r.text, 'HEAD');
  assert.equal(r.over_budget, true);
  assert.deepEqual(r.kept, []);
  assert.equal(r.dropped, 4);
});

test('the header cut never splits a multibyte character', () => {
  const r = fit([], { max_bytes: 4, header: 'ab\u00e9\u00e9\u00e9', footer: 'F' });
  assert.equal(r.over_budget, true);
  assert.ok(r.bytes <= 4);
  assert.ok(!r.text.includes('\ufffd'));
});

test('bytes are counted in UTF-8, not characters', () => {
  const r = fit([{ id: 'x', text: '\u00e9'.repeat(10) }], { max_bytes: 15 });
  assert.deepEqual(r.kept, []);
  assert.equal(r.dropped, 1);
});

test('empty header and footer add no blank lines; same input gives same output', () => {
  const a = fit(items, { max_bytes: 100 });
  const b = fit(items, { max_bytes: 100 });
  assert.equal(a.text, 'aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\ndddddddddd');
  assert.deepEqual(a, b);
});

test('bad arguments throw', () => {
  assert.throws(() => fit('x', { max_bytes: 1 }), TypeError);
  assert.throws(() => fit([], { max_bytes: -1 }), TypeError);
  assert.throws(() => fit([], { max_bytes: 1, drop_order: 'newest' }), TypeError);
});
