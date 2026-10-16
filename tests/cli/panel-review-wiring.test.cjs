'use strict';
// The panel's one write action (the memory line's archive review button) is wired to the button's onPress and to nothing else: no command,
// hook, notice, tool call, model output or message can reach it. This reads the panel's sources, because the mod's own test kit cannot
// see a code path it does not run. The chain is exactly:
//   view.tsx  <Button key="review" onPress={act.review}>  ->  index.tsx acts().review  ->  reviewPress  ->  dispatchReview  ->  process.spawn

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '..', 'src', 'mod', 'hooks', 'panel');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\r\n/g, '\n');
const files = fs.readdirSync(DIR).filter((f) => /\.(ts|tsx)$/.test(f));
const lines = (f) => read(f).split('\n').map((text, i) => ({ f, n: i + 1, text })).filter((l) => !/^\s*\/\//.test(l.text));
const all = files.flatMap(lines);
const hits = (re) => all.filter((l) => re.test(l.text));

// The enclosing top-level function of a line in a file: the nearest earlier line that starts a function declaration.
function enclosing(f, n) {
  const src = read(f).split('\n');
  for (let i = n - 1; i >= 0; i -= 1) {
    const m = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/.exec(src[i]);
    if (m) return m[1];
  }
  return null;
}

test('process.spawn is called once in the whole panel, inside dispatchReview', () => {
  const spawns = hits(/process\.spawn\b/);
  assert.strictEqual(spawns.length, 1, JSON.stringify(spawns));
  assert.strictEqual(spawns[0].f, 'index.tsx');
  assert.strictEqual(enclosing('index.tsx', spawns[0].n), 'dispatchReview');
});

test('dispatchReview is called once, from reviewPress', () => {
  const calls = hits(/\bdispatchReview\b/).filter((l) => !/function\s+dispatchReview/.test(l.text));
  assert.strictEqual(calls.length, 1, JSON.stringify(calls));
  assert.strictEqual(enclosing(calls[0].f, calls[0].n), 'reviewPress');
});

test('reviewPress is called once, as the review handler of acts(), and acts() hands it to the view only', () => {
  const calls = hits(/\breviewPress\b/).filter((l) => !/function\s+reviewPress/.test(l.text));
  assert.strictEqual(calls.length, 1, JSON.stringify(calls));
  assert.match(calls[0].text, /^\s*review: \(\) => \{ void reviewPress\(\$\) \},?\s*$/);
  assert.strictEqual(enclosing(calls[0].f, calls[0].n), 'acts');
});

test('act.review is used once, as the onPress of the Button keyed review; nothing in a hook, model or notice names it', () => {
  const uses = hits(/\bact\.review\b/);
  assert.strictEqual(uses.length, 1, JSON.stringify(uses));
  assert.strictEqual(uses[0].f, 'view.tsx');
  assert.match(uses[0].text, /<Button key="review".*onPress=\{act\.review\}/);
  // acts() is built only to be passed to a drawing, never called by a hook body with a name that could be chosen by input.
  const review = hits(/\.review\b|\['review'\]/).filter((l) => !/act\.review/.test(l.text));
  assert.deepStrictEqual(review.map((l) => `${l.f}:${l.text.trim()}`), []);
});

test('the command is exactly belay memory review --project <p>, and no other write is made by the panel', () => {
  assert.match(read('index.tsx'), /const REVIEW_ARGS = \['memory', 'review', '--project'\]/);
  assert.strictEqual(hits(/REVIEW_ARGS/).length, 2); // the definition and the one use
  const writes = hits(/\$\.(?:fs\.write|prompt\.submit|agent\.spawn|tool\.call|session\.append)\b/);
  assert.deepStrictEqual(writes, []);
});
