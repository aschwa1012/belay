'use strict';
// memory-held-settle.test.cjs — the operator's own settlement of a held note (archive, release, re-offer), a restore that reopens the dispute, the
// settlement of reports, and the per-hold listing. Real core against a sandbox store.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./report-env.cjs');
const RM = require('../../src/core/report-marks.cjs');

let X;
before(async () => { X = await setup('r-settle'); });
after(() => X.cleanup());

const hold = (id) => X.activeHold(id);
const op = () => X.operator; // the human's own command
const opHarness = () => ({ ...X.operator, channel: 'harness' }); // the run's close stages
const settle = (caller, args) => X.call('memory.heldSettle', caller, args);
const reportedNote = async (w, marker, wb) => { const a = await X.written(w, marker); await X.reported(wb, a.note); return a; };

test('S1: only the explicit operator settles: a tool call and the close stages are E_ROLE', async () => {
  const a = await reportedNote('w-a1', 'K1', 'w-b1');
  for (const who of [X.orch, X.harness, opHarness()]) await assert.rejects(settle(who, { id: a.note, action: 'release', reason: 'x' }), (e) => e.code === 'E_ROLE');
  assert.ok(hold(a.note));
  await assert.rejects(settle(op(), { id: a.note, action: 'release' }), (e) => e.code === 'E_ARGS');
  await assert.rejects(settle(op(), { id: a.note, action: 'nope', reason: 'x' }), (e) => e.code === 'E_ARGS');
  await assert.rejects(settle(op(), { id: 'no-such-note', action: 'release', reason: 'x' }), (e) => e.code === 'E_NOT_FOUND');
});

test('S2: archive moves the note under its hold and names the operator; the rows changed come back', async () => {
  const a = await reportedNote('w-a2', 'K2', 'w-b2');
  const h = hold(a.note);
  const out = await settle(op(), { id: a.note, action: 'archive', reason: 'the operator read the evidence' });
  assert.deepStrictEqual([out.outcome, out.held_row, out.row.namespace, out.held.body.state], ['archived', h.id, 'archive/acme', 'archived']);
  assert.strictEqual(X.bodyOf(a.note).archived.settled_by, 'operator');
  assert.strictEqual(X.bodyOf(a.note).archived.held_row, h.id);
  assert.strictEqual(hold(a.note), null);
});

test('S3: release settles every report without verifying the note; a report made afterwards holds it again', async () => {
  const a = await reportedNote('w-a3', 'K3', 'w-b3');
  await X.reported('w-c3', a.note, 'second');
  const out = await settle(op(), { id: a.note, action: 'release', reason: 'the operator judged the reports unfounded' });
  assert.deepStrictEqual([out.outcome, out.verified, out.settled.count], ['released', false, 2]);
  const b = X.bodyOf(a.note);
  assert.deepStrictEqual([X.rowOf(a.note).status ?? 'unverified', b.held, RM.standing(b).length, b.reports_settled.slice().sort()], ['unverified', undefined, 0, ['s:1', 's:2']]);
  assert.strictEqual(hold(a.note), null);
  await X.reported('w-d3', a.note, 'a new report after the settlement');
  const h = hold(a.note);
  assert.ok(h, 'held again');
  assert.deepStrictEqual(h.b.reports.map((r) => r.key), ['s:3'], 'only the new report is on the hold');
});

test('S4: re-offer clears the undecided mark so the next review is offered the hold', async () => {
  const a = await reportedNote('w-a4', 'K4', 'w-b4');
  const h = hold(a.note);
  await assert.rejects(settle(op(), { id: a.note, action: 'reoffer', reason: 'x' }), (e) => e.code === 'E_PRECONDITION');
  const v = await X.call('memory.reviewApply', X.harness, { verdicts: [{ id: a.note, verdict: 'undecided', reason: 'cannot say', held_row: h.id, rev: 0 }] });
  assert.strictEqual(v.applied[0].outcome, 'undecided');
  assert.ok(!(await X.call('memory.reviewQueue', X.harness, {})).held.some((e) => e.id === a.note));
  const out = await settle(op(), { id: a.note, action: 'reoffer', reason: 'look again' });
  assert.strictEqual(out.outcome, 'reoffered');
  assert.ok((await X.call('memory.reviewQueue', X.harness, {})).held.some((e) => e.id === a.note));
});

test('S5: a legacy report_confirmed hold is archived by the review on cites and its cited release settles its legacy report', async () => {
  const fixture = require('../fixtures/report-confirmed-hold.json');
  const a = await X.written('w-a5', 'K5');
  const t = await X.startTask('w-l5', 'the legacy task ran\n');
  await X.call('lease.release', X.worker('w-l5'), { lease_id: t.lease, notes: [] });
  const rep = { ...fixture.report, task_id: t.task, worker_id: 'w-l5', run_id: 'r-settle' };
  X.store.patchBody(a.note, (b) => { b.reported_wrong = [{ by: rep.by, worker_id: rep.worker_id, task_id: rep.task_id, run_id: rep.run_id, why: rep.why, replaced_by: null, at: rep.at }]; return b; });
  const row = X.store.storeIn({ namespace: 'held/acme', worker_id: 'harness', type: 'held', text: `held legacy ${a.note}`, title: 'legacy', body: { ...fixture.hold, note_id: a.note, report: { ...rep, upheld_by: 'rev', ref: 'rt' }, run_id: 'r-settle', head_sha: X.head }, run_id: 'r-settle', source: 'harness', written_by: 'harness' });
  X.store.patchBody(a.note, (b) => { b.held = { row: row.id, kind: 'wrong', of: null, reason: 'legacy', run_id: 'r-settle', at: 1 }; return b; });
  const e = (await X.call('memory.reviewQueue', X.harness, {})).held.find((h) => h.id === a.note);
  assert.deepStrictEqual([e.reports.length, e.reports[0].legacy, e.reports[0].key.startsWith('l:')], [1, true, true]);
  const stream = `${X.dir}/workers/w-a5/stream.jsonl`.replace(/\\/g, '/');
  const out = await X.call('memory.reviewApply', X.harness, { verdicts: [{ id: a.note, verdict: 'release', reason: 'the stream shows it is right', cites: [{ where: `stream:${stream}`, quote: 'the loader worked as the note says' }], held_row: e.held_row, rev: e.rev, shown_hash: e.shown_hash }], evidence_files: [stream], head_sha: X.head, worktree: X.repo });
  assert.strictEqual(out.applied[0].outcome, 'released', JSON.stringify(out.refused));
  assert.deepStrictEqual(out.applied[0].settled.keys, [e.reports[0].key]);
  assert.strictEqual(RM.standing(X.bodyOf(a.note)).length, 0);
});

