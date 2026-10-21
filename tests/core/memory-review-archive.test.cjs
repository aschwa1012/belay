'use strict';
// memory-review-archive.test.cjs — memory.reviewApply (archive and release with the S4 re-check and a review: receipt),
// the duplicate history transfer, the restore candidates, memory.noteRestore and the operator's purge.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { setup, PROJECT, A, A_NEAR, B } = require('./lifecycle-env.cjs');
const { callerFor } = require('./helpers.cjs');

let T;
before(async () => { T = await setup(); });
after(() => T.close());

const scrub = (entries, extra = {}) => T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: entries, scope: entries.flatMap(e => [e.id, e.of].filter(Boolean)), ...T.evidence, ...extra });
const review = (verdicts, extra = {}) => T.call(T.who.harness('apply'), 'memory.reviewApply', { verdicts, ...T.evidence, ...extra });
const hold = async (e) => (await scrub([e])).applied[0].held;
const wrong = (id, over = {}) => ({ id, action: 'hold', kind: 'wrong', ground: 'report_confirmed', reason: 'contradicted by the code', cites: [T.cite], ...over });
const dup = (id, of) => ({ id, action: 'hold', kind: 'duplicate', of, ground: 'same_claim', reason: 'same claim', cites: [T.cite] });
const archiveV = (id, over = {}) => ({ id, verdict: 'archive', reason: 'the code confirms the hold', cites: [T.cite], same_claim: true, ...over });
const releaseV = (id) => ({ id, verdict: 'release', reason: 'the code supports the note' });
const event = (ids, extra = {}) => T.call(T.who.tool('apply'), 'memory.recordEvent', { kind: 'index_injected', worker_id: 'w9', task_id: 'tz', row_ids: ids, ...extra });

test('reviewApply is a harness call, and a verdict needs an active hold', async () => {
  const n = T.note('review target', { reported_wrong: [T.report()] });
  await assert.rejects(T.call(T.who.tool('apply'), 'memory.reviewApply', { verdicts: [releaseV(n)] }), x => x.code === 'E_ROLE');
  const r = await review([releaseV(n)]);
  assert.strictEqual(r.refused[0].code, 'E_NOT_FOUND');
  assert.strictEqual((await review([{ id: n, verdict: 'archive', reason: 'x' }])).refused[0].code, 'E_NOT_FOUND', 'no hold, so nothing to archive, cites or not');
});

test('release of a scrubber duplicate hold drops the hold and clears the warning; the note was never out of the index set', async () => {
  const keptR = T.note('released kept', { vec: A, created_at: 100 });
  const n = T.note('released target', { vec: A_NEAR, created_at: 200, reported_wrong: [T.report()] });
  const h = await hold(dup(n, keptR));
  assert.ok(T.body(n).held);
  const r = await review([releaseV(n)]);
  const v = r.applied[0];
  assert.strictEqual(v.outcome, 'released');
  assert.strictEqual(v.receipt, `review:lc-apply:${h.id}`);
  assert.strictEqual(v.held.body.state, 'released');
  assert.strictEqual(T.body(n).held, undefined, 'the warning is cleared');
  assert.strictEqual(T.body(n).releases[0].held_row, h.id);
  assert.strictEqual(T.row(n).namespace, `project/${PROJECT}`);
  assert.strictEqual((await review([releaseV(n)])).refused[0].code, 'E_NOT_FOUND', 'a released hold is settled');
  assert.strictEqual((await scrub([wrong(n)])).applied[0].outcome, 'held', 'a released note can be held again');
});

