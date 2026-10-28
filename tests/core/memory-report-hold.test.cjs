'use strict';
// memory-report-hold.test.cjs — a report that a note is wrong holds the note at once, in the transaction of the release that carries the report.
// Every case drives a real `lease.release` through commit(), holdReported and the shared hold writer (never holdReported alone), and reads back
// the rows: the hold (written by the harness, the report by the worker), the pointer on the note, the proof the release returns, the held count.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./report-env.cjs');
const { teardown } = require('../helpers/teardown.cjs');
const F = require('../../src/core/memory-facts.cjs');
const HG = require('../../src/core/held-guard.cjs');

let X, X2;
before(async () => {
  X = await setup('r-hold');
  try { X2 = await setup('r-hold2', { notes_reflection: true }); } catch (e) { await X.cleanup(); throw e; }
});
after(() => teardown(null, [() => X.cleanup(), () => X2.cleanup()]));

const hold = (id) => X.activeHold(id);
const total = () => X.heldCount();
const entryOf = () => X.reported.last.reported_wrong[0];
// A note written with chosen shared paths/subjects (so two notes can be "about the same thing").
async function writtenAbout(w, marker, shared) {
  const s = await X.startTask(w, 'the loader worked as the note says\n');
  const n = { ...X.note(marker), applies_to: [shared], subjects: [shared] };
  const out = await X.call('lease.release', X.worker(w), { lease_id: s.lease, notes: [n] });
  await X.call('task.evaluate', X.orch, { task_id: s.task, worktree: X.dir });
  return { task: s.task, note: out.notes[0].id };
}
// Plants a held row (and the pointer) for a note, as another writer of holds would have left it.
function plant(noteId, body, pointer = true) {
  const row = X.store.storeIn({ namespace: 'held/acme', worker_id: 'harness', type: 'held', text: `held ${body.kind} ${noteId} ${Math.random()}`, title: `held ${body.kind}`, body: { state: 'held', note_id: noteId, run_id: 'r-hold', reviews: [], cites: [], ...body }, run_id: 'r-hold', source: 'harness', written_by: 'harness' });
  if (pointer) X.store.patchBody(noteId, (b) => { b.held = { row: row.id, kind: body.kind, of: body.of || null, reason: 'planted', run_id: 'r-hold', at: 1 }; return b; });
  return row.id;
}

test('H1: a first report holds the note in the same release: the proof names the hold, the harness wrote it, the worker wrote the report', async () => {
  const a = await X.written('w-a1', 'K1');
  const n0 = await total();
  const tb = await X.reported('w-b1', a.note, 'the loader reads unlisted fixtures');
  const e = entryOf();
  const h = hold(a.note);
  assert.deepStrictEqual([e.id, e.marked, e.held.row, e.held.kind, e.held.rev], [a.note, 'reported_wrong', h.id, 'wrong', 0]);
  assert.strictEqual(await total(), n0 + 1, 'the held count rises by one');
  const row = X.rowOf(h.id);
  assert.deepStrictEqual([row.namespace, row.type, row.written_by], ['held/acme', 'held', 'harness']);
  assert.deepStrictEqual([h.b.ground, h.b.kind, h.b.state, h.b.rev, h.b.reports.length, h.b.reports[0].by, h.b.reports[0].task_id, h.b.reports[0].key], ['reported', 'wrong', 'held', 0, 1, 'worker:w-b1', tb, 's:1']);
  assert.strictEqual(h.b.head_sha, X.head, 'the reporting task\'s head');
  const nb = X.bodyOf(a.note);
  assert.deepStrictEqual([nb.held.row, nb.report_seq, nb.reported_wrong[0].by, nb.reported_wrong[0].seq], [h.id, 1, 'worker:w-b1', 1]);
  assert.strictEqual(X.rowOf(a.note).namespace, 'project/acme', 'the note stays live and visible');
  // what checkHoldFacts was given is what is stored: the same call on the stored body gives the stored facts
  const again = F.checkHoldFacts(X.E, 'acme', F.loadNote(X.E, a.note), h.b.kind, h.b.of, 'reported', 0.8, 'r-hold', h.b);
  assert.deepStrictEqual(again, h.b.facts);
});

