'use strict';
// memory-rows-mutation.test.cjs — claims of memory-rows.cjs that a mutation run showed no other test pins down:
// the cap on the veto lists, the 50 entry cap and the value named by a refused status filter.

const { test } = require('node:test');
const assert = require('node:assert');
const { core } = require('./helpers.cjs');

const m = core('memory-rows.cjs');

test('a veto list holds at most 20 tokens per side, sorted', () => {
  const many = Array.from({ length: 25 }, (_, i) => `tok_${String(i).padStart(2, '0')}`).join(' ');
  const v = m.dupVeto(many, 'plain words only');
  assert.strictEqual(v.only_in_query.length, 20);
  assert.deepStrictEqual(v.only_in_query, Array.from({ length: 20 }, (_, i) => `tok_${String(i).padStart(2, '0')}`));
  const w = m.dupVeto('plain words only', many);
  assert.strictEqual(w.only_in_row.length, 20);
  assert.deepStrictEqual(w.only_in_query, []);
});

test('a filter list holds 50 entries and no more, and a refused status names the value', () => {
  const fifty = Array.from({ length: 50 }, (_, i) => `t${i}`);
  assert.deepStrictEqual(m.filterSql({ types: fifty }, 'e').params, fifty);
  assert.throws(() => m.filterSql({ types: [...fifty, 'extra'] }, 'e'), { code: 'E_ARGS', detail: { field: 'filter.types' } });
  assert.throws(() => m.filterSql({ statuses: ['bogus'] }), (e) => {
    assert.strictEqual(e.code, 'E_ARGS');
    assert.deepStrictEqual(e.detail, { field: 'filter.statuses', value: 'bogus' });
    assert.match(e.message, /"bogus"/);
    assert.match(e.message, /unverified, verified, refuted/);
    return true;
  });
});

test('a short title is returned as written and a title of exactly 160 bytes is kept whole', () => {
  assert.strictEqual(m.deriveTitle('short  line\nsecond'), 'short line');
  const edge = 'y'.repeat(160);
  assert.strictEqual(m.deriveTitle(edge), edge);
  assert.strictEqual(m.deriveTitle('y'.repeat(161)), edge);
  const multi = 'é'.repeat(81);
  assert.strictEqual(Buffer.byteLength(m.deriveTitle(multi)), 160);
});