test('archive moves the note to archive/ keeping its id, out of the index and out of search, and the held row says so', async () => {
  const n = T.note('archived target about turnstile gating', { reported_wrong: [T.report()] });
  const keep = T.note('a live neighbour about turnstile gating');
  const h = await hold(wrong(n));
  const before = await T.call(T.who.tool('apply'), 'memory.index', {});
  assert.ok(before.row_ids.includes(n), 'held, it is still a candidate');
  const hitsBefore = await T.call(T.who.tool('apply'), 'memory.search', { query: 'turnstile gating', mode: 'keyword', namespace: `project/${PROJECT}` });
  assert.ok(hitsBefore.results.some(x => x.id === n));
  const r = await review([archiveV(n)]);
  const v = r.applied[0];
  assert.deepStrictEqual([v.outcome, v.id, v.receipt], ['archived', n, `review:lc-apply:${h.id}`]);
  assert.strictEqual(T.row(n).namespace, `archive/${PROJECT}`);
  assert.strictEqual(T.body(n).state, 'archived');
  assert.deepStrictEqual([T.body(n).archived.kind, T.body(n).archived.review, T.body(n).archived.held_row], ['wrong', v.receipt, h.id]);
  assert.strictEqual(T.body(n).held, undefined);
  assert.strictEqual(v.held.body.state, 'archived');
  assert.strictEqual(v.held.body.reviews[0].outcome, 'archived');
  const after = await T.call(T.who.tool('apply'), 'memory.index', {});
  assert.ok(!after.row_ids.includes(n) && after.row_ids.includes(keep), 'archived notes leave the index candidate set');
  const hits = await T.call(T.who.tool('apply'), 'memory.search', { query: 'turnstile gating', mode: 'keyword', namespace: `project/${PROJECT}` });
  assert.ok(!hits.results.some(x => x.id === n) && hits.results.some(x => x.id === keep), 'and out of search');
  const inArchive = await T.call({ ...T.who.tool('apply'), channel: 'harness' }, 'memory.search', { query: 'turnstile gating', mode: 'keyword', namespace: `archive/${PROJECT}` });
  assert.ok(inArchive.results.some(x => x.id === n), 'it is kept and can still be read by naming the archive');
});

test('archive re-checks the facts at apply time: a refused verdict returns its row with a review: receipt and changes nothing', async () => {
  const old = T.note('about to be replaced', { created_at: 100 }), fresh = T.note('the replacement', { created_at: 900 });
  const h = await hold({ id: old, action: 'hold', kind: 'superseded', of: fresh, ground: 'replaced_by_newer', reason: 'newer note', cites: [T.cite] });
  T.store.p("UPDATE memory_entries SET status = 'refuted' WHERE id = ?").run(fresh); // the replacement is refuted before the reviewer runs
  const r = await review([archiveV(old)]);
  assert.strictEqual(r.applied.length, 0);
  const v = r.refused[0];
  assert.strictEqual(v.outcome, 'refused');
  assert.strictEqual(v.code, 'E_PRECONDITION');
  assert.match(v.message, /no longer holds at apply time/);
  assert.strictEqual(v.receipt, `review:lc-apply:${h.id}`);
  assert.strictEqual(v.held.body.state, 'held', 'still held');
  assert.strictEqual(v.held.body.reviews[0].outcome, 'refused');
  assert.strictEqual(T.row(old).namespace, `project/${PROJECT}`);
  // a citation that is not there is refused the same way, with a receipt
  const n = T.note('bad citation target', { reported_wrong: [T.report()] });
  await hold(wrong(n));
  const c = await review([archiveV(n, { cites: [{ where: 'loader.js', quote: 'this line is not in the file' }] })]);
  assert.strictEqual(c.refused[0].code, 'E_CITATION');
  assert.match(c.refused[0].receipt, /^review:lc-apply:/);
  assert.strictEqual(T.row(n).namespace, `project/${PROJECT}`);
});

test('a duplicate archived hands its sightings and delivery history to the kept note, bounded, and says where they came from', async () => {
  const sightings = (n, task) => Array.from({ length: n }, (_, i) => ({ task_id: `${task}${i}`, written_by: 'worker:wx', run_id: 'r-old', in_index_beforehand: false, at: i, evidence: [] }));
  const kept = T.note('kept: fixtures load from the manifest', { vec: A, created_at: 100, seen_in: sightings(19, 'ka'), seen_total: 19 });
  const dupe = T.note('dupe: the manifest decides which fixtures load', { vec: A_NEAR, created_at: 200, seen_in: sightings(3, 'kb'), seen_total: 5, task_id: 'dupe-task' });
  await event([dupe, 'unrelated']); await event([kept]); await event(['another', dupe], { worker_id: 'w10' });
  await hold(dup(dupe, kept));
  const r = await review([archiveV(dupe)]);
  const v = r.applied[0];
  assert.strictEqual(v.outcome, 'archived');
  assert.deepStrictEqual(v.history_moved, { to: kept, seen_total: 6, seen_in: 4, deliveries: 2 });
  const a = T.body(kept);
  assert.strictEqual(a.seen_total, 19 + 6, 'as if the duplicate had been resolved repeats, plus its own earlier sightings');
  assert.strictEqual(a.seen_in.length, 20, 'seen_in keeps its bound');
  assert.strictEqual(a.seen_in[a.seen_in.length - 1].transferred_from, dupe, 'the newest is the duplicate\'s own sighting');
  assert.strictEqual(a.seen_in[a.seen_in.length - 1].task_id, 'dupe-task');
  assert.deepStrictEqual(a.delivery_history.map(d => [d.from, d.worker_id]), [[dupe, 'w9'], [dupe, 'w10']], 'only receipts that held the duplicate');
  assert.deepStrictEqual([a.merged_from[0].id, a.merged_from[0].seen_total, a.merged_from[0].deliveries, a.merged_from[0].review], [dupe, 6, 2, v.receipt]);
  const b = T.body(dupe);
  assert.deepStrictEqual([b.seen_in.length, b.seen_total], [0, 0], 'the duplicate keeps nothing that would be counted twice');
  assert.deepStrictEqual(b.archived.history_moved, v.history_moved);
  assert.strictEqual(T.row(dupe).namespace, `archive/${PROJECT}`);
});

