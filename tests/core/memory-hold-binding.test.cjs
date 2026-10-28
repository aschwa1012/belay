'use strict';
// memory-hold-binding.test.cjs — the archive review's verdicts on a held note: bound to the hold row and revision they were offered, and the three
// outcomes for a warning hold (archive on cites, release only on cites that show the note correct, undecided). Real core against a sandbox store,
// real stream files and a real git repository. Every interleaving is forced by the citation check's own seam, never a sleep.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { setup } = require('./report-env.cjs');
const CC = require('../../src/core/memory-citations.cjs');

let X;
before(async () => { X = await setup('r-bind'); });
after(() => X.cleanup());

const hold = (id) => X.activeHold(id);
const streamOf = (w) => `${X.dir}/workers/${w}/stream.jsonl`.replace(/\\/g, '/');
const LINE_OK = 'the loader worked as the note says'; // in the writer's stream: shows the note correct
const LINE_BAD = 'fixtures/unlisted.json was opened by the loader'; // in the reporter's stream: shows the report's claim
const apply = (verdicts, files = []) => X.call('memory.reviewApply', X.harness, { verdicts, evidence_files: files, head_sha: X.head, worktree: X.repo });
const queue = () => X.call('memory.reviewQueue', X.harness, {});
const entryOf = async (id) => (await queue()).held.find((h) => h.id === id);
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
// A reported note: written by `w`, reported by `wb`. Returns { note, hold, reporterStream, writerStream }.
async function reportedNote(w, marker, wb) {
  const a = await X.written(w, marker);
  const tb = await X.reported(wb, a.note);
  return { ...a, tb, hold: hold(a.note), writerStream: streamOf(w), reporterStream: streamOf(wb) };
}
const archiveV = (r, over = {}) => ({ id: r.note, verdict: 'archive', reason: 'the stream shows it is wrong', cites: [{ where: `stream:${r.reporterStream}`, quote: LINE_BAD }], ...over });
const releaseV = (r, over = {}) => ({ id: r.note, verdict: 'release', reason: 'the stream shows it is correct', cites: [{ where: `stream:${r.writerStream}`, quote: LINE_OK }], ...over });
const refusedOn = (id) => hold(id).b.reviews.filter((x) => x.outcome === 'refused');

test('B1: an archive whose citation check is in flight when a report appends is refused: the hold stays held at the new revision, the refusal is on the row', async () => {
  const r = await reportedNote('w-a1', 'K1', 'w-b1');
  const gate = defer(), reached = defer();
  CC.seam.afterCheck = async () => { CC.seam.afterCheck = null; reached.resolve(); await gate.promise; };
  try {
    const p = apply([archiveV(r, { held_row: r.hold.id, rev: 0 })], [r.reporterStream]);
    await reached.promise; // the cites were read; the write has not begun
    await X.reported('w-c1', r.note, 'a second report arrives'); // rev 1
    gate.resolve();
    const out = await p;
    assert.deepStrictEqual([out.applied.length, out.refused[0].outcome, out.refused[0].code], [0, 'refused', 'E_PRECONDITION'], JSON.stringify(out));
    assert.deepStrictEqual([out.refused[0].detail.offered_rev, out.refused[0].detail.current_rev, out.refused[0].detail.offered_row, out.refused[0].detail.current_row], [0, 1, r.hold.id, r.hold.id]);
  } finally { CC.seam.afterCheck = null; gate.resolve(); }
  assert.strictEqual(X.rowOf(r.note).namespace, 'project/acme');
  const h = hold(r.note);
  assert.deepStrictEqual([h.b.state, h.b.rev, refusedOn(r.note).length], ['held', 1, 1]);
  assert.strictEqual((await entryOf(r.note)).rev, 1, 'the next review is offered the current revision');
});

