'use strict';
// fusion-mutation.test.cjs — claims of fusion.cjs that a mutation run showed no other test pins down:
// a repeated id keeps its first rank, k = 1 is the smallest accepted, and a bad list is named.

const { test } = require('node:test');
const assert = require('node:assert');
const { core } = require('./helpers.cjs');

const { rrf } = core('fusion.cjs');

test('a repeated id in the middle of a list keeps its first rank and does not push later ids down', () => {
  const r = rrf(['a', 'b', 'a', 'c'], []);
  assert.deepStrictEqual(r.map(h => [h.id, h.ranks.semantic]), [['a', 1], ['b', 2], ['c', 3]]);
  const kw = rrf([], ['x', 'x', 'y']);
  assert.deepStrictEqual(kw.map(h => [h.id, h.ranks.keyword]), [['x', 1], ['y', 2]]);
});

test('k = 1 is accepted and k = 0 is not', () => {
  const r = rrf(['a'], ['b'], { alpha: 0.5, k: 1 });
  assert.strictEqual(r[0].score, 0.5 / 2);
  assert.throws(() => rrf(['a'], ['b'], { k: 0 }), { code: 'E_ARGS' });
});

test('a bad list is named in the error, semantic and keyword alike', () => {
  assert.throws(() => rrf('x', []), { code: 'E_ARGS', message: /semantic/ });
  assert.throws(() => rrf([], 'x'), { code: 'E_ARGS', message: /keyword/ });
  assert.throws(() => rrf([], [{}]), { code: 'E_ARGS', message: /keyword/ });
  assert.throws(() => rrf([{}], []), { code: 'E_ARGS', message: /semantic/ });
});

test('alpha at both ends is accepted', () => {
  assert.doesNotThrow(() => rrf(['a'], ['b'], { alpha: 0 }));
  assert.doesNotThrow(() => rrf(['a'], ['b'], { alpha: 1 }));
});