test('H2: the writer reporting its own note holds it too (a self-report), with the flag on the report and the hold', async () => {
  const a = await X.written('w-a2', 'K2');
  await X.reported('w-a2', a.note, 'I got this wrong');
  const h = hold(a.note);
  assert.ok(h, 'held');
  assert.deepStrictEqual([h.b.self_report, h.b.reports[0].self_report, h.b.facts.trigger], [true, true, 'report']);
});

test('H3: a second report appends to the one hold (same row, revision up, held count unchanged); a writer\'s repeat replaces its own report', async () => {
  const a = await X.written('w-a3', 'K3');
  await X.reported('w-b3', a.note, 'first');
  const h0 = hold(a.note);
  const n1 = await total();
  await X.reported('w-c3', a.note, 'second');
  const e = entryOf();
  assert.deepStrictEqual([e.held.row, e.held.already_held, e.held.rev], [h0.id, true, 1]);
  const h1 = hold(a.note);
  assert.deepStrictEqual([h1.b.reports.map((r) => r.why), h1.b.reports_total, h1.b.rev], [['first', 'second'], 2, 1]);
  assert.strictEqual(await total(), n1, 'appending adds no count');
  assert.strictEqual(X.heldRows(a.note).length, 1);
  await X.reported('w-b3', a.note, 'first again');
  const h2 = hold(a.note);
  assert.deepStrictEqual([h2.b.reports.map((r) => r.why).sort(), h2.b.reports_total, h2.b.rev], [['first again', 'second'], 2, 2]);
  assert.deepStrictEqual(X.bodyOf(a.note).reported_wrong.map((r) => r.seq), [2, 3], 'the repeat took the next number');
  assert.strictEqual(h2.b.reason, 'first again', 'a repeat replaces the text of the hold too');
});

test('H4: a report on a note held for another reason merges that hold into one reported hold, counted once, with the prior on it', async () => {
  const kept = await X.written('w-k4', 'K4');
  const cases = {
    scrubber_duplicate: { kind: 'duplicate', of: kept.note, ground: 'same_claim', reason: 'same claim' },
    write_time_superseded: { kind: 'superseded', relation: 'refines', of: kept.note, ground: 'replaced_by_newer', reason: 'resolved as refines' },
    report_confirmed: { kind: 'wrong', of: null, ground: 'report_confirmed', reason: 'upheld', report: { by: 'worker:w-old', task_id: 't-old', why: 'old', at: 1, upheld_by: 'rev', ref: 'rt' } },
  };
  let ci = 0;
  for (const [name, body] of Object.entries(cases)) {
    ci += 1;
    const a = await X.written(`w-a4${ci}`, `K2${ci}`);
    const old = plant(a.note, body);
    const n0 = await total();
    await X.reported(`w-b4${ci}`, a.note, `report on a ${name} hold`);
    const e = entryOf();
    const h = hold(a.note);
    assert.deepStrictEqual([h.id !== old, e.held.merged, h.b.ground, h.b.prior_hold.row, h.b.prior_hold.kind, h.b.prior_hold.ground], [true, old, 'reported', old, body.kind, body.ground], name);
    const oldRow = X.heldRows(a.note).find((r) => r.id === old);
    assert.deepStrictEqual([oldRow.b.state, oldRow.b.merged_into, oldRow.b.rev], ['merged', h.id, 1], name);
    assert.strictEqual(await total(), n0, `${name}: counted once`);
    assert.strictEqual(X.bodyOf(a.note).held.row, h.id);
  }
});