test('B2: an unsupported verify in flight while a report merges its queue row is refused: the status is unchanged, the reported hold is active', async () => {
  const a = await X.written('w-a2', 'K2');
  const q = X.store.storeIn({ namespace: 'held/acme', worker_id: 'harness', type: 'held', text: `queued ${a.note}`, title: 'q', body: { state: 'held', note_id: a.note, kind: 'unsupported', ground: 'unsupported', reason: 'cannot say', run_id: 'r-bind', head_sha: X.head, cites: [], reviews: [] }, run_id: 'r-bind', source: 'harness', written_by: 'harness' });
  X.store.patchBody(a.note, (b) => { b.unsupported = { held_row: q.id, state: 'open', by: 'rev', ref: 'rt', at: 1 }; return b; });
  const shown = require('../../src/core/note-brief-capture.cjs').hashOfRow(X.rowOf(a.note));
  const gate = defer(), reached = defer();
  CC.seam.afterCheck = async () => { CC.seam.afterCheck = null; reached.resolve(); await gate.promise; };
  try {
    const p = apply([{ id: a.note, verdict: 'verify', reason: 'the code supports it', cites: [{ where: 'loader.js', quote: "module.exports = function load() { return 'reads unlisted fixtures'; };" }], held_row: q.id, rev: 0, shown_hash: shown }]);
    await reached.promise;
    await X.reported('w-b2', a.note); // merges the queue row into a reported hold
    gate.resolve();
    const out = await p;
    assert.deepStrictEqual([out.applied.length, out.refused[0].code], [0, 'E_PRECONDITION'], JSON.stringify(out));
  } finally { CC.seam.afterCheck = null; gate.resolve(); }
  assert.strictEqual(X.rowOf(a.note).status ?? 'unverified', 'unverified');
  assert.strictEqual(hold(a.note).b.ground, 'reported');
  assert.strictEqual(X.heldRows(a.note).find((x) => x.id === q.id).b.state, 'merged');
});

test('B3: a verdict for another revision or row is refused at the first read; a release or undecided of a reported hold with no rev is refused', async () => {
  const r = await reportedNote('w-a3', 'K3', 'w-b3');
  await X.reported('w-c3', r.note, 'second'); // rev 1
  let out = await apply([archiveV(r, { rev: 0 })], [r.reporterStream]);
  assert.deepStrictEqual([out.refused[0].code, out.refused[0].detail.offered_rev, out.refused[0].detail.current_rev], ['E_PRECONDITION', 0, 1]);
  out = await apply([archiveV(r, { held_row: 'a-merged-row', rev: 1 })], [r.reporterStream]);
  assert.strictEqual(out.refused[0].code, 'E_PRECONDITION');
  for (const verdict of ['release', 'undecided']) {
    out = await apply([{ id: r.note, verdict, reason: 'x', cites: [{ where: `stream:${r.writerStream}`, quote: LINE_OK }] }], [r.writerStream]);
    assert.strictEqual(out.refused[0].code, 'E_PRECONDITION', verdict);
    assert.match(out.refused[0].message, /must carry the rev it saw/);
  }
  assert.strictEqual(hold(r.note).b.state, 'held');
  assert.ok(refusedOn(r.note).length >= 4, 'every refusal is on the row');
});

test('B4: an archive on cites archives', async () => {
  const r = await reportedNote('w-a4', 'K4', 'w-b4');
  const out = await apply([archiveV(r, { held_row: r.hold.id, rev: 0 })], [r.reporterStream]);
  assert.strictEqual(out.applied[0].outcome, 'archived', JSON.stringify(out.refused));
  assert.strictEqual(X.rowOf(r.note).namespace, 'archive/acme');
});

