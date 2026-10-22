'use strict';
// memory-reported-facts.test.cjs — the facts a hold with ground `reported` is checked against: the body that will be stored, a report on it
// whoever made it, and, for a replacement, a note that is live, kept and about the same thing (no age rule, no report standing in for it).
// The ground is the harness's: a scrubber entry naming it is E_GROUND.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT, A, A_NEAR, B } = require('./lifecycle-env.cjs');
const F = require('../../src/core/memory-facts.cjs');
const L = require('../../src/core/memory-lifecycle.cjs');

let T;
before(async () => { T = await setup(); });
after(() => T.close());

const rep = (over = {}) => ({ by: 'worker:w2', worker_id: 'w2', task_id: 'tx-1', run_id: 'r', why: 'it is wrong', replaced_by: null, at: 11, seq: 1, ...over });
const facts = (id, kind, of, held) => F.checkHoldFacts(T.E, PROJECT, F.loadNote(T.E, id), kind, of, 'reported', 0.8, 'r', held);

test('a reported hold needs a report on the body that is stored; the writer\'s own report counts, a rejected one counts', () => {
  const n = T.note('reported facts wrong', { vec: A });
  assert.throws(() => facts(n, 'wrong', null, { reports: [] }), (e) => e.code === 'E_PRECONDITION' && /no report recorded/.test(e.message));
  assert.throws(() => facts(n, 'wrong', null, null), (e) => e.code === 'E_PRECONDITION');
  const f = facts(n, 'wrong', null, { reports: [rep({ by: 'worker:w1' })] });
  assert.deepStrictEqual([f.trigger, f.reports], ['report', 1]);
});

test('a reported hold is wrong or superseded only; a duplicate cannot carry the ground', () => {
  const n = T.note('reported facts dup', { vec: A });
  assert.throws(() => facts(n, 'duplicate', n, { reports: [rep()] }), (e) => e.code === 'E_PRECONDITION' && /wrong or superseded/.test(e.message));
});

test('superseded: a live, kept, related replacement passes even though it is older than the note', () => {
  const old = T.note('reported facts older', { vec: A, created_at: 100 });
  const note = T.note('reported facts newer', { vec: A_NEAR, created_at: 900 });
  const f = facts(note, 'superseded', old, { reports: [rep({ replaced_by: old })] });
  assert.deepStrictEqual([f.replacement, f.via, f.shared], [old, 'reported', 'similarity']);
});

test('superseded: an unrelated replacement is refused although a report names it', () => {
  const other = T.note('reported facts other', { vec: B, created_at: 100 });
  const note = T.note('reported facts unrelated', { vec: A, created_at: 900 });
  assert.throws(() => facts(note, 'superseded', other, { reports: [rep({ replaced_by: other })] }), (e) => e.code === 'E_PRECONDITION' && /shares no path or subject/.test(e.message));
});

test('reportedKind: the newest report that names a passing replacement decides; an unrelated one is recorded and wrong results', () => {
  const a = T.note('rk a', { vec: A, created_at: 100 });
  const unrelated = T.note('rk unrelated', { vec: B, created_at: 100 });
  const note = T.note('rk note', { vec: A_NEAR, created_at: 900 });
  const n = F.loadNote(T.E, note);
  const k1 = F.reportedKind(T.E, PROJECT, n, [rep({ replaced_by: null })], 0.8);
  assert.deepStrictEqual([k1.kind, k1.of], ['wrong', null]);
  const k2 = F.reportedKind(T.E, PROJECT, n, [rep({ replaced_by: null }), rep({ seq: 2, replaced_by: a })], 0.8);
  assert.deepStrictEqual([k2.kind, k2.of], ['superseded', a]);
  const k3 = F.reportedKind(T.E, PROJECT, n, [rep({ replaced_by: a }), rep({ seq: 2, replaced_by: unrelated })], 0.8);
  assert.deepStrictEqual([k3.kind, k3.of], ['superseded', a], 'the unrelated newest report is passed over for the earlier passing one');
  const k4 = F.reportedKind(T.E, PROJECT, n, [rep({ replaced_by: unrelated })], 0.8);
  assert.strictEqual(k4.kind, 'wrong');
  assert.strictEqual(k4.facts.replaced_by, unrelated);
  assert.match(k4.facts.superseded_refused, /shares no path or subject/);
  const k5 = F.reportedKind(T.E, PROJECT, n, [rep()], 0.8, { kind: 'superseded', of: a });
  assert.deepStrictEqual([k5.kind, k5.of], ['superseded', a], 'a merged superseded hold\'s replacement is a candidate');
});

test('a replacement that is itself held is not a candidate (an unsupported queue row counts as held)', async () => {
  const a = T.note('rk held a', { vec: A, created_at: 100 });
  const note = T.note('rk held note', { vec: A_NEAR, created_at: 900 });
  const body = T.body(a);
  T.store.p('UPDATE memory_entries SET body = ? WHERE id = ?').run(JSON.stringify({ ...body, unsupported: { state: 'open' } }), a);
  T.store.storeIn({ namespace: `held/${PROJECT}`, worker_id: 'harness', type: 'held', text: `held unsupported ${a}`, title: 'q', body: { state: 'held', note_id: a, kind: 'unsupported' }, run_id: 'r', source: 'harness', written_by: 'harness' });
  assert.strictEqual(F.isHeldNow(T.E, F.loadNote(T.E, a)), true);
  const k = F.reportedKind(T.E, PROJECT, F.loadNote(T.E, note), [rep({ replaced_by: a })], 0.8);
  assert.strictEqual(k.kind, 'wrong');
});

test('the scrubber cannot write a reported hold: the ground is not in its list', async () => {
  const n = T.note('reported ground scrubber', { vec: A });
  assert.ok(!Object.values(L.HOLD_GROUNDS).flat().includes('reported'));
  assert.deepStrictEqual(L.HARNESS_GROUNDS, { wrong: ['reported'], superseded: ['reported'] });
  await assert.rejects(T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: [{ id: n, action: 'hold', kind: 'wrong', ground: 'reported', reason: 'x', cites: [T.cite] }], scope: [n], ...T.evidence }), (e) => e.code === 'E_GROUND');
});