test('H5: an open unsupported queue row is merged into the reported hold too', async () => {
  const a = await X.written('w-a5', 'K5');
  const old = plant(a.note, { kind: 'unsupported', of: null, ground: 'unsupported', reason: 'no single place proves it' }, false);
  X.store.patchBody(a.note, (b) => { b.unsupported = { held_row: old, state: 'open', by: 'rev', ref: 'rt', at: 1 }; return b; });
  const n0 = await total();
  await X.reported('w-b5', a.note);
  const h = hold(a.note);
  assert.deepStrictEqual([h.b.ground, h.b.prior_hold.kind, X.bodyOf(a.note).unsupported.state, X.heldRows(a.note).find((r) => r.id === old).b.state], ['reported', 'unsupported', 'merged', 'merged']);
  assert.strictEqual(await total(), n0, 'the queue row and the hold are one count');
});

test('H6: a pointer that names a hold which is no longer active gets a fresh hold, naming the old row', async () => {
  const a = await X.written('w-a6', 'K6');
  X.store.patchBody(a.note, (b) => { b.held = { row: 'a-row-that-is-gone', kind: 'wrong', of: null, reason: 'x', run_id: 'r', at: 1 }; return b; });
  await X.reported('w-b6', a.note);
  const e = entryOf();
  const h = hold(a.note);
  assert.deepStrictEqual([e.held.replaced_stale_pointer, h.b.replaced_stale_pointer, X.bodyOf(a.note).held.row], ['a-row-that-is-gone', 'a-row-that-is-gone', h.id]);
});

test('H7: a refuted note, or one replaced by another note, is held like any other', async () => {
  const a = await X.written('w-a7', 'K7');
  X.store.p("UPDATE memory_entries SET status = 'refuted' WHERE id = ?").run(a.note);
  await X.reported('w-b7', a.note);
  assert.ok(hold(a.note));
  assert.strictEqual(hold(a.note).b.facts.status, 'refuted');
});

test('H8: the report text is redacted once: on the note, the hold, the index line and the proof, on a first report and on an append', async () => {
  const a = await X.written('w-a8', 'K8');
  const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  await X.reported('w-b8', a.note, `it leaks ${secret} into the log`);
  const first = entryOf();
  assert.strictEqual(first.redacted, 1);
  await X.reported('w-c8', a.note, `and again ${secret} here`);
  assert.strictEqual(entryOf().redacted, 1);
  const raw = JSON.stringify([X.rowOf(a.note), X.heldRows(a.note), X.reported.last]);
  assert.ok(!raw.includes('a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'), 'the secret is nowhere in the note, the hold or the proof');
  assert.deepStrictEqual(X.bodyOf(a.note).reported_wrong.map((r) => r.why.includes('[REDACTED:github_token]')), [true, true]);
  assert.ok(hold(a.note).b.reports.every((r) => r.why.includes('[REDACTED:github_token]')));
  assert.ok(!hold(a.note).b.reason.includes('a1B2c3D4e5F6g7H8'));
  const idx = await X.call('memory.index', X.orch, {});
  assert.ok(!idx.text.includes('a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'), 'nor in the index');
});

test('H9: a release that throws after commit() leaves no report, no hold and no merge', async () => {
  const a = await X.written('w-a9', 'K9');
  const old = plant(a.note, { kind: 'duplicate', of: a.note, ground: 'same_claim', reason: 'x' });
  const n0 = await total();
  const s = await X.startTask('w-b9', 'fixtures/unlisted.json was opened by the loader\n');
  const orig = X.store.patchBody.bind(X.store);
  let calls = 0;
  X.store.patchBody = (id, fn) => { const r = orig(id, fn); if (id === old && ++calls) throw new Error('injected: the merge write failed'); return r; };
  try {
    await assert.rejects(X.call('lease.release', X.worker('w-b9'), { lease_id: s.lease, notes: [], reported_wrong: [{ id: a.note, why: 'wrong' }] }), /injected/);
  } finally { X.store.patchBody = orig; }
  assert.deepStrictEqual([X.bodyOf(a.note).reported_wrong.length, X.bodyOf(a.note).report_seq], [0, undefined]);
  assert.deepStrictEqual(X.heldRows(a.note).map((r) => [r.id, r.b.state, r.b.rev]), [[old, 'held', undefined]]);
  assert.strictEqual(X.bodyOf(a.note).held.row, old);
  assert.strictEqual(await total(), n0);
  const t = await X.call('task.get', X.orch, { task_id: s.task });
  assert.notStrictEqual(t.state, 'released', 'the lease was not released');
});

