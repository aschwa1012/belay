'use strict';
// memory-review-refute-report.test.cjs — a task reviewer's `refuted` is a report through the shared body: the note is held for the archive review, the
// verdict is advice recorded on the hold, the note's status is left, and no note_refuted receipt is written (ADR 0047 amendment of 2026-10-22, decision 6).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./report-env.cjs');

let X;
before(async () => { X = await setup('r-rr'); });
after(() => X.cleanup());

const Q = 'the loader worked as the note says'; // a line in the reviewed task's stream
const verdictsOf = async (note, task, reviewer, verdict, cites) => {
  const rt = await X.review(reviewer, task, { memory_verdicts: [X.rv(note, verdict, cites, 'what the stream shows')] });
  return { rt, out: await X.apply(rt) };
};

test('RR1: a cited refuted makes a report and a hold with the verdict on it; the status is unchanged and no note_refuted is written', async () => {
  const a = await X.written('w-rr1', 'K1');
  const before = await X.heldCount();
  const { rt, out } = await verdictsOf(a.note, a.task, 'rev-rr1', 'refuted', [X.cite(Q)]);
  assert.strictEqual(out.applied.length, 1, JSON.stringify(out.refused));
  const got = out.applied[0];
  assert.deepStrictEqual([got.verdict, got.applied, got.reported.seq, got.status], ['refuted', true, 1, 'unverified']);
  assert.strictEqual(X.rowOf(a.note).status ?? 'unverified', 'unverified');
  assert.strictEqual(X.events('note_refuted').filter((e) => e.key === `refuted:${a.note}`).length, 0);
  const h = X.activeHold(a.note);
  assert.deepStrictEqual([h.id, h.b.ground, h.b.kind], [got.held_row, 'reported', 'wrong']);
  const rep = h.b.reports.find((r) => r.by === 'worker:rev-rr1');
  assert.deepStrictEqual([rep.worker_id, rep.task_id], ['rev-rr1', rt]);
  assert.strictEqual(rep.why, 'what the stream shows');
  assert.strictEqual(rep.cites[0].quote, Q);
  assert.deepStrictEqual([h.b.note_verdicts[0].verdict, h.b.note_verdicts[0].by, h.b.note_verdicts[0].ref], ['refuted', 'rev-rr1', rt]);
  assert.strictEqual(await X.heldCount(), before + 1);
  assert.strictEqual(X.events('note_review').filter((e) => e.ok === 1 && e.key.endsWith(`:${a.note}`) && e.key.startsWith(`review:${rt}@`)).length, 1, 'one note_review receipt');
});

test('RR2: a cite that is not in the evidence is E_CITATION and nothing is held or reported', async () => {
  const a = await X.written('w-rr2', 'K2');
  const { out } = await verdictsOf(a.note, a.task, 'rev-rr2', 'refuted', [X.cite('a line no tool ever printed')]);
  assert.deepStrictEqual([out.applied.length, out.refused[0].code], [0, 'E_CITATION']);
  assert.strictEqual(X.heldRows(a.note).length, 0);
  assert.deepStrictEqual(X.bodyOf(a.note).reported_wrong, []);
});

test('RR3: confirmed and unsupported are what they were', async () => {
  const c = await X.written('w-rr3', 'K3');
  const conf = await verdictsOf(c.note, c.task, 'rev-rr3', 'confirmed', [X.cite(Q)]);
  assert.deepStrictEqual([conf.out.applied[0].status, X.rowOf(c.note).status], ['verified', 'verified']);
  const u = await X.written('w-rr3u', 'K4');
  const uns = await verdictsOf(u.note, u.task, 'rev-rr3u', 'unsupported', []);
  assert.strictEqual(uns.out.applied.length, 1, JSON.stringify(uns.out.refused));
  assert.strictEqual(X.rowOf(u.note).status ?? 'unverified', 'unverified');
});

test('RR4: on a note already held the refuted verdict is advice on that hold, as before', async () => {
  const a = await X.written('w-rr4', 'K5');
  await X.reported('w-rr4b', a.note, 'a worker found it wrong');
  const hold = X.activeHold(a.note);
  const { out } = await verdictsOf(a.note, a.task, 'rev-rr4', 'refuted', [X.cite(Q)]);
  assert.strictEqual(out.applied[0].advice, true);
  assert.strictEqual(X.heldRows(a.note).length, 1);
  assert.strictEqual(X.activeHold(a.note).id, hold.id);
  assert.strictEqual(X.rowOf(a.note).status ?? 'unverified', 'unverified');
  assert.ok(X.activeHold(a.note).b.note_verdicts.some((v) => v.by === 'rev-rr4' && v.verdict === 'refuted'));
});

test('RR5: the same review applied twice is one report', async () => {
  const a = await X.written('w-rr5', 'K6');
  const { rt, out } = await verdictsOf(a.note, a.task, 'rev-rr5', 'refuted', [X.cite(Q)]);
  assert.strictEqual(out.applied.length, 1);
  const again = await X.apply(rt);
  assert.deepStrictEqual([again.applied.length, again.already.length], [0, 1]);
  assert.strictEqual(X.bodyOf(a.note).reported_wrong.filter((r) => r.by === 'worker:rev-rr5').length, 1);
});
