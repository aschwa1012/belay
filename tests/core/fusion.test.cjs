'use strict';
// fusion.test.cjs — reciprocal rank fusion (ADR 0040 §2): the formula, alpha at its ends, disjoint lists,
// ties, and argument validation.

const { test } = require('node:test');
const assert = require('node:assert');
const { core } = require('./helpers.cjs');

const { rrf, K } = core('fusion.cjs');
const ids = r => r.map(h => h.id);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} !~ ${b}`);

test('rrf at alpha 0.5 follows the formula and ranks a hit in both lists first', () => {
  assert.strictEqual(K, 60);
  const r = rrf(['a', 'b', 'c'], ['b', 'd'], { alpha: 0.5 });
  assert.deepStrictEqual(ids(r), ['b', 'a', 'd', 'c']);
  near(r[0].score, 0.5 / 62 + 0.5 / 61);
  near(r[1].score, 0.5 / 61);
  assert.deepStrictEqual(r[0].ranks, { semantic: 2, keyword: 1 });
  assert.deepStrictEqual(r[1].ranks, { semantic: 1, keyword: null });
  assert.deepStrictEqual(r[2].ranks, { semantic: null, keyword: 2 });
});

test('rrf defaults alpha to 0.5 and k to 60', () => {
  assert.deepStrictEqual(rrf(['a'], ['b']), rrf(['a'], ['b'], { alpha: 0.5, k: 60 }));
  near(rrf(['a'], [], {})[0].score, 0.5 / 61);
});

test('rrf at alpha 1 is the semantic order and at alpha 0 the keyword order', () => {
  const sem = ['s1', 's2', 'both'];
  const kw = ['k1', 'both', 'k2'];
  const one = rrf(sem, kw, { alpha: 1 });
  assert.deepStrictEqual(ids(one).slice(0, 3), sem);
  assert.strictEqual(one[3].score, 0);
  const zero = rrf(sem, kw, { alpha: 0 });
  assert.deepStrictEqual(ids(zero).slice(0, 3), kw);
  near(zero[0].score, 1 / 61);
});

test('rrf over disjoint lists interleaves by rank and keeps every hit once', () => {
  const r = rrf(['a', 'b'], ['x', 'y'], { alpha: 0.5 });
  assert.deepStrictEqual(ids(r), ['a', 'x', 'b', 'y']);
  assert.strictEqual(new Set(ids(r)).size, 4);
});

test('rrf with one list empty returns the other in order, and both empty returns nothing', () => {
  assert.deepStrictEqual(ids(rrf(['a', 'b'], [])), ['a', 'b']);
  assert.deepStrictEqual(ids(rrf([], ['a', 'b'])), ['a', 'b']);
  assert.deepStrictEqual(rrf([], []), []);
});

test('rrf accepts hit objects and ignores a repeated id after its first position', () => {
  const r = rrf([{ id: 'a' }, { id: 'a' }, { id: 'b' }], [{ id: 'b' }]);
  assert.deepStrictEqual(r[0].ranks, { semantic: 2, keyword: 1 });
  assert.strictEqual(r.length, 2);
});

test('rrf breaks ties by the better single rank, then by first appearance', () => {
  // a and x tie exactly at alpha 0.5; both are rank 1 in their list, so first appearance decides.
  assert.deepStrictEqual(ids(rrf(['a'], ['x'])), ['a', 'x']);
  // alpha 0 leaves every semantic-only hit at zero: they keep their semantic order.
  assert.deepStrictEqual(ids(rrf(['p', 'q', 'r'], [], { alpha: 0 })), ['p', 'q', 'r']);
});

test('rrf rejects a bad alpha, k or list by name', () => {
  for (const alpha of [-0.1, 1.1, NaN, '0.5', null]) assert.throws(() => rrf(['a'], ['b'], { alpha }), { code: 'E_ARGS' }, String(alpha));
  for (const k of [0, -1, 1.5, '60']) assert.throws(() => rrf(['a'], ['b'], { alpha: 0.5, k }), { code: 'E_ARGS' }, String(k));
  assert.throws(() => rrf(null, []), { code: 'E_ARGS' });
  assert.throws(() => rrf([], 'x'), { code: 'E_ARGS' });
  assert.throws(() => rrf([{}], []), { code: 'E_ARGS' });
});