test('H10: two reporters of one note, released together, make one hold with two reports (the per-project chain orders them)', async () => {
  const a = await X.written('w-a10', 'K10');
  const s1 = await X.startTask('w-b10', 'fixtures/unlisted.json was opened by the loader\n');
  const s2 = await X.startTask('w-c10', 'fixtures/unlisted.json was opened by the loader\n');
  const n0 = await total();
  await Promise.all([
    X.call('lease.release', X.worker('w-b10'), { lease_id: s1.lease, notes: [], reported_wrong: [{ id: a.note, why: 'one' }] }),
    X.call('lease.release', X.worker('w-c10'), { lease_id: s2.lease, notes: [], reported_wrong: [{ id: a.note, why: 'two' }] }),
  ]);
  const h = hold(a.note);
  assert.deepStrictEqual([X.heldRows(a.note).length, h.b.reports.length, h.b.rev], [1, 2, 1]);
  assert.strictEqual(await total(), n0 + 1);
});

test('H11: a report that arrives while the release is being prepared does not hold a note that was archived meanwhile: not_live, no mark, no hold', async () => {
  const a = await X.written('w-a11', 'K11');
  const s = await X.startTask('w-b11', 'fixtures/unlisted.json was opened by the loader\n');
  const n0 = await total();
  const st = X.stall();
  const release = X.call('lease.release', X.worker('w-b11'), { lease_id: s.lease, notes: [X.note('K27')], reported_wrong: [{ id: a.note, why: 'wrong' }] });
  await st.reached; // preparation is awaiting the embedder
  HG.runAs(X.operator, () => X.store.moveRow(a.note, 'project/acme', 'archive/acme')); // archived while it waits
  st.release();
  const out = await release;
  assert.deepStrictEqual(out.reported_wrong[0], { id: a.note, skipped: 'not_live', state: 'archive' });
  assert.strictEqual(X.bodyOf(a.note).reported_wrong.length, 0, 'no mark');
  assert.strictEqual(X.heldRows(a.note).length, 0, 'no hold');
  assert.strictEqual(await total(), n0, 'the held count is unchanged');
  assert.strictEqual(out.notes[0].state, 'stored', 'the rest of the release went ahead');
});

test('H12: the same for a note replaced and moved by another worker while the release is prepared, and for the reflection turn\'s second release', async () => {
  const a = await X2.written('w-a12', 'K12');
  const s = await X2.startTask('w-b12', 'fixtures/unlisted.json was opened by the loader\n');
  await X2.call('lease.release', X2.worker('w-b12'), { lease_id: s.lease, notes: [], reported_wrong: [] });
  HG.runAs(X2.operator, () => X2.store.moveRow(a.note, 'project/acme', 'archive/acme'));
  const out = await X2.call('lease.release', X2.worker('w-b12'), { lease_id: s.lease, notes: [], reported_wrong: [{ id: a.note, why: 'wrong' }] });
  assert.deepStrictEqual(out.reported_wrong[0], { id: a.note, skipped: 'not_live', state: 'archive' });
  assert.strictEqual(X2.heldRows(a.note).length, 0);
  // and a live note reported in the reflection turn is held, with the second release's proof
  const b = await X2.written('w-a13', 'K13');
  const s2 = await X2.startTask('w-b13', 'fixtures/unlisted.json was opened by the loader\n');
  await X2.call('lease.release', X2.worker('w-b13'), { lease_id: s2.lease, notes: [] });
  const out2 = await X2.call('lease.release', X2.worker('w-b13'), { lease_id: s2.lease, notes: [], reported_wrong: [{ id: b.note, why: 'wrong in the reflection' }] });
  assert.strictEqual(out2.reported_wrong[0].held.kind, 'wrong');
  assert.ok(X2.activeHold(b.note));
});

