'use strict';
// memory-k2-lifecycle.test.cjs — the note write, archive and promotion lifecycle, as the audit of the memory architecture found it:
// a superseder that leaves project/ takes its replaced note with it, a write-time hold stacks no second row and carries the writer's
// evidence, a restore gives back the deliveries it took, the restore and purge gates, and the stored cosine decides a duplicate hold.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { setup, PROJECT, A, A_NEAR, B } = require('./lifecycle-env.cjs');
const { callerFor } = require('./helpers.cjs');
const { archiveNote } = require('../../src/core/memory-archive.cjs');
const { loadNote } = require('../../src/core/memory-facts.cjs');
const { holdReported } = require('../../src/core/memory-report-hold.cjs');
const gate = require('../../src/core/memory-note-gate.cjs');

let T;
before(async () => { T = await setup(); });
after(() => T.close());

const scrub = (entries, extra = {}) => T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: entries, scope: entries.flatMap(e => [e.id, e.of].filter(Boolean)), ...T.evidence, ...extra });
const review = (verdicts, extra = {}) => T.call(T.who.harness('apply'), 'memory.reviewApply', { verdicts, ...T.evidence, ...extra });
const relate = (id, relation, of, over = {}) => ({ id, action: 'relate', relation, of, reason: `they relate as ${relation}`, ...over });
const resolve = (resolutions, who = T.who.tool('apply')) => T.call(who, 'memory.noteResolve', { resolutions });
const ns = id => T.row(id).namespace;
const pendingFor = (title, target, over = {}) => T.note(title, { ns: `pending/${PROJECT}`, state: 'pending', vec: A_NEAR, matches: [{ id: target, title: 'x', kind: 'lesson', basis: 'observed', similarity: 0.99 }], ...over });
const hiddenNow = () => gate.hiddenIds(T.E, T.who.tool('apply'), { namespaces: [`project/${PROJECT}`] });
const heldRowsOf = id => T.store.p("SELECT id FROM memory_entries WHERE type = 'held' AND json_extract(body, '$.note_id') = ?").all(id);
function archived(project, title, over = {}) {
  const id = T.note(title, { ns: `archive/${project}`, state: 'archived' });
  T.store.patchBody(id, b => { b.archived = { at: over.at || 1, from: over.from || `project/${project}`, kind: over.kind || 'wrong', reason: 'x' }; if (over.matches) b.matches = over.matches; return b; });
  return id;
}

// ---- D30: a superseder that leaves project/ ------------------------------------------------------------------------

test('D30: a writer-superseded note stays out of the project when its superseder is archived as a repeat, and a restore brings it back', async () => {
  const old = T.note('d30 old', { vec: B, created_at: 100 });
  const kept = T.note('d30 kept', { vec: A, created_at: 100 });
  const neu = pendingFor('d30 new', old);
  await resolve([{ id: neu, resolve: 'supersedes', of: old, evidence: [{ where: 'a.js', saw: 'the old lesson is out of date' }] }]);
  assert.ok(hiddenNow().includes(old), 'the superseder hides it while it is in the project');
  const r = await scrub([relate(neu, 'repeats', kept)]);
  assert.strictEqual(r.applied[0].archived, neu);
  assert.strictEqual(ns(neu), `archive/${PROJECT}`);
  assert.strictEqual(ns(old), `archive/${PROJECT}`, 'the replaced note does not reappear beside the claim that displaced it');
  assert.deepStrictEqual([T.body(old).archived.kind, T.body(old).archived.of, T.body(old).archived.replaced_by_archived], ['superseded', kept, neu]);
  assert.strictEqual(T.body(neu).archived.replaced_also_archived, old);
  const back = await T.call(T.who.operator('apply'), 'memory.noteRestore', { id: old, reason: 'the old lesson was right' });
  assert.strictEqual(back.namespace, `project/${PROJECT}`);
  assert.ok(!hiddenNow().includes(old), 'restored, and nothing in the project replaces it now');
});

test('D30: the chain follows: a note the archived superseder had itself replaced goes too', async () => {
  const first = T.note('d30 chain first', { vec: B, created_at: 100 });
  const kept = T.note('d30 chain kept', { vec: A, created_at: 100 });
  const second = pendingFor('d30 chain second', first);
  await resolve([{ id: second, resolve: 'supersedes', of: first, evidence: [{ where: 'a.js', saw: 'one' }] }]);
  const third = pendingFor('d30 chain third', second);
  await resolve([{ id: third, resolve: 'supersedes', of: second, evidence: [{ where: 'a.js', saw: 'two' }] }]);
  await scrub([relate(third, 'repeats', kept)]);
  assert.deepStrictEqual([ns(third), ns(second), ns(first)], [`archive/${PROJECT}`, `archive/${PROJECT}`, `archive/${PROJECT}`]);
});

