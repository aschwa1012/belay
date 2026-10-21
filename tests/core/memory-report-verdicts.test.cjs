'use strict';
// memory-report-verdicts.test.cjs — a worker's report that a note is WRONG holds the note at once; the task's reviewer then judges the report,
// per report, with cites, and its verdict is ADVICE recorded on the hold (it neither archives nor releases the note). Real core against a sandbox
// store, a real stream file and a real git repo. Nothing here starts a model.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./report-env.cjs');
const RM = require('../../src/core/report-marks.cjs');

let X;
before(async () => { X = await setup('r-rep'); });
after(() => X.cleanup());
const call = (...a) => X.call(...a);
const written = (...a) => X.written(...a);
const reported = (...a) => X.reported(...a);
const review = (...a) => X.review(...a);
const apply = (...a) => X.apply(...a);
const briefOf = (...a) => X.briefOf(...a);
const rowOf = (id) => X.rowOf(id);
const bodyOf = (id) => X.bodyOf(id);
const events = (k) => X.events(k);
const cite = (...a) => X.cite(...a);
const rv = (...a) => X.rv(...a);
const UP = 'fixtures/unlisted.json was opened by the loader';
const UPHELD = (id, report) => [rv(id, 'upheld', [cite(UP)], 'the stream shows the file was opened', report)];
const keyed = (rt, id) => events('note_review').filter((e) => e.key.includes(`:report:${id}:`) && e.key.includes(rt));
const mark = (id, status) => X.store.p('UPDATE memory_entries SET status = ? WHERE id = ?').run(status, id);
const hold = (id) => X.activeHold(id);

// A report as an older release wrote it: no sequence number, no hold. `task` must be a task that ended.
function legacyReport(noteId, w, task, over = {}) {
  X.store.patchBody(noteId, (b) => { b.reported_wrong = [...(b.reported_wrong || []), { by: `worker:${w}`, worker_id: w, task_id: task, run_id: 'r-rep', why: 'an older report', replaced_by: null, at: 1000 + (b.reported_wrong || []).length, ...over }]; return b; });
}
// A task that ended with no note and no report (a legacy report names it).
async function endedTask(w) {
  const s = await X.startTask(w, 'the legacy task ran\n');
  await call('lease.release', X.worker(w), { lease_id: s.lease, notes: [] });
  await call('task.evaluate', X.orch, { task_id: s.task, worktree: X.dir });
  return s.task;
}