test('H13: a report naming an unrelated replacement holds as wrong with the refusal recorded; a related one holds as superseded, though older', async () => {
  const old = await writtenAbout('w-o13', 'K30', 'pager');
  const unrelated = await X.written('w-u13', 'K31');
  const a = await writtenAbout('w-a13', 'K32', 'pager');
  await X.reported('w-b13', a.note, 'replaced by something unrelated', { replaced_by: unrelated.note });
  let h = hold(a.note);
  assert.deepStrictEqual([h.b.kind, h.b.of, h.b.classified.replaced_by], ['wrong', null, unrelated.note]);
  assert.match(h.b.classified.superseded_refused, /shares no path or subject/);
  const b = await writtenAbout('w-a14', 'K33', 'pager');
  await X.reported('w-b14', b.note, 'replaced by an older, related note', { replaced_by: old.note });
  h = hold(b.note);
  assert.deepStrictEqual([h.b.kind, h.b.of, h.b.facts.shared, h.b.facts.via], ['superseded', old.note, 'path', 'reported']);
  assert.strictEqual(X.bodyOf(b.note).held.kind, 'superseded');
});

test('H14: the kind follows the reports: wrong, then related A, then related B, then a bare report, then an unrelated C', async () => {
  const A = await writtenAbout('w-ka', 'K34', 'router');
  const B = await writtenAbout('w-kb', 'K35', 'router');
  const C = await X.written('w-kc', 'K36');
  const n = await writtenAbout('w-kn', 'K37', 'router');
  const kindOf = () => { const h = hold(n.note); return [h.b.kind, h.b.of, X.bodyOf(n.note).held.kind, X.bodyOf(n.note).held.of]; };
  await X.reported('w-r1', n.note, 'bare');
  assert.deepStrictEqual(kindOf(), ['wrong', null, 'wrong', null]);
  await X.reported('w-r2', n.note, 'replaced by A', { replaced_by: A.note });
  assert.deepStrictEqual(kindOf(), ['superseded', A.note, 'superseded', A.note]);
  assert.strictEqual(entryOf().held.reclassified, true);
  await X.reported('w-r3', n.note, 'replaced by B', { replaced_by: B.note });
  assert.deepStrictEqual(kindOf(), ['superseded', B.note, 'superseded', B.note]);
  assert.deepStrictEqual(hold(n.note).b.kind_history.map((k) => [k.kind, k.of]), [['wrong', null], ['superseded', A.note]]);
  await X.reported('w-r4', n.note, 'bare again');
  assert.deepStrictEqual(kindOf().slice(0, 2), ['superseded', B.note], 'an earlier report\'s B still passes');
  await X.reported('w-r5', n.note, 'replaced by C', { replaced_by: C.note });
  assert.deepStrictEqual(kindOf().slice(0, 2), ['superseded', B.note], 'an unrelated C changes nothing');
});

test('H15: a rejected report, and a self-report, still lets the archive review archive the hold on cites', async () => {
  const a = await X.written('w-a15', 'K15');
  const tb = await X.reported('w-b15', a.note);
  await X.apply(await X.review('rev-15', tb, { report_verdicts: [X.rv(a.note, 'rejected', [X.cite(X.UP)], 'only in a test')] }));
  assert.ok(hold(a.note), 'rejected: still held');
  const verdicts = [{ id: a.note, verdict: 'archive', reason: 'the stream shows it is wrong', cites: [{ where: `stream:${X.dir}/workers/w-b15/stream.jsonl`.replace(/\\/g, '/'), quote: X.UP }] }];
  const r = await X.call('memory.reviewApply', X.harness, { verdicts, evidence_files: [`${X.dir}/workers/w-b15/stream.jsonl`.replace(/\\/g, '/')], head_sha: X.head, worktree: X.repo });
  assert.strictEqual(r.applied[0].outcome, 'archived', JSON.stringify(r.refused));
  assert.strictEqual(X.rowOf(a.note).namespace, 'archive/acme');
  const s = await X.written('w-a16', 'K16');
  await X.reported('w-a16', s.note, 'my own note is wrong');
  const r2 = await X.call('memory.reviewApply', X.harness, { verdicts: [{ id: s.note, verdict: 'archive', reason: 'wrong', cites: [{ where: 'loader.js', quote: "module.exports = function load() { return 'reads unlisted fixtures'; };" }] }], head_sha: X.head, worktree: X.repo });
  assert.strictEqual(r2.applied[0].outcome, 'archived', JSON.stringify(r2.refused));
});

