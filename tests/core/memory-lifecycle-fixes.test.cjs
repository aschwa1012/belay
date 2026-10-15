'use strict';
// memory-lifecycle-fixes.test.cjs — regressions for the review of the notes lifecycle write side: nothing is deleted
// outside the operator's purge, a restored duplicate is not counted twice, a restored pending note stays pending,
// the S3 and S4 holes, the harness-only namespaces, the purge's ledger row, and the held warning in the index.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { setup, PROJECT, A, A_NEAR, B } = require('./lifecycle-env.cjs');
const { callerFor } = require('./helpers.cjs');

let T;
before(async () => { T = await setup(); });
after(() => T.close());

const scrub = (entries, extra = {}, kind = 'apply') => T.call(T.who.harness(kind), 'memory.scrubApply', { scrub: entries, scope: entries.flatMap(e => [e.id, e.of].filter(Boolean)), ...T.evidence, ...extra });
const review = (verdicts) => T.call(T.who.harness('apply'), 'memory.reviewApply', { verdicts, ...T.evidence });
const hold = async (e) => (await scrub([e])).applied[0].held;
const wrong = (id, over = {}) => ({ id, action: 'hold', kind: 'wrong', ground: 'report_confirmed', reason: 'the loader does throw', cites: [T.cite], ...over });
const dup = (id, of) => ({ id, action: 'hold', kind: 'duplicate', of, ground: 'same_claim', reason: 'same claim', cites: [T.cite] });
const archiveV = (id) => ({ id, verdict: 'archive', reason: 'confirmed', cites: [T.cite] });
const count = () => T.store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n;
const tool = () => T.who.tool('apply');

test('#1 a scrubber resolve repeats archives the pending row and deletes nothing', async () => {
  const live = T.note('repeat target', { vec: A, created_at: 100 });
  const pend = T.note('repeat pending', { ns: `pending/${PROJECT}`, vec: A_NEAR, state: 'pending', task_id: 'other', matches: [{ id: live, similarity: 0.99 }] });
  const n = count();
  const r = await scrub([{ id: pend, action: 'resolve', resolve: 'repeats', of: live, ground: 'same_claim', reason: 'same' }]);
  assert.strictEqual(r.applied[0].resolved.pending_row_archived, true);
  assert.strictEqual(count(), n, 'no row was deleted');
  assert.strictEqual(T.row(pend).namespace, `archive/${PROJECT}`);
  assert.strictEqual(T.body(live).seen_total, 1, 'the sighting is on the target');
});

test('#2 only the operator deletes a note or anything in the lifecycle namespaces', async () => {
  const n = T.note('delete target', { reported_wrong: [T.report()] });
  const h = await hold(wrong(n));
  await assert.rejects(T.call(tool(), 'memory.delete', { id: n }), x => x.code === 'E_ROLE', 'a live note');
  await assert.rejects(T.call(tool(), 'memory.delete', { id: h.id }), x => x.code === 'E_ROLE', 'a held row');
  await review([archiveV(n)]);
  await assert.rejects(T.call(tool(), 'memory.delete', { id: n }), x => x.code === 'E_ROLE', 'an archived note');
  assert.ok(T.row(n) && T.row(h.id));
  for (const ns of ['archive', 'held', 'proposal', 'draft']) {
    await assert.rejects(T.call(tool(), 'memory.store', { namespace: `${ns}/${PROJECT}`, text: `forged ${ns}`, type: 'note' }), x => x.code === 'E_ROLE' || x.code === 'E_ARGS', ns);
    await assert.rejects(T.call(tool(), 'memory.store', { namespace: `${ns}/${PROJECT}`, text: `forged ${ns}`, type: 'fact' }), x => x.code === 'E_ROLE', ns);
  }
  const plain = await T.call(tool(), 'memory.store', { namespace: 'run/lc-apply', text: 'an ordinary fact', embed: false });
  assert.strictEqual((await T.call(tool(), 'memory.delete', { id: plain.id })).deleted, true, 'ordinary rows are as before');
  assert.strictEqual((await T.call(T.who.operator('apply'), 'memory.delete', { id: h.id })).deleted, true, 'the operator may');
});