test('B5: a release on cites that show the note correct verifies it, settles every report and ends the hold; without cites, with a failing cite, or with no shown_hash it is refused', async () => {
  const r = await reportedNote('w-a5', 'K5', 'w-b5');
  await X.reported('w-c5', r.note, 'second report');
  const st0 = hold(r.note).b.state; // held, or queued once this file's run is past its breaker
  const e = await entryOf(r.note);
  assert.ok(e.shown_hash && e.outcomes.includes('undecided'));
  const base = { held_row: e.held_row, rev: e.rev, shown_hash: e.shown_hash };
  let out = await apply([releaseV(r, { ...base, cites: [] })], [r.writerStream]);
  assert.strictEqual(out.refused[0].code, 'E_CITATION', 'a release without cites');
  out = await apply([releaseV(r, { ...base, cites: [{ where: `stream:${r.writerStream}`, quote: 'a line nobody printed' }] })], [r.writerStream]);
  assert.strictEqual(out.refused[0].code, 'E_CITATION', 'a failing cite');
  out = await apply([releaseV(r, { held_row: e.held_row, rev: e.rev })], [r.writerStream]);
  assert.strictEqual(out.refused[0].code, 'E_PRECONDITION', 'no shown_hash');
  assert.match(out.refused[0].message, /did not bind it/);
  assert.strictEqual(hold(r.note).b.state, st0, 'the hold stays as it was');
  assert.strictEqual(X.rowOf(r.note).status ?? 'unverified', 'unverified');
  out = await apply([releaseV(r, base)], [r.writerStream]);
  const a = out.applied[0];
  assert.deepStrictEqual([a.outcome, a.status, a.settled.count], ['released', 'verified', 2], JSON.stringify(out.refused));
  const n = X.rowOf(r.note);
  assert.deepStrictEqual([n.status, n.status_receipt], ['verified', `review:r-bind:${e.held_row}`]);
  const b = X.bodyOf(r.note);
  assert.deepStrictEqual([b.held, b.reports_settled.slice().sort()], [undefined, ['s:1', 's:2']]);
  assert.strictEqual(X.heldRows(r.note).find((x) => x.id === e.held_row).b.state, 'released');
  assert.strictEqual(await X.heldCount() >= 0, true);
});

test('B6: a release of a refuted note, whose verification applyOneIn refuses, is refused and the hold stays', async () => {
  const r = await reportedNote('w-a6', 'K6', 'w-b6');
  const st0 = hold(r.note).b.state;
  const e = await entryOf(r.note);
  X.store.p("UPDATE memory_entries SET status = 'refuted' WHERE id = ?").run(r.note);
  const out = await apply([releaseV(r, { held_row: e.held_row, rev: e.rev, shown_hash: require('../../src/core/note-brief-capture.cjs').hashOfRow(X.rowOf(r.note)) })], [r.writerStream]);
  assert.strictEqual(out.refused[0].code, 'E_PRECONDITION');
  assert.match(out.refused[0].message, /cannot be verified/);
  assert.strictEqual(hold(r.note).b.state, st0, 'the hold stays as it was');
});

test('B7: undecided leaves the hold held and counted, the warning on, and the entry out of the next queue (listed as awaiting the operator)', async () => {
  const r = await reportedNote('w-a7', 'K7', 'w-b7');
  const st0 = hold(r.note).b.state;
  const n0 = await X.heldCount();
  const e = await entryOf(r.note);
  const out = await apply([{ id: r.note, verdict: 'undecided', reason: 'the evidence settles neither way', held_row: e.held_row, rev: e.rev }]);
  assert.deepStrictEqual([out.applied[0].outcome, out.applied[0].rev], ['undecided', 0], JSON.stringify(out.refused));
  const h = hold(r.note);
  assert.deepStrictEqual([h.b.state, h.b.rev, h.b.undecided.rev, h.b.undecided.reason], [st0, 0, 0, 'the evidence settles neither way']);
  assert.ok(X.bodyOf(r.note).held, 'the warning stays');
  assert.strictEqual(await X.heldCount(), n0, 'still counted');
  const q = await queue();
  assert.ok(!q.held.some((x) => x.id === r.note));
  assert.deepStrictEqual([q.awaiting_operator.some((x) => x.id === r.note), q.counts.awaiting_operator >= 1], [true, true]);
  const listing = await X.call('memory.held', X.orch, { list: true, awaiting: true });
  assert.ok(listing.entries.some((x) => x.note_id === r.note && x.awaiting_operator && x.undecided.reason));
  assert.ok(listing.awaiting_operator >= 1);
});