test('D30: a superseder archived as wrong leaves the note it replaced visible again; the claim that displaced it was not true', async () => {
  const old = T.note('d30 wrong old', { vec: B, created_at: 100 });
  const neu = pendingFor('d30 wrong new', old);
  await resolve([{ id: neu, resolve: 'supersedes', of: old, evidence: [{ where: 'a.js', saw: 'x' }] }]);
  assert.ok(hiddenNow().includes(old));
  T.store.tx(() => archiveNote(T.E, PROJECT, loadNote(T.E, neu), { kind: 'wrong', reason: 'it was false', direct: true, run_id: 'lc-apply' }, null));
  assert.strictEqual(ns(neu), `archive/${PROJECT}`);
  assert.strictEqual(ns(old), `project/${PROJECT}`);
  assert.ok(!hiddenNow().includes(old));
  // even with a note named as what it stands against: a wrong mark carries nothing
  const old2 = T.note('d30 wrong old 2', { vec: B, created_at: 100 }), other = T.note('d30 wrong other', { vec: A, created_at: 100 });
  const neu2 = pendingFor('d30 wrong new 2', old2);
  await resolve([{ id: neu2, resolve: 'supersedes', of: old2, evidence: [{ where: 'a.js', saw: 'x' }] }]);
  T.store.tx(() => archiveNote(T.E, PROJECT, loadNote(T.E, neu2), { kind: 'wrong', of: other, reason: 'it was false', direct: true, run_id: 'lc-apply' }, loadNote(T.E, other)));
  assert.strictEqual(ns(old2), `project/${PROJECT}`);
});

test('D30: only a note leaving project/ carries what it replaced: a pending note archived does not', async () => {
  const old = T.note('d30 pending old', { vec: B, created_at: 100 }), kept = T.note('d30 pending kept', { vec: A, created_at: 100 });
  const pend = pendingFor('d30 pending new', old);
  T.store.setSupersedes(pend, old); // a pending note cannot hide anything: the gate looks in its own namespace
  T.store.tx(() => archiveNote(T.E, PROJECT, loadNote(T.E, pend), { kind: 'duplicate', of: kept, ground: 'same_claim', reason: 'same', direct: true, run_id: 'lc-apply' }, loadNote(T.E, kept)));
  assert.strictEqual(ns(old), `project/${PROJECT}`);
});

// ---- D32: a write-time hold ----------------------------------------------------------------------------------------

test('D32 (K5): a second write-time refines of a held verified note is refused, one held row stays, and the first row is not orphaned', async () => {
  const v = T.note('k5 verified', { vec: A, created_at: 100, status: 'verified' });
  const p1 = pendingFor('k5 p1', v), p2 = pendingFor('k5 p2', v);
  const tool = T.who.tool('apply');
  const first = await resolve([{ id: p1, resolve: 'refines', of: v, evidence: [{ where: 'a.js', saw: 'one' }] }], tool);
  const heldRow = T.body(v).held.row;
  assert.strictEqual(first.resolved[0].held_for_review, heldRow);
  await assert.rejects(resolve([{ id: p2, resolve: 'refines', of: v, evidence: [{ where: 'a.js', saw: 'two' }] }], tool), x => x.code === 'E_HELD' && x.detail.held_row === heldRow);
  assert.strictEqual(T.body(v).held.row, heldRow);
  assert.strictEqual(heldRowsOf(v).length, 1);
  assert.strictEqual(ns(p2), `pending/${PROJECT}`, 'the refused resolution left its note pending');
});

test('D32: the hold records the writer\'s evidence for the reviewer, and the new note does not keep the matches it was resolved against', async () => {
  const v = T.note('d32 verified', { vec: A, created_at: 100, status: 'verified' });
  const p = pendingFor('d32 new', v);
  const ev = [{ where: 'src/a.js', saw: 'the caveat applies when the cache is cold' }];
  await resolve([{ id: p, resolve: 'refines', of: v, evidence: ev }]);
  const hold = JSON.parse(T.row(T.body(v).held.row).body);
  assert.deepStrictEqual(hold.facts.writer_evidence, ev);
  assert.deepStrictEqual(hold.cites, [], 'the writer\'s words are data on the row, never a cite');
  assert.strictEqual(T.body(p).matches, undefined);
  assert.strictEqual(T.body(p).state, 'live');
});