test('#3 and #4 restoring a duplicate returns its history, and archiving it again counts it once', async () => {
  const kept = T.note('hist kept', { vec: A, created_at: 100, seen_total: 2, seen_in: [{ task_id: 'k1', written_by: 'worker:q', run_id: 'r', at: 1 }, { task_id: 'k2', written_by: 'worker:q', run_id: 'r', at: 2 }] });
  const dupe = T.note('hist dupe', { vec: A_NEAR, created_at: 200, task_id: 'dt', seen_total: 1, seen_in: [{ task_id: 'd1', written_by: 'worker:z', run_id: 'r', at: 3 }] });
  await T.call(tool(), 'memory.recordEvent', { kind: 'index_injected', worker_id: 'w9', task_id: 'tz', row_ids: [dupe] });
  const shape = id => { const b = T.body(id); return [b.seen_total, b.seen_in.length, (b.merged_from || []).length, (b.delivery_history || []).length]; };
  const base = shape(kept);
  await hold(dup(dupe, kept)); await review([archiveV(dupe)]);
  const once = shape(kept);
  assert.deepStrictEqual(once, [2 + 2, 2 + 2, 1, 1]);
  const r = await T.call(tool(), 'memory.noteRestore', { id: dupe, reason: 'back' });
  assert.deepStrictEqual(shape(kept), base, 'the kept note is back to what it was');
  assert.deepStrictEqual([T.body(dupe).seen_total, T.body(dupe).seen_in.map(s => s.task_id)], [1, ['d1']], 'the duplicate has its own history again');
  assert.strictEqual(r.history_returned.from, kept);
  await hold(dup(dupe, kept)); await review([archiveV(dupe)]);
  assert.deepStrictEqual(shape(kept), once, 'the second archive hands over the same, not double');
});

test('#3 a duplicate already handed over is not handed over again', async () => {
  const { transferHistory } = require('../../src/core/memory-archive.cjs');
  const { loadNote } = require('../../src/core/memory-facts.cjs');
  const kept = T.note('twice kept', { vec: A }), dupe = T.note('twice dupe', { vec: A_NEAR, seen_total: 1, seen_in: [{ task_id: 'x', written_by: 'worker:z', run_id: 'r', at: 1 }] });
  T.store.tx(() => transferHistory(T.E, loadNote(T.E, dupe), loadNote(T.E, kept), {}));
  const first = T.body(kept).seen_total;
  const again = T.store.tx(() => transferHistory(T.E, loadNote(T.E, dupe), loadNote(T.E, kept), {}));
  assert.strictEqual(again.already, true);
  assert.strictEqual(T.body(kept).seen_total, first);
});

test('#5 a note archived while pending is restored to pending, not live', async () => {
  const pend = T.note('pending restore', { ns: `pending/${PROJECT}`, vec: B, state: 'pending', reported_wrong: [T.report()] });
  assert.strictEqual((await scrub([wrong(pend)])).applied[0].outcome, 'archived_directly');
  const r = await T.call(tool(), 'memory.noteRestore', { id: pend, reason: 'it was not wrong' });
  assert.strictEqual(r.namespace, `pending/${PROJECT}`);
  assert.strictEqual(T.row(pend).namespace, `pending/${PROJECT}`);
  assert.strictEqual(T.body(pend).state, 'pending');
  const idx = await T.call(tool(), 'memory.index', {});
  assert.ok(!idx.row_ids.includes(pend), 'a pending note stays out of the index');
});

test('#6 a quote of the note itself is refused, a short quote is refused, and code_contradicts needs a file', async () => {
  const n = T.note('the loader skips every unlisted fixture silently', { reported_wrong: [T.report()] });
  const stream = `${T.dir}/own-stream.jsonl`;
  fs.writeFileSync(stream, `${JSON.stringify({ index: '- note [lesson] the loader skips every unlisted fixture silently' })}\n`);
  const own = await scrub([wrong(n, { cites: [{ where: `stream:${stream}`, quote: 'the loader skips every unlisted fixture silently' }] })], { evidence_files: [stream] });
  assert.strictEqual(own.refused[0].code, 'E_CITATION');
  assert.match(own.refused[0].message, /own text/);
  const filed = await scrub([wrong(n, { cites: [{ where: 'loader.js', quote: 'function load(name) {\n  return fixtures.get(name);' }, { where: 'loader.js', quote: 'return fixtures.get(name); // unlisted names throw' }] })]);
  assert.strictEqual(filed.applied[0].outcome, 'held');
  const n2 = T.note('another stream-only target', { reported_wrong: [T.report()] });
  fs.writeFileSync(stream, `${JSON.stringify({ out: 'error: fixture alpha is not listed in the manifest' })}\n`);
  const only = await scrub([wrong(n2, { ground: 'code_contradicts', cites: [{ where: `stream:${stream}`, quote: 'error: fixture alpha is not listed in the manifest' }] })], { evidence_files: [stream] });
  assert.strictEqual(only.refused[0].code, 'E_CITATION');
  assert.match(only.refused[0].message, /file at the head commit/);
  await assert.rejects(scrub([wrong(n2, { cites: [{ where: 'loader.js', quote: 'function' }] })]), x => x.code === 'E_ARGS' && /too short/.test(x.message));
});