test('B8: a new report, a task reviewer verdict on a report, or a note verdict on the note offers an undecided hold to the review again', async () => {
  for (const [i, how] of ['report', 'report_verdict', 'note_verdict'].entries()) {
    const r = await reportedNote(`w-a8${i}`, `K${10 + i}`, `w-b8${i}`);
    const e = await entryOf(r.note);
    await apply([{ id: r.note, verdict: 'undecided', reason: 'x', held_row: e.held_row, rev: e.rev }]);
    assert.ok(!(await entryOf(r.note)), `${how}: awaiting the operator`);
    if (how === 'report') await X.reported(`w-c8${i}`, r.note, 'again');
    else if (how === 'report_verdict') await X.apply(await X.review(`rev-8${i}`, r.tb, { report_verdicts: [X.rv(r.note, 'rejected', [X.cite(X.UP)])] }));
    else await X.apply(await X.review(`rev-8${i}`, r.task, { memory_verdicts: [{ id: r.note, verdict: 'confirmed', cites: [X.cite(LINE_OK)], reason: 'what the stream shows' }] }));
    const again = await entryOf(r.note);
    assert.ok(again && again.rev === e.rev + 1, `${how}: offered again at the next revision`);
  }
});

test('B9: a scrubber duplicate hold still releases without cites; a queued unsupported row keeps still_unsupported', async () => {
  const a = await X.written('w-a9', 'K20');
  const kept = await X.written('w-k9', 'K21');
  const dup = X.store.storeIn({ namespace: 'held/acme', worker_id: 'harness', type: 'held', text: `held duplicate ${a.note}`, title: 'd', body: { state: 'held', note_id: a.note, kind: 'duplicate', of: kept.note, ground: 'same_claim', reason: 'same claim', run_id: 'r-bind', cites: [], reviews: [] }, run_id: 'r-bind', source: 'harness', written_by: 'harness' });
  X.store.patchBody(a.note, (b) => { b.held = { row: dup.id, kind: 'duplicate', of: kept.note, reason: 'same', run_id: 'r-bind', at: 1 }; return b; });
  const out = await apply([{ id: a.note, verdict: 'release', reason: 'the two notes do not make the same claim' }]);
  assert.strictEqual(out.applied[0].outcome, 'released', JSON.stringify(out.refused));
  assert.strictEqual(X.rowOf(a.note).status ?? 'unverified', 'unverified', 'a duplicate\'s release verifies nothing');
  const b = await X.written('w-b9', 'K22');
  const q = X.store.storeIn({ namespace: 'held/acme', worker_id: 'harness', type: 'held', text: `queued ${b.note}`, title: 'q', body: { state: 'held', note_id: b.note, kind: 'unsupported', ground: 'unsupported', reason: 'cannot say', run_id: 'r-bind', cites: [], reviews: [] }, run_id: 'r-bind', source: 'harness', written_by: 'harness' });
  X.store.patchBody(b.note, (x) => { x.unsupported = { held_row: q.id, state: 'open', by: 'rev', ref: 'rt', at: 1 }; return x; });
  const o2 = await apply([{ id: b.note, verdict: 'still_unsupported', reason: 'the evidence does not settle it' }]);
  assert.strictEqual(o2.applied[0].outcome, 'still_unsupported', JSON.stringify(o2.refused));
  const o3 = await apply([{ id: b.note, verdict: 'undecided', reason: 'x' }]);
  assert.strictEqual(o3.refused[0].code, 'E_NOT_FOUND', 'the queue row is settled');
});