test('D32: the reviewer archives a write-time hold on a file cite when the call gives the run\'s head, and a head on the hold wins over the call\'s', async () => {
  for (const [name, holdHead, callHead, outcome] of [['call head', null, T.head, 'archived'], ['hold head wins', T.head, '0000000', 'archived'], ['no head at all', null, null, 'refused']]) {
    const v = T.note(`d32 review ${name}`, { vec: A, created_at: 100, status: 'verified' });
    const p = pendingFor(`d32 review new ${name}`, v);
    await resolve([{ id: p, resolve: 'refines', of: v, evidence: [{ where: 'src/a.js', saw: 'x' }] }]);
    if (holdHead) T.store.patchBody(T.body(v).held.row, b => { b.head_sha = holdHead; return b; });
    const r = await T.call(T.who.harness('apply'), 'memory.reviewApply', { verdicts: [{ id: v, verdict: 'archive', reason: 'the code shows the caveat', cites: [T.cite] }], worktree: T.repo, ...(callHead ? { head_sha: callHead } : {}) });
    const out = r.applied[0] || r.refused[0];
    assert.strictEqual(out.outcome, outcome, name);
    if (outcome === 'archived') assert.strictEqual(ns(v), `archive/${PROJECT}`, name);
    else assert.match(out.message, /no head commit/, name);
  }
});

test('D32: a report on a note that already waits on a reviewer for a report stacks no second hold: it is appended to the one', async () => {
  const n = T.note('d32 report stack', { reported_wrong: [{ ...T.report('worker:w2'), seq: 1 }] });
  const ctx = { project: PROJECT, runId: 'lc-apply', threshold: 0.8, headSha: null };
  const harness = T.who.harness('apply');
  const first = T.store.tx(() => holdReported(T.E, harness, ctx, loadNote(T.E, n), { why: 'it is wrong' }));
  assert.strictEqual(heldRowsOf(n).length, 1);
  T.store.patchBody(n, (b) => { b.reported_wrong.push({ ...T.report('worker:w3'), seq: 2, task_id: 'ty' }); b.report_seq = 2; return b; });
  const second = T.store.tx(() => holdReported(T.E, harness, ctx, loadNote(T.E, n), { why: 'it is wrong too' }));
  assert.deepStrictEqual([second.row, second.already_held, second.rev], [first.row, true, 1]);
  assert.strictEqual(heldRowsOf(n).length, 1);
  assert.strictEqual(T.body(n).held.row, first.row);
});

// ---- D63: a restore gives back what the merge took -----------------------------------------------------------------

test('D63: a restored duplicate gets its deliveries back, the kept note gives them up, and a second archive counts them once', async () => {
  const kept = T.note('d63 kept', { vec: A, created_at: 100 });
  const dupe = T.note('d63 dupe', { vec: A_NEAR, created_at: 200, task_id: 'd63-b', written_by: 'worker:wb' });
  const tool = T.who.tool('apply'), op = T.who.operator('apply');
  await T.call(tool, 'memory.recordEvent', { kind: 'index_injected', worker_id: 'w9', task_id: 'tz', row_ids: [dupe] });
  await scrub([relate(dupe, 'repeats', kept)]);
  assert.deepStrictEqual([T.body(kept).delivery_history.length, (T.body(dupe).delivery_history || []).length], [1, 0]);
  assert.strictEqual((await T.call(op, 'memory.noteDeliveries', { note_id: dupe })).deliveries.length, 0);
  const r = await T.call(op, 'memory.noteRestore', { id: dupe, reason: 'not a repeat' });
  assert.strictEqual(r.history_returned.deliveries, 1);
  assert.deepStrictEqual([T.body(kept).delivery_history.length, T.body(dupe).delivery_history.length], [0, 1]);
  const d = (await T.call(op, 'memory.noteDeliveries', { note_id: dupe })).deliveries;
  assert.deepStrictEqual(d.map(x => [x.task_id, x.worker_id, x.route, x.from_duplicate]), [['tz', 'w9', 'index', undefined]], 'the delivery is the duplicate\'s own again');
  await scrub([relate(dupe, 'repeats', kept)]);
  assert.strictEqual(T.body(kept).delivery_history.length, 1, 'handed over again, counted once');
  assert.strictEqual((await T.call(op, 'memory.noteDeliveries', { note_id: kept })).deliveries.length, 1);
});

