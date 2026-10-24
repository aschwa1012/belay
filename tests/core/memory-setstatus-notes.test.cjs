'use strict';
// memory-setstatus-notes.test.cjs — in a notes run the orchestrator's `refuted` on a note is a report through the shared transaction body (the status
// is left as it was and the note is held for the archive review), its `unverified` is refused, and the operator's own command still sets the status
// (ADR 0047 amendment of 2026-10-22, decision 5). Rows that are not notes are unchanged.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./report-env.cjs');

let X, Y;
before(async () => {
  X = await setup('r-ss');
  Y = await setup('r-ss-off', { notes: false });
});
after(async () => { await X.cleanup(); await Y.cleanup(); });

const RECEIPT = 'test:the loader reads unlisted fixtures';
const set = (caller, args) => X.call('memory.setStatus', caller, args);

test('SS1: the orchestrator refutes a note: the status is unchanged, a reported hold names the orchestrator and the receipt, and the held count rises', async () => {
  const a = await X.written('w-ss1', 'K1');
  const before = await X.heldCount();
  const out = await set(X.orch, { id: a.note, status: 'refuted', receipt: RECEIPT });
  assert.deepStrictEqual([out.id, out.state, out.reported.seq, out.reported_by], [a.note, 'held', 1, 'orchestrator']);
  assert.notStrictEqual(out.status, 'refuted');
  assert.strictEqual(X.rowOf(a.note).status === 'refuted', false, 'the status is not refuted');
  assert.strictEqual(X.rowOf(a.note).status_receipt, null);
  const h = X.activeHold(a.note);
  assert.deepStrictEqual([h.b.ground, h.b.kind, h.b.reports.length, h.b.reports[0].by], ['reported', 'wrong', 1, 'orchestrator']);
  assert.deepStrictEqual(h.b.reports[0].cites, [RECEIPT], 'the receipt is kept on the report');
  assert.strictEqual(h.b.reports[0].why, RECEIPT);
  assert.strictEqual(out.hold.row, h.id);
  assert.strictEqual(await X.heldCount(), before + 1);
  assert.strictEqual(X.rowOf(h.id).written_by, 'harness');
});

test('SS2: a second refutation by the same orchestrator replaces its report on the one hold; the receipt must still be valid', async () => {
  const a = await X.written('w-ss2', 'K2');
  const first = await set(X.orch, { id: a.note, status: 'refuted', receipt: RECEIPT });
  const again = await set(X.orch, { id: a.note, status: 'refuted', receipt: 'test:a better reason' });
  assert.deepStrictEqual([again.state, again.hold.row], ['already_held', first.hold.row]);
  assert.strictEqual(X.heldRows(a.note).length, 1);
  assert.strictEqual(X.activeHold(a.note).b.reports.length, 1, 'one report per reporter');
  await assert.rejects(set(X.orch, { id: a.note, status: 'refuted', receipt: 'not a receipt' }), (e) => e.code === 'E_RECEIPT');
  await assert.rejects(set(X.orch, { id: a.note, status: 'refuted' }), (e) => e.code === 'E_RECEIPT');
});

test('SS3: unverified on a note is E_ROLE, a worker\'s and a harness-channel refuted too, and verified stays refused', async () => {
  const a = await X.written('w-ss3', 'K3');
  const row = JSON.stringify(X.rowOf(a.note));
  await assert.rejects(set(X.orch, { id: a.note, status: 'unverified' }), (e) => e.code === 'E_ROLE');
  await assert.rejects(set(X.harness, { id: a.note, status: 'refuted', receipt: RECEIPT }), (e) => e.code === 'E_ROLE');
  await assert.rejects(set(X.orch, { id: a.note, status: 'verified', receipt: RECEIPT }), (e) => e.code === 'E_RECEIPT');
  assert.strictEqual(JSON.stringify(X.rowOf(a.note)), row, 'nothing changed');
  assert.strictEqual(X.heldRows(a.note).length, 0);
});

test('SS4: the operator\'s refuted is direct: the status is set and nothing is reported', async () => {
  const a = await X.written('w-ss4', 'K4');
  const out = await set(X.operator, { id: a.note, status: 'refuted', receipt: 'test:the operator ran it' });
  assert.strictEqual(out.status, 'refuted');
  assert.strictEqual(X.rowOf(a.note).status, 'refuted');
  assert.strictEqual(X.heldRows(a.note).length, 0);
});

test('SS5: a row that is not a note is set as before', async () => {
  const f = await X.call('memory.store', X.orch, { namespace: `run/r-ss`, type: 'fact', text: 'a run fact', embed: false });
  const out = await set(X.orch, { id: f.id, status: 'refuted', receipt: RECEIPT });
  assert.strictEqual(out.status, 'refuted');
  const back = await set(X.orch, { id: f.id, status: 'unverified' });
  assert.strictEqual(back.status, 'unverified');
});

test('SS6: with notes off the orchestrator\'s status calls on a note are what they were', async () => {
  const id = Y.store.storeIn({ namespace: 'project/acme', worker_id: 'w', type: 'note', text: 'an old note', body: { kind: 'lesson', state: 'live', reported_wrong: [] }, run_id: 'r-old', source: 'model', written_by: 'worker:w' }).id;
  const out = await Y.call('memory.setStatus', Y.orch, { id, status: 'refuted', receipt: RECEIPT });
  assert.strictEqual(out.status, 'refuted');
  assert.strictEqual((await Y.call('memory.setStatus', Y.orch, { id, status: 'unverified' })).status, 'unverified');
});