test('#7 a superseding note must share a path or subject, or a stored similarity', async () => {
  const old = T.note('loader claim', { vec: A, created_at: 10 }), css = T.note('css grid claim', { vec: B, created_at: 900 });
  const sup = (id, of) => ({ id, action: 'hold', kind: 'superseded', of, ground: 'replaced_by_newer', reason: 'newer', cites: [T.cite] });
  assert.match((await scrub([sup(old, css)])).refused[0].message, /shares no path or subject/);
  const p1 = T.note('shared path old', { vec: A, created_at: 10 }), p2 = T.note('shared path new', { vec: B, created_at: 900 });
  for (const [id, key] of [[p1, 'applies_to'], [p2, 'applies_to']]) { const b = T.body(id); b[key] = ['src/Loader.js']; T.store.p('UPDATE memory_entries SET body = ? WHERE id = ?').run(JSON.stringify(b), id); }
  const ok = await scrub([sup(p1, p2)]);
  assert.strictEqual(ok.applied[0].facts.shared, 'path');
});

test('#9 a hold may not stand against a note outside the scope that nothing names', async () => {
  const a = T.note('scope a', { vec: A, created_at: 10 }), b = T.note('scope b', { vec: A_NEAR, created_at: 20 }), named = T.note('named kept', { vec: A, created_at: 5 });
  const e = x => ({ id: x, action: 'hold', kind: 'duplicate', ground: 'same_claim', reason: 'same', cites: [T.cite] });
  const r = await T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: [{ ...e(b), of: a }], scope: [b], ...T.evidence });
  assert.strictEqual(r.refused[0].code, 'E_SCOPE');
  assert.strictEqual(T.body(a).merged_from, undefined);
  const c = T.note('reported dup', { vec: A_NEAR, reported_wrong: [T.report('worker:w2', named)] });
  const ok = await T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: [{ ...e(c), of: named }], scope: [c], ...T.evidence });
  assert.strictEqual(ok.applied[0].outcome, 'held', 'a report that names the kept note is enough');
});

test('#10 propose mode does not propose a second hold on a held note', async () => {
  const n = T.note('already held', { reported_wrong: [T.report()] });
  await hold(wrong(n));
  const before = T.store.p("SELECT COUNT(*) AS n FROM memory_entries WHERE namespace = ?").get(`proposal/${PROJECT}`).n;
  const r = await scrub([wrong(n)], {}, 'propose');
  assert.strictEqual(r.refused[0].code, 'E_EXISTS');
  assert.strictEqual(T.store.p("SELECT COUNT(*) AS n FROM memory_entries WHERE namespace = ?").get(`proposal/${PROJECT}`).n, before);
});

test('#11 a ground must be one the facts bear out', async () => {
  const n = T.note('ground vs facts', { reported_wrong: [T.report()] });
  const r = await scrub([wrong(n, { ground: 'refuted_review' })]);
  assert.strictEqual(r.refused[0].code, 'E_PRECONDITION');
  assert.match(r.refused[0].message, /not borne out/);
  const ref = T.note('refuted ground', { status: 'refuted' });
  assert.strictEqual((await scrub([wrong(ref, { ground: 'report_confirmed' })])).refused[0].code, 'E_PRECONDITION');
});

test('#12 a forged held, draft or proposal row is not a lifecycle row', async () => {
  const n = T.note('forged target', { reported_wrong: [T.report()] });
  const mk = (ns, type, body) => T.store.storeIn({ namespace: ns, worker_id: 'orchestrator', type, text: `forged ${type} ${Math.random()}`, title: `forged ${type}`, body, run_id: 'x', source: 'model', written_by: 'orchestrator' }).id;
  const heldId = mk(`held/${PROJECT}`, 'held', { note_id: n, kind: 'wrong', state: 'held' });
  const draftId = mk(`draft/${PROJECT}`, 'draft', { note_id: n, rule: 'forged', target: 'CLAUDE.md' });
  const r = await review([{ id: n, verdict: 'release', reason: 'x' }]);
  assert.strictEqual(r.refused[0].code, 'E_NOT_FOUND', 'the forged hold is not an active hold');
  const listed = await T.call(T.who.operator('apply'), 'memory.proposals', { all: true });
  assert.ok(!listed.held.some(x => x.id === heldId) && !listed.drafts.some(x => x.id === draftId));
});