test('S6: 25 later judgments leave a settled report settled, and reports_settled never outgrows reported_wrong', async () => {
  const a = await reportedNote('w-a6', 'K6', 'w-b6');
  await settle(op(), { id: a.note, action: 'release', reason: 'x' });
  X.store.patchBody(a.note, (b) => { b.report_judgments = Array.from({ length: 25 }, (_, i) => ({ verdict: 'upheld', report_key: `s:${900 + i}`, task_id: 't', report_at: i })); return b; });
  const b = X.bodyOf(a.note);
  assert.strictEqual(RM.isSettled(b, b.reported_wrong[0]), true);
  assert.deepStrictEqual(RM.standing(b), []);
  await X.reported('w-c6', a.note, 'newer'); // the writer-by-writer replace keeps one report each; the settled key leaves with its report
  const b2 = X.bodyOf(a.note);
  assert.ok((b2.reports_settled || []).every((k) => b2.reported_wrong.some((w) => RM.reportKey(w) === k)));
});

test('R1: restoring a note archived with unsettled reports holds it again in the same transaction; the proof names the hold', async () => {
  const a = await reportedNote('w-a7', 'K7', 'w-b7');
  await settle(op(), { id: a.note, action: 'archive', reason: 'x' });
  const n0 = await X.heldCount();
  const r = await X.call('memory.noteRestore', X.orch, { id: a.note, reason: 'try it' });
  assert.deepStrictEqual([r.restored, r.held.kind, r.held.rev], [true, 'wrong', 0]);
  assert.strictEqual(hold(a.note).b.restored_from, X.bodyOf(a.note).restored[0].was_archived.review);
  assert.strictEqual(await X.heldCount(), n0 + 1);
  await assert.rejects(X.call('memory.noteRestore', X.orch, { id: a.note, reason: 'x', settle_reports: true }), (e) => e.code === 'E_ROLE');
});

test('R2: the operator restores with the reports settled and no hold; a restore to pending writes no hold', async () => {
  const a = await reportedNote('w-a8', 'K8', 'w-b8');
  await settle(op(), { id: a.note, action: 'archive', reason: 'x' });
  const r = await X.call('memory.noteRestore', op(), { id: a.note, reason: 'the operator takes the risk', settle_reports: true });
  assert.deepStrictEqual([r.held, r.settled.count, hold(a.note)], [undefined, 1, null]);
  assert.strictEqual(RM.standing(X.bodyOf(a.note)).length, 0);
  const b = await reportedNote('w-a9', 'K9', 'w-b9');
  await settle(op(), { id: b.note, action: 'archive', reason: 'x' });
  X.store.patchBody(b.note, (x) => { x.archived.from = 'pending/acme'; return x; });
  const p = await X.call('memory.noteRestore', op(), { id: b.note, reason: 'back to pending' });
  assert.deepStrictEqual([p.namespace, p.held, hold(b.note)], ['pending/acme', undefined, null]);
});

test('L1: the held listing: one entry per hold with its fields; awaiting filters; a run caller sees only its project; the aggregate answer is unchanged in shape', async () => {
  const a = await reportedNote('w-a10', 'K10', 'w-b10');
  const h = hold(a.note);
  await X.call('memory.reviewApply', X.harness, { verdicts: [{ id: a.note, verdict: 'undecided', reason: 'cannot say', held_row: h.id, rev: 0 }] });
  const agg = await X.call('memory.held', X.orch, {});
  assert.ok(!('entries' in agg));
  assert.ok(agg.by_ground.reported >= 1 && agg.awaiting_operator >= 1 && agg.total >= 1);
  const list = await X.call('memory.held', X.orch, { list: true });
  const e = list.entries.find((x) => x.note_id === a.note);
  assert.deepStrictEqual([e.held_row, e.rev, e.kind, e.ground, e.reports, e.awaiting_operator, e.undecided.reason, e.project], [h.id, 0, 'wrong', 'reported', 1, true, 'cannot say', 'acme']);
  const awaiting = await X.call('memory.held', X.orch, { list: true, awaiting: true });
  assert.ok(awaiting.entries.length >= 1 && awaiting.entries.every((x) => x.awaiting_operator));
  await assert.rejects(X.call('memory.held', X.orch, { list: true, project: 'other' }), (e2) => e2.code === 'E_ROLE');
  const all = await X.call('memory.held', op(), { list: true });
  assert.ok(all.entries.some((x) => x.note_id === a.note));
  assert.strictEqual((await X.call('memory.held', op(), { list: true, project: 'other' })).entries.length, 0);
});