test('the same writer in the same task as the kept note is one observation, not a second sighting', async () => {
  const kept = T.note('kept same task', { vec: A, created_at: 100, task_id: 'shared-task', written_by: 'worker:w1' });
  const dupe = T.note('dupe same task', { vec: A_NEAR, created_at: 200, task_id: 'shared-task', written_by: 'worker:w1', seen_total: 2, seen_in: [{ task_id: 'o1', written_by: 'worker:wq', run_id: 'r', at: 1 }, { task_id: 'o2', written_by: 'worker:wq', run_id: 'r', at: 2 }] });
  await hold(dup(dupe, kept));
  const v = (await review([archiveV(dupe)])).applied[0];
  assert.strictEqual(v.history_moved.seen_total, 2);
  assert.strictEqual(T.body(kept).seen_total, 2);
  assert.ok(T.body(kept).seen_in.every(s => s.task_id !== 'shared-task'));
});

test('archivedDuplicates lists the archived duplicates of a note as restore candidates', async () => {
  const kept = T.note('restore kept', { vec: A, created_at: 100 }), dupe = T.note('restore dupe', { vec: A_NEAR, created_at: 200 });
  await hold(dup(dupe, kept)); await review([archiveV(dupe)]);
  const op = T.who.operator('apply');
  let r = await T.call(op, 'memory.archivedDuplicates', { id: kept });
  assert.strictEqual(r.kept_live, true);
  assert.deepStrictEqual(r.candidates.map(c => c.id), [dupe]);
  assert.strictEqual(r.candidates[0].history_moved.to, kept);
  T.store.p("UPDATE memory_entries SET status = 'refuted' WHERE id = ?").run(kept);
  r = await T.call(op, 'memory.archivedDuplicates', { id: kept });
  assert.strictEqual(r.kept_live, false);
  assert.match(r.note, /can be restored/);
  await assert.rejects(T.call(op, 'memory.archivedDuplicates', { id: 'no-such' }), x => x.code === 'E_NOT_FOUND');
});

test('noteRestore brings an archived note back to live with a reason and a receipt', async () => {
  const kept = T.note('rest kept', { vec: A, created_at: 100 }), dupe = T.note('rest dupe', { vec: A_NEAR, created_at: 200 });
  await hold(dup(dupe, kept)); await review([archiveV(dupe)]);
  const tool = T.who.tool('apply');
  await assert.rejects(T.call(tool, 'memory.noteRestore', { id: dupe }), x => x.code === 'E_ARGS' && /reason/.test(x.message));
  await assert.rejects(T.call(tool, 'memory.noteRestore', { id: kept, reason: 'not archived' }), x => x.code === 'E_NOT_FOUND');
  await assert.rejects(T.call(callerFor('worker', { run_id: 'lc-apply', worker_id: 'w1' }), 'memory.noteRestore', { id: dupe, reason: 'x' }), x => x.code === 'E_ROLE');
  const r = await T.call(tool, 'memory.noteRestore', { id: dupe, reason: 'the kept note was refuted' });
  assert.deepStrictEqual([r.id, r.restored, r.namespace, r.history_returned.from], [dupe, true, `project/${PROJECT}`, kept]);
  assert.strictEqual(r.receipt.reason, 'the kept note was refuted');
  assert.strictEqual(r.receipt.was_archived.kind, 'duplicate');
  assert.strictEqual(T.row(dupe).namespace, `project/${PROJECT}`);
  assert.strictEqual(T.body(dupe).state, 'live');
  assert.strictEqual(T.body(dupe).archived, undefined);
  assert.strictEqual(T.body(dupe).restored.length, 1);
  const idx = await T.call(tool, 'memory.index', {});
  assert.ok(idx.row_ids.includes(dupe));
  await assert.rejects(T.call(tool, 'memory.noteRestore', { id: dupe, reason: 'again' }), x => x.code === 'E_NOT_FOUND', 'it is live now');
});