test('D63 (K6): restoring a pending repeat takes its sighting back off the live note', async () => {
  const target = T.note('k6 target', { vec: A, created_at: 100, written_by: 'worker:w1', task_id: 'k6-t1' });
  const pend = pendingFor('k6 pending', target, { written_by: 'worker:w2', task_id: 'k6-t2' });
  await resolve([{ id: pend, resolve: 'repeats', of: target }]);
  assert.strictEqual(T.body(target).seen_total, 1);
  await T.call(T.who.operator('apply'), 'memory.noteRestore', { id: pend, reason: 'not a repeat' });
  assert.strictEqual(T.body(target).seen_total, 0);
  assert.strictEqual((T.body(target).seen_in || []).length, 0);
});

// ---- D64: the scope and authority gates of restore, purge and the candidates ----------------------------------------

test('D64 (K1): an orchestrator cannot restore an archived note of another project', async () => {
  const other = archived('elsewhere', 'k1 other project note');
  await assert.rejects(T.call(T.who.tool('apply'), 'memory.noteRestore', { id: other, reason: 'try' }), x => x.code === 'E_ROLE');
  assert.strictEqual(ns(other), 'archive/elsewhere');
});

test('D64 (K2): a purge with a project removes only that project\'s archived notes', async () => {
  const mine = archived(PROJECT, 'k2 mine'), theirs = archived('elsewhere2', 'k2 theirs');
  const r = await T.call(T.who.operator('apply'), 'memory.archivePurge', { project: PROJECT, older_than_days: 0, confirm: true });
  assert.ok(r.ids.includes(mine));
  assert.ok(!r.ids.includes(theirs));
  assert.ok(T.row(theirs), 'the other project\'s archive is untouched');
  assert.strictEqual(T.row(mine), undefined);
});

test('D64: a purge drops the namespace cache, and a search of the archive does not return a purged note', async () => {
  const id = archived(PROJECT, 'purge cache note');
  const search = () => T.call(T.who.harness('apply'), 'memory.search', { namespace: `archive/${PROJECT}`, query_embedding: A, embedding_model: 'm', mode: 'semantic', view: 'index' });
  assert.ok((await search()).results.some(r => r.id === id), 'read once, so the namespace is cached');
  assert.ok(T.store.cache.has(`archive/${PROJECT}`));
  await T.call(T.who.operator('apply'), 'memory.archivePurge', { ids: [id], confirm: true });
  assert.ok(!T.store.cache.has(`archive/${PROJECT}`), 'the cached vectors of the purged namespace are dropped');
  assert.ok(!(await search()).results.some(r => r.id === id));
});

test('D64: the restore of a note with the lever off, a clash in pending, stale matches and the restored cap', async () => {
  // the notes lever off: an orchestrator is refused by name (the operator is not)
  const off = archived(PROJECT, 'restore lever off');
  await assert.rejects(T.call(T.who.tool('plain'), 'memory.noteRestore', { id: off, reason: 'try' }), x => x.code === 'E_LEVER_OFF');
  assert.strictEqual(ns(off), `archive/${PROJECT}`);
  // a note archived from pending returns to pending, and a pending note with the same text refuses it
  const fromPending = archived(PROJECT, 'restore pending clash', { from: `pending/${PROJECT}` });
  const r = T.row(fromPending);
  T.store.storeIn({ namespace: `pending/${PROJECT}`, worker_id: 'w1', type: 'note', text: r.text, title: r.title, body: { kind: 'lesson', state: 'pending' }, run_id: 'x', source: 'model', written_by: 'worker:w1' });
  await assert.rejects(T.call(T.who.operator('apply'), 'memory.noteRestore', { id: fromPending, reason: 'try' }), x => x.code === 'E_EXISTS');
  assert.strictEqual(ns(fromPending), `archive/${PROJECT}`);
  // restored to live: the matches it was written with are gone, and the receipt list is bounded
  const stale = archived(PROJECT, 'restore stale matches', { matches: [{ id: 'm-gone', similarity: 0.99 }] });
  T.store.patchBody(stale, b => { b.restored = Array.from({ length: 20 }, (_, i) => ({ at: i, reason: `earlier ${i}` })); return b; });
  const back = await T.call(T.who.operator('apply'), 'memory.noteRestore', { id: stale, reason: 'again' });
  assert.strictEqual(back.namespace, `project/${PROJECT}`);
  assert.strictEqual(T.body(stale).matches, undefined);
  assert.strictEqual(T.body(stale).restored.length, 20);
  assert.strictEqual(T.body(stale).restored[19].reason, 'again');
  assert.strictEqual(T.body(stale).restored[0].reason, 'earlier 1');
});