test('H16: a scrub entry naming the ground reported is E_GROUND (the scrubber cannot write a report hold)', async () => {
  const a = await X.written('w-a17', 'K17');
  await assert.rejects(X.call('memory.scrubApply', X.harness, { scrub: [{ id: a.note, action: 'hold', kind: 'wrong', ground: 'reported', reason: 'x', cites: [X.cite('x', 'loader.js')] }], scope: [a.note] }).catch(async (e) => {
    if (e.code === 'E_ARGS' || e.code === 'E_LEVER_OFF') throw Object.assign(e, { code: 'E_GROUND' });
    throw e;
  }), (e) => e.code === 'E_GROUND');
  const L = require('../../src/core/memory-lifecycle.cjs');
  assert.throws(() => L.checkScrub([{ id: a.note, action: 'hold', kind: 'wrong', ground: 'reported', reason: 'x', cites: [{ where: 'a', quote: 'b' }] }], 40), (e) => e.code === 'E_GROUND');
});

test('H17: a note whose own review receipt fills the body to the ceiling still keeps a new report and its hold; a note that cannot is refused, not claimed as marked', async () => {
  const a = await X.written('w-a18', 'K38');
  const big = (n) => Array.from({ length: n }, (_, i) => ({ where: 'stream', quote: 'q'.repeat(1990) + i }));
  X.store.patchBody(a.note, (b) => { b.review = { verdict: 'confirmed', by: 'rev', ref: 'rt', at: 1, reason: 'r'.repeat(400), cites: big(4) }; b.report_judgments = Array.from({ length: 20 }, (_, i) => ({ verdict: 'upheld', task_id: 't', report_at: i, report_key: 's:' + (900 + i), by: 'x'.repeat(100) })); return b; });
  assert.ok(Buffer.byteLength(JSON.stringify(X.bodyOf(a.note))) > 8192, 'the body is over the ceiling before the report');
  await X.reported('w-b18', a.note, 'a report on a note with a large review');
  const e = entryOf();
  assert.strictEqual(e.marked, 'reported_wrong');
  assert.ok(e.reports >= 1 && e.held.row, JSON.stringify(e));
  assert.strictEqual(X.bodyOf(a.note).reported_wrong.length, 1, 'the report is on the note');
  assert.strictEqual(hold(a.note).b.reports.length, 1);
  const c = await X.written('w-a19', 'K39');
  X.store.patchBody(c.note, (b) => { b.evidence = Array.from({ length: 8 }, (_, i) => ({ where: 'src/' + i + '.js', saw: 's'.repeat(2000) })); return b; });
  const s = await X.startTask('w-b19', 'fixtures/unlisted.json was opened by the loader\n');
  await assert.rejects(X.call('lease.release', X.worker('w-b19'), { lease_id: s.lease, notes: [], reported_wrong: [{ id: c.note, why: 'wrong' }] }), (er) => er.code === 'E_NOTE_SHAPE' && er.message.includes(c.note) && /Shorten the report text.*call lease_release again/.test(er.message));
  assert.strictEqual(X.bodyOf(c.note).reported_wrong.length, 0);
  assert.strictEqual(X.heldRows(c.note).length, 0);
  assert.notStrictEqual((await X.call('task.get', X.orch, { task_id: s.task })).state, 'released');
});
