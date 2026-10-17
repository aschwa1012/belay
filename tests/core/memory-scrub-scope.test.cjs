'use strict';
// memory-scrub-scope.test.cjs — memory.scrubScope after the relations change: unresolved pending notes, pairs a worker named with
// `replaced_by` this run, live notes with unjudged embed matches, nominations. A bare "wrong" report is no longer in scope.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT, A, A_NEAR } = require('./lifecycle-env.cjs');

let T;
before(async () => { T = await setup(); });
after(() => T.close());

const scope = async () => T.call(T.who.operator('apply'), 'memory.scrubScope', {});
const why = (s, id) => (s.items.find(i => i.id === id) || {}).why;
const rep = (replaced_by, run_id = 'lc-apply') => ({ ...T.report('worker:w2', replaced_by), run_id });
const match = id => ({ id, title: 't', kind: 'lesson', basis: 'observed', similarity: 0.95 });

test('a worker report with no replacement is not in scope; one naming a live note is', async () => {
  const keep = T.note('scope kept note', { vec: A, created_at: 10 });
  const bare = T.note('scope bare report', { vec: A, reported_wrong: [rep(null)] });
  const named = T.note('scope named report', { vec: A_NEAR, reported_wrong: [rep(keep)] });
  const old = T.note('scope old run report', { vec: A, reported_wrong: [rep(keep, 'old-run')] });
  const gone = T.note('scope archived partner', { ns: `archive/${PROJECT}`, vec: A });
  const toGone = T.note('scope names archived', { vec: A, reported_wrong: [rep(gone)] });
  const s = await scope();
  assert.strictEqual(why(s, bare), undefined, 'a wrong report alone leaves the scrub scope');
  assert.deepStrictEqual(why(s, named), ['replaced_by']);
  assert.strictEqual(why(s, old), undefined, 'only this run\'s reports');
  assert.strictEqual(why(s, toGone), undefined, 'the partner must be live');
  assert.strictEqual(s.counts.replaced_by, 1);
  assert.strictEqual(s.items.find(i => i.id === named).related.some(r => r.id === keep), true, 'the partner is shown in full');
});

test('pending notes this run left unresolved are in scope, another run\'s are not', async () => {
  const mine = T.note('scope pending mine', { ns: `pending/${PROJECT}`, state: 'pending', run_id: 'lc-apply' });
  const other = T.note('scope pending other', { ns: `pending/${PROJECT}`, state: 'pending', run_id: 'lc-other' });
  const s = await scope();
  assert.deepStrictEqual([why(s, mine), why(s, other)], [['pending'], undefined]);
});

test('live notes with embed matches are in scope until a new verdict judges the pair', async () => {
  const a = T.note('scope match a', { vec: A, created_at: 1 });
  const b = T.note('scope match b', { vec: A_NEAR, created_at: 2, matches: [match(a)] });
  const lone = T.note('scope match to archived', { vec: A, matches: [match(T.note('scope arch', { ns: `archive/${PROJECT}` }))] });
  let s = await scope();
  assert.deepStrictEqual(why(s, b), ['matched']);
  assert.strictEqual(why(s, lone), undefined, 'a partner that is not live is not a pair');
  const r = await T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: [{ id: b, action: 'relate', relation: 'new', of: a, reason: 'distinct lessons' }], scope: [b], ...T.evidence });
  assert.strictEqual(r.counts.applied, 1);
  s = await scope();
  assert.strictEqual(why(s, b), undefined, 'a judged pair is not offered again');
});

test('a held note is not offered, and the counts name the new kinds', async () => {
  const a = T.note('scope held partner', { vec: A });
  const h = T.note('scope held', { vec: A_NEAR, matches: [match(a)] });
  T.store.patchBody(h, b => { b.held = { row: 'x', kind: 'wrong', reason: 'r', run_id: 'r', at: 1 }; return b; });
  const s = await scope();
  assert.strictEqual(why(s, h), undefined);
  assert.deepStrictEqual(Object.keys(s.counts), ['items', 'owed', 'replaced_by', 'pending', 'matched', 'nominated']);
});
