'use strict';
// summarise-mutation.test.cjs — claims of summarise.cjs that a mutation run showed no other test pins down:
// the 8192 byte limit to the byte, the code-point-safe cut of `asked`, and an error count that ignores what is
// not a count.

const test = require('node:test');
const assert = require('node:assert');
const { summarise, classify, MAX_BYTES } = require('../../src/run/summarise.cjs');

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const shaped = (learned) => ({ fields: { asked: 'a', looked_at: [], learned, done: { commands: [] }, next: '', notes: { errors: 0 } } });

test('a summary of exactly 8192 serialised bytes is ok and one byte more is over_budget', () => {
  assert.strictEqual(MAX_BYTES, 8192);
  const base = bytes(JSON.stringify(shaped('').fields));
  const fit = shaped('x'.repeat(8192 - base));
  assert.strictEqual(bytes(JSON.stringify(fit.fields)), 8192);
  assert.strictEqual(classify(fit), 'ok');
  const over = shaped('x'.repeat(8193 - base));
  assert.strictEqual(bytes(JSON.stringify(over.fields)), 8193);
  assert.strictEqual(classify(over), 'over_budget');
});

test('asked is cut to 400 bytes on a character edge', async () => {
  const exact = await summarise({ task: { spec: 'a'.repeat(400) } });
  assert.strictEqual(exact.fields.asked, 'a'.repeat(400));
  const cut = await summarise({ task: { spec: 'a'.repeat(401) } });
  assert.strictEqual(cut.fields.asked, 'a'.repeat(400));
  const wide = (await summarise({ task: { spec: 'é'.repeat(300) } })).fields.asked;
  assert.strictEqual(bytes(wide), 400);
  assert.strictEqual([...wide].length, 200);
  const odd = (await summarise({ task: { spec: `a${'é'.repeat(300)}` } })).fields.asked;
  assert.ok(bytes(odd) <= 400 && bytes(odd) >= 399, `${bytes(odd)} bytes`);
  assert.ok(!odd.includes('�'));
  const pair = (await summarise({ task: { spec: `${'a'.repeat(397)}\u{1F600}\u{1F600}` } })).fields.asked;
  assert.strictEqual(pair, 'a'.repeat(397), 'a lone half of a pair goes, and nothing before it');
});

test('the error count adds integers only and a missing or non-integer count adds nothing', async () => {
  const r = await summarise({ observations: [{ body: { errors: 2 } }, { body: { errors: 'x' } }, { body: { errors: 1.5 } }, { body: {} }, { body: { errors: 3 } }] });
  assert.strictEqual(r.fields.notes.errors, 5);
  const none = await summarise({ observations: [{ body: { errors: 'x' } }, { body: {} }] });
  assert.strictEqual(none.fields.notes.errors, 0);
});

test('a body given as JSON text is read, and text that is not JSON reads as an empty body', async () => {
  const r = await summarise({ observations: [JSON.stringify({ errors: 4, files_read: ['a.cjs'] }), '{not json', { body: JSON.stringify({ errors: 1 }) }] });
  assert.strictEqual(r.fields.notes.errors, 5);
  assert.deepStrictEqual(r.fields.looked_at, ['a.cjs']);
});