test('D64: archivedDuplicates is the project\'s own, lists duplicates only, and an orchestrator cannot read another project\'s', async () => {
  const kept = T.note('cands kept', { vec: A, created_at: 100 });
  const dupe = archived(PROJECT, 'cands dupe', { kind: 'duplicate' });
  const sup = archived(PROJECT, 'cands superseded', { kind: 'superseded' });
  for (const id of [dupe, sup]) T.store.patchBody(id, b => { b.archived.of = kept; return b; });
  const r = await T.call(T.who.tool('apply'), 'memory.archivedDuplicates', { id: kept });
  assert.deepStrictEqual(r.candidates.map(c => c.id), [dupe]);
  const foreign = T.note('cands foreign', { ns: 'project/elsewhere3' });
  await assert.rejects(T.call(T.who.tool('apply'), 'memory.archivedDuplicates', { id: foreign }), x => x.code === 'E_ROLE');
});

// ---- L07, L16 ---------------------------------------------------------------------------------------------------------

test('L07: a duplicate hold is judged on the stored cosine; a recorded match counts only when there is none and it names both vectors', async () => {
  const dup = (id, of) => ({ id, action: 'hold', kind: 'duplicate', of, ground: 'same_claim', reason: 'same claim' });
  const kept = T.note('l07 kept', { vec: A, created_at: 100 });
  const bound = { id: kept, title: 't', kind: 'lesson', basis: 'observed', similarity: 0.99, embedding_model: 'm', dim: 3, template: 'v1' };
  // the vectors are far apart now (the note was retitled and re-embedded after the match was recorded): the old match decides nothing
  const stale = T.note('l07 stale', { vec: B, created_at: 200, matches: [bound] });
  const r1 = await scrub([dup(stale, kept)]);
  assert.strictEqual(r1.refused[0].code, 'E_PRECONDITION');
  assert.strictEqual(T.body(stale).held, undefined);
  // no vector on the note: the recorded match, which names the same model, dimension and template, stands
  const bare = T.note('l07 bare', { vec: B, created_at: 200, matches: [bound] });
  T.store.p('UPDATE memory_entries SET embedding = NULL WHERE id = ?').run(bare);
  assert.strictEqual((await scrub([dup(bare, kept)])).applied[0].outcome, 'held');
  // a recorded match for another model does not bind
  const other = T.note('l07 other model', { vec: B, created_at: 200, matches: [{ ...bound, embedding_model: 'other' }] });
  T.store.p('UPDATE memory_entries SET embedding = NULL WHERE id = ?').run(other);
  assert.strictEqual((await scrub([dup(other, kept)])).refused[0].code, 'E_PRECONDITION');
});

test('L16: a stream cite in an archive review is checked against the note\'s title as well as its other words', async () => {
  const n = T.note('l16 the loader skips unlisted fixtures entirely', { reported_wrong: [T.report()] });
  T.store.patchBody(n, b => { b.evidence = [{ where: 'src/x.js', saw: 'the unlisted file was never read' }]; return b; });
  const title = T.row(n).title;
  const stream = `${T.dir}/l16-stream.jsonl`;
  fs.writeFileSync(stream, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: `${title} - the unlisted file was never read` }] }] } }),
  ].join('\n') + '\n');
  await scrub([{ id: n, action: 'hold', kind: 'wrong', ground: 'report_confirmed', reason: 'contradicted', cites: [T.cite] }]);
  const r = await review([{ id: n, verdict: 'archive', reason: 'x', cites: [{ where: `stream:${stream}`, quote: 'the unlisted file was never read' }] }], { evidence_files: [stream] });
  assert.strictEqual(r.refused.length, 1, JSON.stringify(r.applied.map(a => a.outcome)));
  assert.match(r.refused[0].message, /own text|echo|not in/i);
  assert.strictEqual(ns(n), `project/${PROJECT}`);
});

void callerFor;