test('P1: a review task\'s brief carries the reports its task made about other notes: the row, the key, the hold, the why, the replacement and the head sha', async () => {
  const a = await written('w-a1', 'K1');
  const tb = await reported('w-b1', a.note, 'the loader reads unlisted fixtures');
  const t = await call('task.create', X.orch, { spec: 'review', depends_on: [tb], acceptance: { verdict: true } });
  const brief = await call('memory.reviewBrief', X.orch, { task_id: t.id });
  assert.strictEqual(brief.reports.length, 1, JSON.stringify(brief.reports));
  const r = brief.reports[0];
  assert.deepStrictEqual([r.note.id, r.note.written_by, r.report.task_id, r.report.why, r.report.replaced_by, r.head_sha], [a.note, 'worker:w-a1', tb, 'the loader reads unlisted fixtures', null, X.head]);
  assert.deepStrictEqual([r.report.key, r.held.row, r.held.kind], ['s:1', hold(a.note).id, 'wrong']);
  const text = require('../../src/run/note-review-text.cjs').reviewerTail(brief, []);
  assert.match(text, /REPORTS TO JUDGE/);
  assert.match(text, /reporter-stated: the loader reads unlisted fixtures/);
  assert.match(text, /report s:1 in task/);
  assert.match(text, /held for the archive review \(row /);
  assert.match(text, /"report_verdicts"/);
  assert.ok(Buffer.byteLength(text) < 3500);
});

test('P2: an upheld verdict is advice on the hold: the verdict, its cites and the revision are on the hold, and the note is untouched', async () => {
  const a = await written('w-a2', 'K2');
  const tb = await reported('w-b2', a.note);
  const h0 = hold(a.note);
  assert.deepStrictEqual([h0.b.ground, h0.b.rev, h0.b.reports.length], ['reported', 0, 1]);
  const rt = await review('rev-2', tb, { report_verdicts: UPHELD(a.note) });
  const out = await apply(rt);
  const res = out.report_verdicts;
  assert.strictEqual(res.applied.length, 1, JSON.stringify(res));
  assert.deepStrictEqual([res.applied[0].held.row, res.applied[0].held.rev, res.applied[0].report, res.applied[0].advice], [h0.id, 1, 's:1', true]);
  const h1 = hold(a.note);
  assert.deepStrictEqual([h1.id, h1.b.state, h1.b.rev, h1.b.kind, h1.b.report_verdicts.length], [h0.id, 'held', 1, 'wrong', 1]);
  const v = h1.b.report_verdicts[0];
  assert.deepStrictEqual([v.verdict, v.by, v.ref, v.report_key], ['upheld', 'rev-2', rt, 's:1']);
  assert.match(v.cites[0].where, /^stream:.*workers\/w-b2\/stream\.jsonl$/);
  const n = rowOf(a.note);
  assert.deepStrictEqual([n.namespace, n.status ?? 'unverified'], ['project/acme', 'unverified']);
  assert.strictEqual(bodyOf(a.note).held.row, h0.id);
  assert.deepStrictEqual([bodyOf(a.note).report_judgments[0].verdict, bodyOf(a.note).report_judgments[0].report_key], ['upheld', 's:1']);
  const ev = events('note_review').find((e) => e.key.endsWith(`:report:${a.note}:s:1`));
  assert.deepStrictEqual([ev.ok, ev.worker_id], [1, 'rev-2']);
  const again = await apply(rt);
  assert.strictEqual(again.report_verdicts.already.length, 1, 'a second application is a no-op');
  assert.strictEqual(X.heldRows(a.note).length, 1);
  assert.strictEqual(hold(a.note).b.rev, 1, 'and does not raise the revision again');
  assert.deepStrictEqual((await briefOf(tb)).reports, [], 'a judged report is not offered again');
});

test('P3: a rejected verdict leaves the note held (advice, not a release) and a report_rejected mark; the rejected report no longer stands', async () => {
  const a = await written('w-a3', 'K3');
  const tb = await reported('w-b3', a.note);
  const rt = await review('rev-3', tb, { report_verdicts: [rv(a.note, 'rejected', [cite(UP)], 'the loader opens it only in a test')] });
  const out = await apply(rt);
  assert.deepStrictEqual([out.report_verdicts.applied.length, out.report_verdicts.applied[0].held.row], [1, hold(a.note).id]);
  const b = bodyOf(a.note);
  assert.deepStrictEqual([b.report_rejected[0].by, b.report_rejected[0].ref, b.report_rejected[0].why], ['rev-3', rt, 'the loader reads unlisted fixtures']);
  assert.ok(b.held, 'the note is still held: a rejection is advice to the archive reviewer');
  assert.deepStrictEqual([hold(a.note).b.state, hold(a.note).b.report_verdicts[0].verdict], ['held', 'rejected']);
  assert.deepStrictEqual(RM.standing(b), [], 'the rejected report does not stand (no relate gate, no index line)');
  assert.strictEqual(X.heldRows(a.note).length, 1);
});

test('P4: a cite that is not in the reporter task\'s evidence is E_CITATION and nothing changes; the hold keeps its revision', async () => {
  const a = await written('w-a4', 'K4');
  const tb = await reported('w-b4', a.note);
  const rt = await review('rev-4', tb, { report_verdicts: [rv(a.note, 'upheld', [cite('a line nobody ever saw in any stream')])] });
  const out = await apply(rt);
  assert.deepStrictEqual([out.report_verdicts.applied.length, out.report_verdicts.refused[0].code], [0, 'E_CITATION']);
  assert.deepStrictEqual([hold(a.note).b.rev, hold(a.note).b.report_verdicts.length], [0, 0]);
  assert.deepStrictEqual(out.report_verdicts.unjudged, [], 'refused once, not also unjudged');
  assert.deepStrictEqual(out.report_verdicts.refused_open, [a.note], 'the report stays open and is named for the next review');
  assert.ok(!(await call('memory.held', X.orch, { reports: true })).unjudged_reports.some((r) => r.id === a.note), 'a held note\'s report is on the hold, not on the unjudged list');
});

test('P4b: the operator\'s unjudged list holds only reports no hold covers (older data), with a stale pointer named; a verdict takes a report off it', async () => {
  const a = await written('w-a4b', 'K40');
  const t1 = await endedTask('w-l4b');
  legacyReport(a.note, 'w-l4b', t1);
  const listed = async () => (await call('memory.held', X.orch, { reports: true })).unjudged_reports.filter((r) => r.id === a.note);
  const first = await listed();
  assert.deepStrictEqual([first.length, first[0].report_key, first[0].stale_pointer], [1, `l:${t1}@1000@worker:w-l4b`, undefined]);
  X.store.patchBody(a.note, (b) => { b.held = { row: 'gone-row', kind: 'wrong', of: null, reason: 'x', run_id: 'r', at: 1 }; return b; });
  assert.strictEqual((await listed())[0].stale_pointer, 'gone-row', 'a stale pointer is named, nothing is repaired from a read');
  X.store.patchBody(a.note, (b) => { delete b.held; return b; });
  const rt = await review('rev-4b', t1, { report_verdicts: [rv(a.note, 'rejected', [cite('the legacy task ran')])] });
  const out = await apply(rt);
  assert.strictEqual(out.report_verdicts.applied.length, 1, JSON.stringify(out.report_verdicts.refused));
  assert.strictEqual((await listed()).length, 0, 'a verdict applied is what takes it off');
  assert.strictEqual(hold(a.note), null, 'a rejection with no hold writes none');
});

test('P5: a reviewer never judges a report about a note it wrote', async () => {
  const a = await written('w-a5', 'K5');
  const tb = await reported('w-b5', a.note);
  const rt = await review('w-a5', tb, { report_verdicts: UPHELD(a.note) });
  const out = await apply(rt);
  assert.deepStrictEqual([out.report_verdicts.applied.length, out.report_verdicts.refused[0].code], [0, 'E_ROLE']);
  assert.strictEqual(hold(a.note).b.rev, 0);
});

test('P6: a verdict on a note nobody from the reviewed task reported is refused, and the orchestrator model cannot apply verdicts', async () => {
  const a = await written('w-a6', 'K6');
  const other = await written('w-o6', 'K7');
  const tb = await reported('w-b6', a.note);
  const rt = await review('rev-6', tb, { report_verdicts: UPHELD(other.note) });
  const out = await apply(rt);
  assert.deepStrictEqual([out.report_verdicts.applied.length, out.report_verdicts.refused[0].code], [0, 'E_ARGS']);
  await assert.rejects(call('memory.noteVerdicts', X.orch, { review_task_id: rt }), (e) => e.code === 'E_ROLE');
});

test('P7: a report holds its note at once: the held count rises with the report, the unjudged list does not list it, and a verdict leaves it counted', async () => {
  const before = await call('memory.held', X.orch, { reports: true });
  assert.ok(before.total >= 1);
  assert.strictEqual(typeof before.oldest_age_runs, 'number');
  const a = await written('w-a8', 'K8');
  const tb = await reported('w-b8', a.note);
  const after = await call('memory.held', X.orch, { reports: true });
  assert.strictEqual(after.total, before.total + 1, 'counted from the moment of the report');
  assert.ok(!after.unjudged_reports.some((r) => r.id === a.note), JSON.stringify(after.unjudged_reports));
  const scoped = await call('memory.held', X.orch, { project: 'other', reports: true });
  assert.deepStrictEqual([scoped.total, scoped.unjudged_reports], [0, []]);
  const st = await call('status.get', X.orch, {});
  assert.deepStrictEqual([st.notes_held.total, st.notes_held.by_project.acme], [after.total, after.by_project.acme]);
  const rt = await review('rev-8', tb, { report_verdicts: [rv(a.note, 'rejected', [cite(UP)])] });
  await apply(rt);
  assert.strictEqual((await call('memory.held', X.orch, {})).total, after.total, 'a verdict is advice: the hold is still counted');
});

test('P8: a second application of a rejected report answers already and adds no second entry or receipt', async () => {
  const a = await written('w-a9', 'K9');
  const tb = await reported('w-b9', a.note);
  const rt = await review('rev-9', tb, { report_verdicts: [rv(a.note, 'rejected', [cite(UP)], 'only in a test')] });
  const first = await apply(rt);
  assert.strictEqual(first.report_verdicts.applied.length, 1);
  const second = await apply(rt);
  assert.deepStrictEqual([second.report_verdicts.applied.length, second.report_verdicts.already.length], [0, 1]);
  assert.strictEqual(bodyOf(a.note).report_rejected.length, 1);
  assert.strictEqual(hold(a.note).b.report_verdicts.length, 1);
  assert.strictEqual(keyed(rt, a.note).length, 1);
});

test('P9: two applications of one review in flight write one entry and one receipt (the check is inside the transaction)', async () => {
  const a = await written('w-a10', 'K10');
  const tb = await reported('w-b10', a.note);
  const rt = await review('rev-10', tb, { report_verdicts: [rv(a.note, 'rejected', [cite(UP)], 'only in a test')] });
  const [x, y] = await Promise.all([apply(rt), apply(rt)]);
  assert.strictEqual(x.report_verdicts.applied.length + y.report_verdicts.applied.length, 1, JSON.stringify([x.report_verdicts, y.report_verdicts]));
  assert.strictEqual(x.report_verdicts.already.length + y.report_verdicts.already.length, 1);
  assert.strictEqual(bodyOf(a.note).report_rejected.length, 1);
  assert.strictEqual(hold(a.note).b.report_verdicts.length, 1);
  assert.strictEqual(keyed(rt, a.note).length, 1);
});

test('P10: a reviewer that made the report, or held a lease on the reporting task, cannot judge it (E_ROLE independence)', async () => {
  const a = await written('w-a11', 'K11');
  const tb = await reported('w-b11', a.note);
  const rt = await review('w-b11', tb, { report_verdicts: UPHELD(a.note) }); // the reporter itself reviews
  const out = await apply(rt);
  assert.deepStrictEqual([out.report_verdicts.applied.length, out.report_verdicts.refused[0].code], [0, 'E_ROLE']);
  assert.match(out.report_verdicts.refused[0].message, /made the report|held lease/);
  assert.strictEqual(hold(a.note).b.rev, 0);
  const a2 = await written('w-a12', 'K12');
  const tb2 = await reported('w-b12', a2.note);
  const lease = X.store.p("SELECT id FROM lease WHERE task_id = ? AND holder = 'w-b12'").get(tb2);
  assert.ok(lease);
  X.store.p("UPDATE lease SET holder = 'w-b12x' WHERE id = ?").run(lease.id);
  const rt2 = await review('w-b12x', tb2, { report_verdicts: UPHELD(a2.note) });
  const out2 = await apply(rt2);
  assert.deepStrictEqual([out2.report_verdicts.applied.length, out2.report_verdicts.refused[0].code], [0, 'E_ROLE']);
  assert.match(out2.report_verdicts.refused[0].message, /held lease/);
  assert.strictEqual(hold(a2.note).b.rev, 0);
});

test('P11: an upheld verdict on a review-verified, reported note is advice too: the note stays verified and held', async () => {
  const c = await written('w-a14', 'K14');
  mark(c.note, 'verified');
  const tc = await reported('w-b14', c.note);
  assert.ok(hold(c.note), 'held at the report, though verified');
  const o2 = await apply(await review('rev-14', tc, { report_verdicts: UPHELD(c.note) }));
  assert.deepStrictEqual([o2.report_verdicts.applied.length, hold(c.note).b.report_verdicts.length, rowOf(c.note).status], [1, 1, 'verified']);
});

test('P12: a malformed report_verdicts list is refused whole, before any note verdict is written', async () => {
  const a = await written('w-a15', 'K15');
  const good = { id: a.note, verdict: 'confirmed', cites: [cite('the loader worked as the note says')], reason: 'the stream shows it' };
  const rt = await review('rev-15', a.task, { memory_verdicts: [good], report_verdicts: {} });
  await assert.rejects(apply(rt), (e) => e.code === 'E_ARGS' && /report_verdicts/.test(e.message));
  assert.strictEqual(rowOf(a.note).status ?? 'unverified', 'unverified');
  assert.strictEqual(events('note_review').filter((e) => e.key.includes(rt)).length, 0);
  const lists = [
    new Array(17).fill(0).map((_, i) => rv(`m-${i}`, 'upheld', [cite('x')])),
    [{ id: a.note, verdict: 'maybe', cites: [], reason: 'r' }],
    [rv(a.note, 'rejected', [cite('x')]), rv(a.note, 'rejected', [cite('x')])],
    [rv(a.note, 'rejected', [cite('x')], 'r', 's:1'), rv(a.note, 'rejected', [cite('x')], 'r', 's:1')],
    [{ id: a.note, report: 7, verdict: 'rejected', cites: [cite('x')], reason: 'r' }],
  ];
  for (const [i, list] of lists.entries()) {
    const r2 = await review(`rev-15-${i}`, a.task, { memory_verdicts: [good], report_verdicts: list });
    await assert.rejects(apply(r2), (e) => e.code === 'E_ARGS', `list ${i}`);
    assert.strictEqual(rowOf(a.note).status ?? 'unverified', 'unverified');
  }
});

test('P13: two tasks reporting one note: the review of one task judges only that task\'s report; the hold carries both', async () => {
  const a = await written('w-a16', 'K16');
  await reported('w-b16', a.note, 'first report');
  const t2 = await reported('w-c16', a.note, 'second report');
  assert.deepStrictEqual([hold(a.note).b.reports.length, hold(a.note).b.reports_total], [2, 1 + 1]);
  const rt = await review('rev-16', t2, { report_verdicts: [rv(a.note, 'rejected', [cite(UP)], 'only in a test')] });
  const out = await apply(rt);
  assert.strictEqual(out.report_verdicts.applied.length, 1, JSON.stringify(out.report_verdicts));
  assert.strictEqual(bodyOf(a.note).report_rejected[0].why, 'second report');
  assert.strictEqual(bodyOf(a.note).report_judgments.length, 1);
  assert.strictEqual(hold(a.note).b.report_verdicts[0].report_key, 's:2');
});

test('P14: the rendered tail of two reports on one note (one new, one legacy) shows both keys, and verdicts built from it round-trip', async () => {
  const a = await written('w-a17', 'K17');
  const tn = await reported('w-b17', a.note, 'the new report');
  const tl = await endedTask('w-l17');
  legacyReport(a.note, 'w-l17', tl, { why: 'the legacy report' });
  const t = await call('task.create', X.orch, { spec: 'review of both', depends_on: [tn, tl], acceptance: { verdict: true } });
  const brief = await call('memory.reviewBrief', X.orch, { task_id: t.id });
  const tail = require('../../src/run/note-review-text.cjs').reviewerTail(brief, []);
  const keys = [...tail.matchAll(/ \| report (\S+) in task/g)].map((m) => m[1]);
  assert.deepStrictEqual(keys.sort(), [`l:${tl}@1001@worker:w-l17`, 's:1'].sort(), tail);
  assert.match(tail, /"report" is required, because a note is listed more than once/);
  assert.ok(Buffer.byteLength(tail) < 4096 * 2, 'the tail stays small');
  const rt = await review('rev-17', [tn, tl], { report_verdicts: keys.map((k) => rv(a.note, k.startsWith('l:') ? 'rejected' : 'upheld', [cite(k.startsWith('l:') ? 'the legacy task ran' : UP)], 'r', k)) });
  const out = await apply(rt);
  assert.strictEqual(out.report_verdicts.applied.length, 2, JSON.stringify(out.report_verdicts));
  assert.deepStrictEqual(out.report_verdicts.unjudged, []);
  assert.strictEqual(keyed(rt, a.note).length, 2, 'two keys, two receipts');
  assert.strictEqual(hold(a.note).b.report_verdicts.length, 2, 'two entries on the hold');
  assert.strictEqual(hold(a.note).b.rev, 2);
});

test('P15: two legacy reports by two reviewed tasks are judged independently: the second does not answer already', async () => {
  const a = await written('w-a18', 'K18');
  const t1 = await endedTask('w-l18a'), t2 = await endedTask('w-l18b');
  legacyReport(a.note, 'w-l18a', t1, { at: 5000 });
  legacyReport(a.note, 'w-l18b', t2, { at: 5000 }); // the same time: only the writer and task tell them apart
  const k1 = `l:${t1}@5000@worker:w-l18a`, k2 = `l:${t2}@5000@worker:w-l18b`;
  const rt = await review('rev-18', [t1, t2], { report_verdicts: [rv(a.note, 'upheld', [cite('the legacy task ran')], 'r', k1), rv(a.note, 'rejected', [cite('the legacy task ran')], 'r', k2)] });
  const out = await apply(rt);
  assert.deepStrictEqual([out.report_verdicts.applied.length, out.report_verdicts.already.length], [2, 0], JSON.stringify(out.report_verdicts));
  const b = bodyOf(a.note);
  assert.deepStrictEqual(b.report_judgments.map((j) => [j.report_key, j.verdict]), [[k1, 'upheld'], [k2, 'rejected']]);
  assert.strictEqual(RM.standing(b).map(RM.reportKey).includes(k2), false, 'only the rejected one stops standing');
});

test('P16: an older per-note receipt answers already for the one report its judgment names, never for the others on the note', async () => {
  const a = await written('w-a19', 'K19');
  const t1 = await endedTask('w-l19a'), t2 = await endedTask('w-l19b');
  legacyReport(a.note, 'w-l19a', t1, { at: 6000 });
  legacyReport(a.note, 'w-l19b', t2, { at: 6001 });
  const k1 = `l:${t1}@6000@worker:w-l19a`, k2 = `l:${t2}@6001@worker:w-l19b`;
  const rt = await review('rev-19', [t1, t2], { report_verdicts: [rv(a.note, 'upheld', [cite('the legacy task ran')], 'r', k1), rv(a.note, 'upheld', [cite('the legacy task ran')], 'r', k2)] });
  const task = await call('task.get', X.orch, { task_id: rt });
  const oldKey = `review:${rt}@${task.handoff.at}:report:${a.note}`;
  await call('memory.recordEvent', X.harness, { kind: 'note_review', ok: true, key: oldKey, row_ids: [a.note], worker_id: 'rev-19', message: 'report upheld (older receipt)' });
  X.store.patchBody(a.note, (b) => { b.report_judgments = [...(b.report_judgments || []), { task_id: t1, report_at: 6000, verdict: 'upheld', ref: rt, by: 'rev-19', at: 1 }]; return b; });
  const out = await apply(rt);
  assert.deepStrictEqual([out.report_verdicts.already.map((x) => x.report), out.report_verdicts.applied.map((x) => x.report)], [[k1], [k2]], JSON.stringify(out.report_verdicts));
});

test('P17: a verdict with no report key on a note listed twice is E_ARGS naming the keys; with one open report the key may be left out', async () => {
  const a = await written('w-a20', 'K20');
  const t1 = await reported('w-b20a', a.note, 'first');
  const t2 = await reported('w-b20b', a.note, 'second');
  const rt = await review('rev-20', [t1, t2], { report_verdicts: [rv(a.note, 'rejected', [cite(UP)])] });
  const out = await apply(rt);
  assert.strictEqual(out.report_verdicts.refused[0].code, 'E_ARGS');
  assert.match(out.report_verdicts.refused[0].message, /name one in "report" \(s:1, s:2\)/);
  const b = await written('w-a21', 'K21');
  const t3 = await reported('w-b21', b.note);
  const ok = await apply(await review('rev-21', t3, { report_verdicts: [rv(b.note, 'rejected', [cite(UP)])] }));
  assert.strictEqual(ok.report_verdicts.applied.length, 1);
});

test('P18: a self-report is held, listed, and judged by an independent reviewer; the writer is refused as its own reviewer', async () => {
  const a = await written('w-a22', 'K22');
  const tself = await reported('w-a22', a.note, 'I was wrong about this');
  const h = hold(a.note);
  assert.deepStrictEqual([h.b.self_report, h.b.reports[0].self_report], [true, true]);
  const brief = await briefOf(tself);
  assert.deepStrictEqual([brief.reports.length, brief.reports[0].report.self_report], [1, true]);
  assert.match(require('../../src/run/note-review-text.cjs').reviewerTail(brief, []), /reported wrong by its own writer/);
  const refused = await apply(await review('w-a22', tself, { report_verdicts: UPHELD(a.note) }));
  assert.strictEqual(refused.report_verdicts.refused[0].code, 'E_ROLE');
  const ok = await apply(await review('rev-22', tself, { report_verdicts: UPHELD(a.note) }));
  assert.strictEqual(ok.report_verdicts.applied.length, 1, JSON.stringify(ok.report_verdicts));
  assert.strictEqual(hold(a.note).b.report_verdicts.length, 1);
});

test('P19: an upheld verdict on a note with no hold (older data) writes the hold with the verdict on it; a rejected one writes none', async () => {
  const a = await written('w-a23', 'K23');
  const t1 = await endedTask('w-l23');
  legacyReport(a.note, 'w-l23', t1);
  assert.strictEqual(hold(a.note), null);
  const out = await apply(await review('rev-23', t1, { report_verdicts: [rv(a.note, 'upheld', [cite('the legacy task ran')])] }));
  assert.strictEqual(out.report_verdicts.applied.length, 1, JSON.stringify(out.report_verdicts));
  assert.strictEqual(out.report_verdicts.applied[0].held.created, true);
  const h = hold(a.note);
  assert.deepStrictEqual([h.b.ground, h.b.report_verdicts.length, h.b.rev, h.b.reports.length], ['reported', 1, 1, 1]);
  assert.ok(bodyOf(a.note).held);
});

test('P20: a task reviewer\'s note verdict on a held note is advice on the hold: the status is unchanged, the hold\'s revision rises', async () => {
  const a = await written('w-a24', 'K24');
  await reported('w-b24', a.note);
  const h0 = hold(a.note);
  for (const [r, verdict, quote] of [['rev-24a', 'refuted', 'the loader worked as the note says'], ['rev-24b', 'confirmed', 'the loader worked as the note says']]) {
    const rt = await review(r, a.task, { memory_verdicts: [{ id: a.note, verdict, cites: [cite(quote)], reason: 'what the stream shows' }] });
    const out = await apply(rt);
    assert.strictEqual(out.applied.length, 1, JSON.stringify(out));
    assert.deepStrictEqual([out.applied[0].advice, out.applied[0].held_row, out.applied[0].status], [true, h0.id, 'unverified']);
  }
  assert.strictEqual(rowOf(a.note).status ?? 'unverified', 'unverified');
  const h1 = hold(a.note);
  assert.deepStrictEqual([h1.b.note_verdicts.map((v) => v.verdict), h1.b.rev, h1.b.state], [['refuted', 'confirmed'], 2, 'held']);
  assert.strictEqual(events('note_refuted').filter((e) => e.key === `refuted:${a.note}`).length, 0, 'no wake: nothing was refuted');
  const free = await written('w-a25', 'K25');
  const ok = await apply(await review('rev-25', free.task, { memory_verdicts: [{ id: free.note, verdict: 'confirmed', cites: [cite('the loader worked as the note says')], reason: 'the stream shows it' }] }));
  assert.strictEqual(rowOf(free.note).status, 'verified', 'an unheld note is judged as ever');
  assert.ok(ok.applied[0].status === 'verified');
});

test('P21: two applications of one review of a held note in flight write one advice entry and advance the hold once', async () => {
  const a = await written('w-a26', 'K26');
  await reported('w-b26', a.note);
  const rt = await review('rev-26', a.task, { memory_verdicts: [{ id: a.note, verdict: 'refuted', cites: [cite('the loader worked as the note says')], reason: 'what the stream shows' }] });
  const CC = require('../../src/core/memory-citations.cjs');
  let n = 0;
  let open; const gate = new Promise((r) => { open = r; });
  CC.seam.afterCheck = async () => { n += 1; if (n === 1) await gate; else open(); }; // the first call waits until the second has also passed its check
  try {
    const [x, y] = await Promise.all([apply(rt), apply(rt)]);
    assert.strictEqual(x.applied.length + y.applied.length, 1, JSON.stringify([x, y]));
    assert.strictEqual(x.already.length + y.already.length, 1);
  } finally { CC.seam.afterCheck = null; open(); }
  assert.deepStrictEqual([hold(a.note).b.note_verdicts.length, hold(a.note).b.rev], [1, 1], 'one entry, one revision');
});

// Two applications of one review whose citation checks interleave: the first waits at the seam until the second has passed its own check.
async function twice(rt) {
  const CC = require('../../src/core/memory-citations.cjs');
  let n = 0, open; const gate = new Promise((r) => { open = r; });
  CC.seam.afterCheck = async () => { n += 1; if (n === 1) await gate; else open(); };
  try { return await Promise.all([apply(rt), apply(rt)]); } finally { CC.seam.afterCheck = null; open(); }
}

test('P22: two applications of one review of an unheld note write one receipt and one status change (applyOneIn rechecks its receipt in the transaction)', async () => {
  const a = await written('w-a27', 'K27');
  const rt = await review('rev-27', a.task, { memory_verdicts: [{ id: a.note, verdict: 'confirmed', cites: [cite('the loader worked as the note says')], reason: 'what the stream shows' }] });
  const [x, y] = await twice(rt);
  assert.strictEqual(x.applied.length + y.applied.length, 1, JSON.stringify([x, y]));
  assert.strictEqual(x.already.length + y.already.length, 1);
  assert.strictEqual(events('note_review').filter((e) => e.ok === 1 && e.key.includes(rt) && e.key.endsWith(':' + a.note)).length, 1, 'one receipt');
  assert.strictEqual(rowOf(a.note).status, 'verified');
});

test('P23: two applications of one unsupported verdict queue the note once (queueUnsupported rechecks its receipt in the transaction)', async () => {
  const a = await written('w-a28', 'K28');
  const rt = await review('rev-28', a.task, { memory_verdicts: [{ id: a.note, verdict: 'unsupported', cites: [cite('the loader worked as the note says')], reason: 'no single place proves it' }] });
  const [x, y] = await twice(rt);
  assert.strictEqual(x.applied.length + y.applied.length, 1, JSON.stringify([x, y]));
  assert.strictEqual(x.already.length + y.already.length, 1);
  assert.strictEqual(X.heldRows(a.note).length, 1, 'one queue row');
  assert.strictEqual(events('note_review').filter((e) => e.ok === 1 && e.key.includes(rt) && e.key.endsWith(':' + a.note)).length, 1);
});
