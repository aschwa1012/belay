'use strict';
// memory-held-settle-cas.test.cjs — memory.heldSettle { if_awaiting: true }: the panel's compare-and-set. The hold is read again inside the write's own
// transaction, and the settle is refused (E_PRECONDITION) unless the hold is active AND awaits the operator, by the predicate the listing uses. A re-offer
// clears the undecided mark but leaves the hold active, so without the flag a second settle on the same note writes; with it, it does not. Real core.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./report-env.cjs');

let X;
before(async () => { X = await setup('r-settle-cas'); });
after(() => X.cleanup());

const op = () => X.operator;
const settle = (args) => X.call('memory.heldSettle', op(), args);
// a reported note whose hold the archive review answered undecided at its revision: it awaits the operator
async function awaiting(w, marker, wb) {
  const a = await X.written(w, marker);
  await X.reported(wb, a.note);
  const h = X.activeHold(a.note);
  const v = await X.call('memory.reviewApply', X.harness, { verdicts: [{ id: a.note, verdict: 'undecided', reason: 'cannot say', held_row: h.id, rev: 0 }] });
  assert.strictEqual(v.applied[0].outcome, 'undecided');
  return { note: a.note, hold: h.id };
}

test('C1: a settle with if_awaiting on an awaiting note works', async () => {
  const a = await awaiting('w-a11', 'K11', 'w-b11');
  const out = await settle({ id: a.note, action: 'archive', reason: 'the operator read it', if_awaiting: true });
  assert.strictEqual(out.outcome, 'archived');
  assert.strictEqual(X.activeHold(a.note), null);
});

test('C2: reoffer, then an archive or release with if_awaiting is refused and writes nothing', async () => {
  const a = await awaiting('w-a12', 'K12', 'w-b12');
  assert.strictEqual((await settle({ id: a.note, action: 'reoffer', reason: 'look again', if_awaiting: true })).outcome, 'reoffered');
  const before = JSON.stringify([X.rowOf(a.note), X.activeHold(a.note)]);
  for (const action of ['archive', 'release', 'reoffer']) {
    await assert.rejects(settle({ id: a.note, action, reason: 'x', if_awaiting: true }), (e) => e.code === 'E_PRECONDITION' && e.detail.awaiting === false && e.detail.state === 'held');
  }
  assert.strictEqual(JSON.stringify([X.rowOf(a.note), X.activeHold(a.note)]), before, 'nothing was written');
  assert.ok(X.activeHold(a.note), 'the hold is still active');
});

test('C3: a note that was never undecided is refused with if_awaiting', async () => {
  const a = await X.written('w-a13', 'K13');
  await X.reported('w-b13', a.note);
  await assert.rejects(settle({ id: a.note, action: 'release', reason: 'x', if_awaiting: true }), (e) => e.code === 'E_PRECONDITION');
  assert.ok(X.activeHold(a.note));
});

test('C4: without the flag behaviour is unchanged: reoffer then archive writes', async () => {
  const a = await awaiting('w-a14', 'K14', 'w-b14');
  await settle({ id: a.note, action: 'reoffer', reason: 'look again' });
  const out = await settle({ id: a.note, action: 'archive', reason: 'wrong for good' });
  assert.strictEqual(out.outcome, 'archived');
  for (const bad of [1, 'yes', null]) await assert.rejects(settle({ id: a.note, action: 'archive', reason: 'x', if_awaiting: bad }), (e) => e.code === 'E_ARGS');
});

test('C6: a hold whose undecided mark is for an older revision does not await the operator: the flag refuses it, as the listing says', async () => {
  const a = await awaiting('w-a16', 'K16', 'w-b16');
  const row = X.activeHold(a.note);
  // a later report moves the hold to a new revision: the reviewer's undecided answer was for the old one
  X.store.patchBody(row.id, (b) => { b.rev = (Number(b.rev) || 0) + 1; return b; });
  const listed = (await X.call('memory.held', op(), { list: true, awaiting: true })).entries.some((e) => e.note_id === a.note);
  assert.strictEqual(listed, false, 'the listing does not call it awaiting');
  await assert.rejects(settle({ id: a.note, action: 'archive', reason: 'x', if_awaiting: true }), (e) => e.code === 'E_PRECONDITION');
  assert.ok(X.activeHold(a.note));
});

test('C7: the refusal says which way the hold does not await, with the revisions', async () => {
  const never = await X.written('w-a17', 'K17');
  await X.reported('w-b17', never.note);
  await assert.rejects(settle({ id: never.note, action: 'release', reason: 'x', if_awaiting: true }), (e) => e.code === 'E_PRECONDITION' && /not marked undecided/.test(e.message) && e.detail.undecided_rev === null && e.detail.rev === 0 && e.detail.awaiting === false);
  const old = await awaiting('w-a18', 'K18', 'w-b18');
  X.store.patchBody(X.activeHold(old.note).id, (b) => { b.rev = (Number(b.rev) || 0) + 1; return b; });
  await assert.rejects(settle({ id: old.note, action: 'release', reason: 'x', if_awaiting: true }), (e) => e.code === 'E_PRECONDITION' && /undecided at revision 0, but the hold is at revision 1/.test(e.message) && e.detail.undecided_rev === 0 && e.detail.rev === 1);
});

test('C5: two concurrent settles with if_awaiting give exactly one write', async () => {
  const a = await awaiting('w-a15', 'K15', 'w-b15');
  const rs = await Promise.allSettled([
    settle({ id: a.note, action: 'reoffer', reason: 'one', if_awaiting: true }),
    settle({ id: a.note, action: 'release', reason: 'two', if_awaiting: true }),
    settle({ id: a.note, action: 'archive', reason: 'three', if_awaiting: true }),
  ]);
  assert.strictEqual(rs.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(rs.map((r) => r.status === 'fulfilled' ? r.value.outcome : r.reason.code)));
  for (const r of rs.filter((x) => x.status === 'rejected')) assert.ok(['E_PRECONDITION', 'E_NOT_FOUND'].includes(r.reason.code), r.reason.code);
});
