'use strict';
// note-title-limit.test.cjs — a note title over the limit is refused E_NOTE_SHAPE, and the refusal names the limit, the title's
// length in bytes and by how much it is over, so the retry cuts the right amount.

const test = require('node:test');
const assert = require('node:assert');
const { checkTitle, TITLE_MAX } = require('../../src/core/memory-notes.cjs');

test('a title at the limit passes; one over names the limit, its bytes and the excess', () => {
  assert.strictEqual(checkTitle('x'.repeat(TITLE_MAX), 'notes[0].').length, TITLE_MAX);
  let e;
  try { checkTitle('y'.repeat(TITLE_MAX + 21), 'notes[0].'); } catch (x) { e = x; }
  assert.ok(e, 'refused');
  assert.strictEqual(e.code, 'E_NOTE_SHAPE');
  assert.match(e.message, /^notes\[0\]\.title is 181 bytes and the limit is 160 \(21 over/);
  assert.deepStrictEqual([e.detail.bytes, e.detail.max, e.detail.over], [181, 160, 21]);
});

test('the limit counts UTF-8 bytes, not characters', () => {
  const t = '\u00e9'.repeat(TITLE_MAX / 2 + 1); // 81 characters, 162 bytes
  assert.throws(() => checkTitle(t, ''), (e) => e.code === 'E_NOTE_SHAPE' && e.detail.bytes === TITLE_MAX + 2 && e.detail.over === 2);
});