test('B10: the entry carries the whole note and its shown_hash when an outcome would verify it: six evidence entries, the sixth false, and text past the old cut', async () => {
  const s = await X.startTask('w-a10', 'the loader worked as the note says\n');
  const n = { ...X.note('K23'), evidence: [1, 2, 3, 4, 5, 6].map((i) => ({ where: `src/part-${i}.js`, saw: i === 6 ? 'the sixth entry is the false claim' : `entry ${i} of the loader evidence` })) };
  const rel = await X.call('lease.release', X.worker('w-a10'), { lease_id: s.lease, notes: [n] });
  await X.call('task.evaluate', X.orch, { task_id: s.task, worktree: X.dir });
  const id = rel.notes[0].id;
  const longText = `${X.rowOf(id).text}\n${'x'.repeat(1700)} the claim past the old 1,500-byte cut`;
  X.store.p('UPDATE memory_entries SET text = ? WHERE id = ?').run(longText, id);
  await X.reported('w-b10', id);
  const e = await entryOf(id);
  assert.strictEqual(e.note.evidence.length, 6, 'all six evidence entries');
  assert.strictEqual(e.note.evidence[5].saw, 'the sixth entry is the false claim');
  assert.strictEqual(e.note.text, longText, 'the whole text, past the old cut');
  assert.match(e.shown_hash, /^[0-9a-f]{16}$/);
  const sOk = streamOf('w-a10');
  const bound = { id, verdict: 'release', reason: 'shown correct', cites: [{ where: `stream:${sOk}`, quote: LINE_OK }], held_row: e.held_row, rev: e.rev };
  // patched after the brief: the hash changed, so the release is refused
  X.store.p("UPDATE memory_entries SET text = text || ' and a later edit' WHERE id = ?").run(id);
  let out = await apply([{ ...bound, shown_hash: e.shown_hash }], [sOk]);
  assert.strictEqual(out.refused[0].code, 'E_PRECONDITION');
  assert.match(out.refused[0].message, /changed after the brief showed it/);
  // a fresh queue entry binds the current note, and that release verifies
  const e2 = await entryOf(id);
  out = await apply([{ ...bound, shown_hash: e2.shown_hash }], [sOk]);
  assert.strictEqual(out.applied[0].status, 'verified', JSON.stringify(out.refused));
});

test('B11: an archive of a superseded hold whose replacement was archived meanwhile archives as wrong, with kind_changed on the row', async () => {
  const s0 = await X.startTask('w-o11', 'the loader worked as the note says\n');
  const nOld = { ...X.note('K24'), applies_to: ['router'], subjects: ['router'] };
  const rOld = await X.call('lease.release', X.worker('w-o11'), { lease_id: s0.lease, notes: [nOld] });
  const s1 = await X.startTask('w-a11', 'the loader worked as the note says\n');
  const nNew = { ...X.note('K25'), applies_to: ['router'], subjects: ['router'] };
  const rNew = await X.call('lease.release', X.worker('w-a11'), { lease_id: s1.lease, notes: [nNew] });
  const oldId = rOld.notes[0].id, id = rNew.notes[0].id;
  await X.reported('w-b11', id, 'replaced by the older note', { replaced_by: oldId });
  assert.strictEqual(hold(id).b.kind, 'superseded');
  const e = await entryOf(id);
  // the replacement leaves the project meanwhile
  require('../../src/core/held-guard.cjs').runAs(X.operator, () => X.store.moveRow(oldId, 'project/acme', 'archive/acme'));
  const out = await apply([{ id, verdict: 'archive', reason: 'wrong', cites: [{ where: `stream:${streamOf('w-b11')}`, quote: LINE_BAD }], held_row: e.held_row, rev: e.rev }], [streamOf('w-b11')]);
  assert.strictEqual(out.applied[0].outcome, 'archived', JSON.stringify(out.refused));
  assert.strictEqual(out.applied[0].kind_changed, 'superseded->wrong');
  assert.strictEqual(X.bodyOf(id).archived.kind, 'wrong');
  assert.strictEqual(X.bodyOf(id).archived.kind_changed, 'superseded->wrong');
});
