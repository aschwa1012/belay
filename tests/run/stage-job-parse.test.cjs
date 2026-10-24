'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseList } = require('../../src/run/stage-job.cjs');

const ans = (o) => JSON.stringify(o);
test('code quote with braces before a valid JSON answer', () => {
  const t = 'I read:\nfunction f() { return {a: 1}; }\nAnswer: ' + ans({ verdicts: [1, 2] });
  assert.deepStrictEqual(parseList(t, 'verdicts'), { list: [1, 2] });
});
test('JSON fenced block after a fenced code block', () => {
  const t = '```js\nif (x) { y(); }\n```\n```json\n' + ans({ scrub: ['a'] }) + '\n```';
  assert.deepStrictEqual(parseList(t, 'scrub'), { list: ['a'] });
});
test('two objects, only the last has the key', () => {
  const t = ans({ other: [9] }) + ' then ' + ans({ verdicts: [3] });
  assert.deepStrictEqual(parseList(t, 'verdicts'), { list: [3] });
  assert.ok(parseList(ans({ verdicts: [3] }) + ' then ' + ans({ other: [9] }), 'verdicts').list);
  assert.ok(parseList('{ x } ' + ans({ other: [1] }), 'verdicts').error);
});
test('braces and escaped quotes inside JSON strings', () => {
  const o = { verdicts: [{ reason: 'a "{" b \ } "q"' }] };
  const t = 'noise { here\n' + ans(o) + '\ntrailing }';
  assert.deepStrictEqual(parseList(t, 'verdicts'), { list: o.verdicts });
});
test('no JSON at all is an error', () => {
  assert.ok(parseList('nothing here', 'verdicts').error);
  assert.ok(parseList('', 'verdicts').error);
});
test('a huge text is bounded', () => {
  const t = '{"a":'.repeat(300000) + ans({ verdicts: [1] });
  const t0 = Date.now();
  const r = parseList(t, 'verdicts');
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(r.list || r.error);
  assert.ok(parseList('x'.repeat(400000) + ans({ verdicts: [1] }), 'verdicts').list);
});