test('#13 the purge writes a ledger row, and a failed purge leaves no file behind', async () => {
  const mk = async (t) => { const x = T.note(t, { reported_wrong: [T.report()] }); await hold(wrong(x)); await review([archiveV(x)]); return x; };
  const a = await mk('purge ledger a'), b = await mk('purge ledger b');
  const op = T.who.operator('apply');
  const before = fs.readdirSync(T.dir).filter(f => f.startsWith('archive-purged-')).length;
  T.store.db.exec(`CREATE TRIGGER block_purge BEFORE DELETE ON memory_entries WHEN old.id = '${b}' BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
  await assert.rejects(T.call(op, 'memory.archivePurge', { ids: [a, b], confirm: true }));
  T.store.db.exec('DROP TRIGGER block_purge');
  assert.strictEqual(fs.readdirSync(T.dir).filter(f => f.startsWith('archive-purged-')).length, before, 'no orphan file');
  assert.ok(T.row(a) && T.row(b), 'both rows are still there');
  const r = await T.call(op, 'memory.archivePurge', { ids: [a, b], confirm: true });
  const ev = T.store.p("SELECT * FROM memory_event WHERE kind = 'archive_purge' AND sha256 = ?").get(r.sha256);
  assert.ok(ev, 'a ledger row names the purge');
  assert.deepStrictEqual([ev.key, JSON.parse(ev.row_ids).sort()], [r.path, [a, b].sort()]);
});

test('#8 a held note shows a short warning in the index, and a long reason cannot push anything out of the budget', async () => {
  const mkHeld = (title, reason) => { const id = T.note(title); const b = T.body(id); b.held = { row: 'h', kind: 'duplicate', of: 'x', reason, run_id: 'r', at: 1 }; T.store.p('UPDATE memory_entries SET body = ? WHERE id = ?').run(JSON.stringify(b), id); return id; };
  const idx = async () => T.call(tool(), 'memory.index', {});
  const base = await idx();
  const ids = Array.from({ length: 8 }, (_, i) => T.note(`bulk note ${i} about turnstile`));
  const plain = await idx();
  const setReason = reason => { for (const id of ids) { const b = T.body(id); b.held = { row: 'h', kind: 'wrong', of: null, reason, run_id: 'r', at: 1 }; T.store.p('UPDATE memory_entries SET body = ? WHERE id = ?').run(JSON.stringify(b), id); } };
  setReason('z'.repeat(60));
  const atCap = await idx();
  setReason('z'.repeat(4000));
  const heldIdx = await idx();
  assert.deepStrictEqual(heldIdx.row_ids, atCap.row_ids, 'a 4000-byte reason takes no more room than one at the cut: nothing more is pushed out');
  assert.strictEqual(heldIdx.bytes, atCap.bytes);
  assert.deepStrictEqual(heldIdx.row_ids, plain.row_ids.slice(0, heldIdx.row_ids.length), 'the warning changes no rank and no order (the longer lines only fit fewer, from the end)');
  assert.ok(heldIdx.bytes <= 1200, `inside the index budget: ${heldIdx.bytes}`);
  const shown = heldIdx.row_ids.find(id => ids.includes(id));
  const line = heldIdx.text.split('\n').find(l => l.includes(shown));
  assert.match(line, /\[held: wrong, z+(\.\.\.)?\]/);
  assert.ok(Buffer.byteLength(line) - Buffer.byteLength(plain.text.split('\n').find(l => l.includes(shown))) <= 90, 'the reason is cut to about 60 bytes');
  assert.ok(base.row_ids.length >= 0);
  const one = mkHeld('single held', 'duplicate of another note about the same thing');
  assert.match((await idx()).text, new RegExp(`${one}.*\\[held: duplicate, duplicate of another note`));
});

const TOKEN = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

test('R2-1 lifecycle text is redacted before it is stored: a token in a reason, a quote or a restore reason never lands', async () => {
  const everywhere = id => JSON.stringify(T.body(id)) + JSON.stringify(T.row(id));
  // hold reason: in the held row, on the note, and on the index line
  const n = T.note('token hold target', { reported_wrong: [T.report()] });
  const r = await scrub([wrong(n, { reason: `${TOKEN} was in the loader config` })]);
  const h = r.applied[0].held;
  assert.ok(!JSON.stringify(h).includes(TOKEN) && !JSON.stringify(r).includes(TOKEN), 'the held row and the result');
  assert.ok(!everywhere(n).includes(TOKEN), 'the note body');
  assert.ok(h.body.scrub.redacted >= 1, 'the redactions are counted');
  const idx = await T.call(tool(), 'memory.index', {});
  assert.ok(!idx.text.includes(TOKEN) && !idx.text.includes('ghp_a1B2'), 'the index line');
  assert.match(idx.text.split('\n').find(l => l.includes(n)), /\[held: wrong, /);
  // even a body that already holds a raw token shows redacted on the line
  const b = T.body(n); b.held.reason = `${TOKEN} raw in the body`; T.store.p('UPDATE memory_entries SET body = ? WHERE id = ?').run(JSON.stringify(b), n);
  assert.ok(!(await T.call(tool(), 'memory.index', {})).text.includes('ghp_a1B2'), 'the display redacts too');
  // review reason and the release record
  const rel = await review([{ id: n, verdict: 'release', reason: `fine, ${TOKEN}` }]);
  assert.ok(!JSON.stringify(rel).includes(TOKEN) && !everywhere(n).includes(TOKEN));
  // dismiss: reason and a cited stream line
  const d = T.note('token dismiss target', { reported_wrong: [T.report()] });
  const stream = `${T.dir}/token-stream.jsonl`;
  fs.writeFileSync(stream, `${JSON.stringify({ env: `GITHUB_TOKEN=${TOKEN} printed by the failing job` })}\n`);
  const dis = await scrub([{ id: d, action: 'dismiss', ground: 'report_unfounded', reason: `saw ${TOKEN}`, cites: [{ where: `stream:${stream}`, quote: `GITHUB_TOKEN=${TOKEN} printed by the failing job` }] }], { evidence_files: [stream] });
  assert.strictEqual(dis.applied[0].outcome, 'applied', JSON.stringify(dis.refused));
  assert.ok(!everywhere(d).includes(TOKEN) && !JSON.stringify(dis).includes(TOKEN));
  // restore reason
  const k = T.note('token restore target', { reported_wrong: [T.report()] });
  await hold(wrong(k)); await review([archiveV(k)]);
  const rs = await T.call(tool(), 'memory.noteRestore', { id: k, reason: `restoring ${TOKEN}` });
  assert.ok(!JSON.stringify(rs).includes(TOKEN) && !everywhere(k).includes(TOKEN));
  // draft and proposal
  const p = T.note('token draft target');
  const dr = await scrub([{ id: p, action: 'draft', reason: `r ${TOKEN}`, draft: { rule: `never print ${TOKEN}`, target: 'CLAUDE.md' } }]);
  assert.ok(!JSON.stringify(dr).includes(TOKEN));
  const q = T.note('token proposal target', { reported_wrong: [T.report()] });
  const pr = await scrub([wrong(q, { reason: `x ${TOKEN}` })], {}, 'propose');
  assert.ok(!JSON.stringify(pr).includes(TOKEN));
  const stored = T.store.p('SELECT id FROM memory_entries WHERE body LIKE ? OR text LIKE ?').all(`%${TOKEN}%`, `%${TOKEN}%`);
  assert.strictEqual(stored.length, 0, 'no stored row holds the token');
});

test('R2-A a file citation at the head commit may quote the very line the note quoted', async () => {
  const withEvidence = (title) => { const id = T.note(title, { reported_wrong: [T.report()] }); const b = T.body(id); b.evidence = [{ where: 'loader.js', saw: T.cite.quote }]; T.store.p('UPDATE memory_entries SET body = ? WHERE id = ?').run(JSON.stringify(b), id); return id; };
  const n = withEvidence('loader still throws');
  const r = await scrub([{ id: n, action: 'dismiss', ground: 'code_supports_note', reason: 'the code still says it', cites: [T.cite] }]);
  assert.strictEqual(r.applied[0].outcome, 'applied', JSON.stringify(r.refused));
  const m = withEvidence('loader still throws too');
  await hold(wrong(m));
  assert.strictEqual((await review([archiveV(m)])).applied[0].outcome, 'archived', 'an archive verdict may quote the line the note relied on');
});