test('restore refuses when a live note already has the same text', async () => {
  const n = T.note('clash target', { reported_wrong: [T.report()] });
  await hold(wrong(n)); await review([archiveV(n)]);
  const r = T.row(n);
  T.store.storeIn({ namespace: `project/${PROJECT}`, worker_id: 'w1', type: 'note', text: r.text, title: r.title, body: { kind: 'lesson', state: 'live' }, run_id: 'x', source: 'model', written_by: 'worker:w1' });
  await assert.rejects(T.call(T.who.operator('apply'), 'memory.noteRestore', { id: n, reason: 'try' }), x => x.code === 'E_EXISTS');
  assert.strictEqual(T.row(n).namespace, `archive/${PROJECT}`);
});

test('purge is the operator\'s alone, needs confirm, writes the full rows first, and covers archived notes only', async () => {
  const a = T.note('purge a', { reported_wrong: [T.report()] }), b = T.note('purge b', { reported_wrong: [T.report()] }), live = T.note('purge live');
  for (const id of [a, b]) { await hold(wrong(id)); await review([archiveV(id)]); }
  const rowsBefore = [a, b].map(id => T.row(id));
  const op = T.who.operator('apply');
  await assert.rejects(T.call(T.who.tool('apply'), 'memory.archivePurge', { ids: [a], confirm: true }), x => x.code === 'E_ROLE');
  await assert.rejects(T.call(op, 'memory.archivePurge', { ids: [a] }), x => x.code === 'E_ARGS' && /confirm/.test(x.message));
  await assert.rejects(T.call(op, 'memory.archivePurge', { confirm: true }), x => x.code === 'E_ARGS');
  await assert.rejects(T.call(op, 'memory.archivePurge', { ids: [a], older_than_days: 1, confirm: true }), x => x.code === 'E_ARGS');
  const r = await T.call(op, 'memory.archivePurge', { ids: [a, b, live], confirm: true });
  assert.strictEqual(r.count, 2);
  assert.deepStrictEqual(r.skipped, [{ id: live, reason: 'not an archived note' }]);
  assert.match(r.path, /archive-purged-\d{4}-\d{2}-\d{2}\.jsonl$/);
  const bytes = fs.readFileSync(r.path);
  assert.strictEqual(r.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  const lines = bytes.toString('utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(lines.map(l => l.id), [a, b]);
  assert.strictEqual(lines[0].text, rowsBefore[0].text);
  assert.strictEqual(lines[0].body, rowsBefore[0].body, 'the full row, body included');
  assert.ok(lines[0].embedding_b64);
  assert.strictEqual(T.row(a), undefined);
  assert.strictEqual(T.row(b), undefined);
  assert.ok(T.row(live), 'a live note is never purged');
  const none = await T.call(op, 'memory.archivePurge', { ids: [a], confirm: true });
  assert.deepStrictEqual([none.count, none.path, none.sha256], [0, null, null], 'nothing to purge writes no file');
});

test('purge older_than_days selects by the time of the archive, and a same-day second purge gets its own file', async () => {
  const old = T.note('purge old', { reported_wrong: [T.report()] }), recent = T.note('purge recent', { reported_wrong: [T.report()] });
  for (const id of [old, recent]) { await hold(wrong(id)); await review([archiveV(id)]); }
  const b = T.body(old); b.archived.at = Date.now() - 40 * 86400000;
  T.store.p('UPDATE memory_entries SET body = ? WHERE id = ?').run(JSON.stringify(b), old);
  const op = T.who.operator('apply');
  const r = await T.call(op, 'memory.archivePurge', { older_than_days: 30, confirm: true });
  assert.deepStrictEqual(r.ids, [old]);
  assert.ok(T.row(recent), 'the recent archive stays');
  const r2 = await T.call(op, 'memory.archivePurge', { ids: [recent], confirm: true });
  assert.notStrictEqual(r2.path, r.path);
  assert.match(r2.path, /-\d\.jsonl$/);
});

test('nothing in the lifecycle deletes a row: only the purge removes any', async () => {
  const before = T.store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n;
  const n = T.note('no delete', { reported_wrong: [T.report()] });
  await hold(wrong(n)); await review([archiveV(n)]);
  await T.call(T.who.tool('apply'), 'memory.noteRestore', { id: n, reason: 'back' });
  const after = T.store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n;
  assert.strictEqual(after, before + 3, 'the note, its held row, and the fresh hold the restore writes for the reports nobody settled; nothing deleted');
});


test('reviewApply re-checks a duplicate against the run\'s notes_match_threshold, not a constant', async () => {
  const kept = T.note('lever review kept', { vec: A, created_at: 1000 });
  const near = T.note('lever review near', { vec: A_NEAR, created_at: 2000 });
  await hold(dup(near, kept));
  const r = await T.call(T.who.harness('strict'), 'memory.reviewApply', { verdicts: [archiveV(near)], ...T.evidence });
  assert.strictEqual(r.refused.length, 1);
  assert.strictEqual(r.refused[0].code, 'E_PRECONDITION');
  assert.match(r.refused[0].message, /needs 0\.995/);
  const ok = await review([archiveV(near)]);
  assert.strictEqual(ok.applied[0].outcome, 'archived');
});

const dupNoCites = (id, of, over = {}) => ({ id, action: 'hold', kind: 'duplicate', of, ground: 'same_claim', reason: 'both say the loader must cache by name', ...over });

test('a duplicate hold needs no cites when S4 holds, ignores any given, and is refused when S4 does not hold', async () => {
  const kept = T.note('nocite kept', { vec: A, created_at: 1000 });
  const near = T.note('nocite near', { vec: A_NEAR, created_at: 2000 });
  const r = await scrub([dupNoCites(near, kept)]);
  assert.strictEqual(r.applied[0].outcome, 'held');
  assert.deepStrictEqual(JSON.parse(T.row(r.applied[0].held.id).body).cites, [], 'no cites stored');
  // Cites that are given are ignored: a quote that is in no file does not refuse a duplicate.
  const kept2 = T.note('nocite kept 2', { vec: A, created_at: 1000 });
  const near2 = T.note('nocite near 2', { vec: A_NEAR, created_at: 2000 });
  const r2 = await scrub([dupNoCites(near2, kept2, { cites: [{ where: 'loader.js', quote: 'a line that the file does not contain anywhere' }] })]);
  assert.strictEqual(r2.applied[0].outcome, 'held');
  // S4 not shown: dissimilar vectors and no worker report.
  const far = T.note('nocite far', { vec: B, created_at: 3000 });
  const rr = await scrub([dupNoCites(far, kept)]);
  assert.strictEqual(rr.refused[0].code, 'E_PRECONDITION');
  assert.strictEqual(T.body(far).held, undefined);
  // A worker report naming the kept note is S4 too.
  const rep = T.note('nocite reported', { vec: B, created_at: 3000, reported_wrong: [T.report('worker:w2', kept)] });
  assert.strictEqual((await scrub([dupNoCites(rep, kept)])).applied[0].outcome, 'held');
  // A reason is required.
  await assert.rejects(scrub([dupNoCites(T.note('nocite noreason', { vec: A_NEAR }), kept, { reason: ' ' })]), x => x.code === 'E_ARGS');
});

test('wrong and superseded holds still need cites at the scrub and at the review', async () => {
  const w = T.note('cites needed wrong', { reported_wrong: [T.report()] });
  await assert.rejects(scrub([wrong(w, { cites: [] })]), x => x.code === 'E_ARGS' && /cites needs/.test(x.message));
  const old = T.note('cites needed old', { vec: A, created_at: 1000 }), neu = T.note('cites needed new', { vec: A, created_at: 2000 });
  await assert.rejects(scrub([{ id: old, action: 'hold', kind: 'superseded', of: neu, ground: 'replaced_by_newer', reason: 'newer', cites: [] }]), x => x.code === 'E_ARGS');
  await hold(wrong(w));
  const r = await review([archiveV(w, { cites: [] })]);
  assert.strictEqual(r.refused[0].code, 'E_CITATION');
  assert.strictEqual(T.row(w).namespace, `project/${PROJECT}`);
  assert.strictEqual((await review([archiveV(w)])).applied[0].outcome, 'archived', 'with a cite it archives');
});

test('reviewApply archives a duplicate only on same_claim true, with no cites, and rechecks S4', async () => {
  const kept = T.note('same claim kept', { vec: A, created_at: 1000 });
  const near = T.note('same claim near', { vec: A_NEAR, created_at: 2000 });
  const h = await hold(dupNoCites(near, kept));
  for (const over of [{ same_claim: undefined }, { same_claim: false }]) {
    const r = await review([archiveV(near, { cites: [], ...over })]);
    assert.strictEqual(r.refused[0].code, 'E_PRECONDITION', JSON.stringify(over));
    assert.match(r.refused[0].message, /same_claim: true/);
    assert.strictEqual(T.row(near).namespace, `project/${PROJECT}`);
  }
  assert.strictEqual(JSON.parse(T.row(h.id).body).reviews.pop().outcome, 'refused', 'the refusal is a fact on the held row');
  await assert.rejects(review([archiveV(near, { cites: [], same_claim: 'yes' })]), x => x.code === 'E_ARGS');
  const ok = await review([archiveV(near, { cites: [] })]);
  assert.strictEqual(ok.applied[0].outcome, 'archived');
  assert.strictEqual(T.row(near).namespace, `archive/${PROJECT}`);
  assert.strictEqual(JSON.parse(T.row(h.id).body).reviews.pop().same_claim, true, 'the verdict records same_claim');
  // S4 is rechecked at review time: the kept note left the project, so the archive is refused even with same_claim.
  const kept2 = T.note('same claim kept 2', { vec: A, created_at: 1000 });
  const near2 = T.note('same claim near 2', { vec: A_NEAR, created_at: 2000 });
  await hold(dupNoCites(near2, kept2));
  T.store.p('UPDATE memory_entries SET namespace = ? WHERE id = ?').run(`archive/${PROJECT}`, kept2);
  const gone = await review([archiveV(near2, { cites: [] })]);
  assert.strictEqual(gone.refused[0].code, 'E_PRECONDITION');
});

test('reviewQueue gives a duplicate hold both notes in full', async () => {
  const kept = T.note(`queue full kept ${'k'.repeat(1900)} KEPT-END`, { vec: A, created_at: 1000 });
  const near = T.note(`queue full near ${'n'.repeat(1900)} NEAR-END`, { vec: A_NEAR, created_at: 2000 });
  await hold(dupNoCites(near, kept));
  const q = await T.call(T.who.harness('apply'), 'memory.reviewQueue', {});
  const h = q.held.find(x => x.id === near);
  assert.ok(h.note.text.includes('NEAR-END') && h.of_note.text.includes('KEPT-END'));
});

test('a short real quote is accepted in an archive review; empty, whitespace, too long and absent quotes are refused', async () => {
  const n = T.note('short quote target', { reported_wrong: [T.report()] });
  await hold(wrong(n));
  for (const quote of ['', '   ', 'x'.repeat(2001)]) {
    await assert.rejects(review([archiveV(n, { cites: [{ where: 'loader.js', quote }] })]), x => x.code === 'E_ARGS', JSON.stringify(quote.slice(0, 5)));
    assert.strictEqual(T.row(n).namespace, `project/${PROJECT}`);
  }
  const absent = await review([archiveV(n, { cites: [{ where: 'loader.js', quote: 'nope()' }] })]);
  assert.strictEqual(absent.refused[0].code, 'E_CITATION', 'a short quote that is not in the file is still refused');
  const ok = await review([archiveV(n, { cites: [{ where: 'loader.js', quote: 'function load(name) {' }] })]);
  assert.strictEqual(ok.refused.length, 0, JSON.stringify(ok.refused));
  assert.strictEqual(ok.applied.length, 1);
});

test('a 1500-byte verbatim quote is accepted by the archive review apply path', async () => {
  const fs = require('node:fs');
  const n = T.note('long quote review target', { reported_wrong: [T.report()] });
  await hold(wrong(n));
  const long = 'long line ' + 'abcdefghij'.repeat(149) + 'END';
  const stream = `${T.dir}/long-review.jsonl`;
  fs.writeFileSync(stream, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: long }] }] } })}\n`);
  assert.strictEqual(Buffer.byteLength(long), 1503);
  const ok = await review([archiveV(n, { cites: [{ where: `stream:${stream}`, quote: long }] })], { evidence_files: [stream] });
  assert.strictEqual(ok.refused.length, 0, JSON.stringify(ok.refused));
  assert.strictEqual(ok.applied.length, 1);
});
