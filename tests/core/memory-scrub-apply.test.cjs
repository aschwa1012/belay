'use strict';
// memory-scrub-apply.test.cjs — memory.scrubApply: the harness-only write side of the scrubber's hand-back. The
// safeguards S2 (scope), S3 (verbatim citations), S4 (fact preconditions), the grounds rule, the modes and the alarm.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT, A, A_NEAR, B } = require('./lifecycle-env.cjs');
const { callerFor } = require('./helpers.cjs');

let T;
before(async () => { T = await setup(); });
after(() => T.close());

const heldRows = () => T.store.p("SELECT id FROM memory_entries WHERE namespace = ?").all(`held/${PROJECT}`);
const proposalRows = () => T.store.p("SELECT id FROM memory_entries WHERE namespace = ?").all(`proposal/${PROJECT}`);
const scrub = (kind, entries, scope, extra = {}) => T.call(T.who.harness(kind), 'memory.scrubApply', { scrub: entries, scope: scope || entries.flatMap(e => [e.id, e.of].filter(Boolean)), ...T.evidence, ...extra });
const holdWrong = (id, over = {}) => ({ id, action: 'hold', kind: 'wrong', ground: 'report_confirmed', reason: 'the loader does throw for an unlisted name', cites: [T.cite], ...over });

test('only the harness channel may call it: a tool call, a worker and a missing lever are all refused', async () => {
  const n = T.note('role target', { reported_wrong: [T.report()] });
  const e = [holdWrong(n)];
  await assert.rejects(T.call(T.who.tool('apply'), 'memory.scrubApply', { scrub: e, scope: [n], ...T.evidence }), x => x.code === 'E_ROLE' && /harness/.test(x.message));
  await assert.rejects(T.call(callerFor('worker', { run_id: 'lc-apply', worker_id: 'w1' }), 'memory.scrubApply', { scrub: e, scope: [n] }), x => x.code === 'E_ROLE');
  await assert.rejects(scrub('off', e), x => x.code === 'E_LEVER_OFF' && x.detail.lever === 'scrub_action');
  await assert.rejects(scrub('plain', e), x => x.code === 'E_LEVER_OFF' && x.detail.lever === 'notes');
  assert.strictEqual(heldRows().length, 0, 'nothing was written');
  assert.strictEqual(T.body(n).held, undefined);
});

test('S2: an id outside the scope list refuses the whole call, and nothing is written', async () => {
  const n1 = T.note('in scope', { reported_wrong: [T.report()] }), n2 = T.note('out of scope', { reported_wrong: [T.report()] });
  await assert.rejects(scrub('apply', [holdWrong(n1), holdWrong(n2)], [n1]), x => x.code === 'E_SCOPE' && x.detail.ids[0] === n2);
  assert.strictEqual(T.body(n1).held, undefined, 'the in-scope entry was not applied either');
  assert.strictEqual(heldRows().length, 0);
});

test('a ground that rests on use or miss facts is refused by name, and so is a ground that does not fit the kind', async () => {
  const n = T.note('ground target', { reported_wrong: [T.report()] });
  for (const g of ['never_used', 'delivered_but_not_cited', 'missed_ten_times', 'unused_for_weeks']) {
    await assert.rejects(scrub('apply', [holdWrong(n, { ground: g })]), x => x.code === 'E_GROUND' && /never accepted/.test(x.message), g);
  }
  await assert.rejects(scrub('apply', [holdWrong(n, { ground: 'same_claim' })]), x => x.code === 'E_GROUND' && /one of code_contradicts/.test(x.message));
  await assert.rejects(scrub('apply', [holdWrong(n, { ground: undefined })]), x => x.code === 'E_GROUND');
  assert.strictEqual(heldRows().length, 0);
});

test('shape: an unknown field, a twice-named id, a missing kind or of, and too many entries are E_ARGS', async () => {
  const n = T.note('shape target', { reported_wrong: [T.report()] });
  await assert.rejects(scrub('apply', [{ ...holdWrong(n), model: 'x' }]), x => x.code === 'E_ARGS');
  await assert.rejects(scrub('apply', [holdWrong(n), holdWrong(n)]), x => x.code === 'E_ARGS' && /twice/.test(x.message));
  await assert.rejects(scrub('apply', [holdWrong(n, { kind: 'stale' })]), x => x.code === 'E_ARGS');
  await assert.rejects(scrub('apply', [holdWrong(n, { kind: 'duplicate', ground: 'same_claim' })]), x => x.code === 'E_ARGS' && /names the note/.test(x.message));
  await assert.rejects(scrub('apply', [holdWrong(n, { cites: [] })]), x => x.code === 'E_ARGS' && /cites needs/.test(x.message));
  await assert.rejects(scrub('apply', Array.from({ length: 41 }, (_, i) => holdWrong(`n${i}`))), x => x.code === 'E_ARGS' && /at most 40/.test(x.message));
});

test('S3: a quote that is not in the file at the head commit is refused, and so is a file that is not there', async () => {
  const n = T.note('cite target', { reported_wrong: [T.report()] });
  const bad = await scrub('apply', [holdWrong(n, { cites: [{ where: 'loader.js', quote: 'return fixtures.getAll(name);' }] })]);
  assert.strictEqual(bad.refused[0].code, 'E_CITATION');
  assert.match(bad.refused[0].message, /does not appear in loader.js/);
  const gone = await scrub('apply', [holdWrong(n, { cites: [{ where: 'src/missing.js', quote: 'return fixtures.get(name);' }] })]);
  assert.strictEqual(gone.refused[0].code, 'E_CITATION');
  const escape = await scrub('apply', [holdWrong(n, { cites: [{ where: '../outside.txt', quote: 'return fixtures.get(name);' }] })]);
  assert.strictEqual(escape.refused[0].code, 'E_CITATION');
  const short = scrub('apply', [holdWrong(n, { cites: [{ where: 'loader.js', quote: ' ' }] })]);
  await assert.rejects(short, x => x.code === 'E_ARGS' && /non-empty/.test(x.message));
  const noTree = await T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: [holdWrong(n)], scope: [n] });
  assert.strictEqual(noTree.refused[0].code, 'E_CITATION');
  assert.match(noTree.refused[0].message, /no head commit and worktree/);
  assert.strictEqual(T.body(n).held, undefined, 'a refused entry writes nothing');
  assert.strictEqual(heldRows().length, 0);
});

test('S3: a whitespace-reflowed quote still matches, and a stream file named in evidence_files can be cited', async () => {
  const fs = require('node:fs');
  const n = T.note('stream target', { reported_wrong: [T.report()] });
  const stream = `${T.dir}/stream.jsonl`;
  fs.writeFileSync(stream, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'error: fixture "alpha" is not listed\nin manifest.json' }] }] } })}\n`);
  const r = await scrub('apply', [holdWrong(n, { cites: [{ where: 'loader.js', quote: 'return fixtures.get(name);   // unlisted\n names throw' }, { where: `stream:${stream}`, quote: 'fixture "alpha" is not listed\nin manifest.json' }] })], null, { evidence_files: [stream] });
  assert.strictEqual(r.refused.length, 0, JSON.stringify(r.refused));
  assert.strictEqual(r.applied[0].outcome, 'held');
  const other = `${T.dir}/other.jsonl`;
  fs.writeFileSync(other, 'x');
  const n2 = T.note('stream target 2', { reported_wrong: [T.report()] });
  const r2 = await scrub('apply', [holdWrong(n2, { cites: [{ where: `stream:${other}`, quote: 'fixture "alpha" is not listed' }] })], null, { evidence_files: [stream] });
  assert.match(r2.refused[0].message, /not among the evidence files/);
});

test('S4 wrong: needs a report from another writer or a refuting review', async () => {
  const own = T.note('own report only', { reported_wrong: [T.report('worker:w1')] });
  const bare = T.note('no report');
  const refuted = T.note('refuted note', { status: 'refuted' });
  const r = await scrub('apply', [holdWrong(own), holdWrong(bare), holdWrong(refuted, { ground: 'refuted_review' })]);
  assert.deepStrictEqual(r.refused.map(x => [x.id, x.code]), [[own, 'E_PRECONDITION'], [bare, 'E_PRECONDITION']]);
  assert.strictEqual(r.applied[0].id, refuted);
  assert.strictEqual(r.applied[0].facts.trigger, 'refuted_review');
});

test('S4 duplicate: a stored similarity of 0.80, or a report naming the kept note; the kept note must be live and kept', async () => {
  const kept = T.note('kept claim', { vec: A, created_at: 1000 });
  const near = T.note('near duplicate', { vec: A_NEAR, created_at: 2000 });
  const far = T.note('unrelated claim', { vec: B, created_at: 2000 });
  const reported = T.note('far but reported', { vec: B, reported_wrong: [T.report('worker:w2', kept)] });
  const dup = (id, of, over = {}) => ({ id, action: 'hold', kind: 'duplicate', of, ground: 'same_claim', reason: 'same claim in other words', cites: [T.cite], ...over });
  const r = await scrub('apply', [dup(near, kept), dup(far, kept), dup(reported, kept)]);
  assert.strictEqual(r.applied[0].facts.via, 'similarity');
  assert.ok(r.applied[0].facts.similarity >= 0.98);
  assert.strictEqual(r.refused[0].id, far);
  assert.match(r.refused[0].message, /not shown to duplicate/);
  assert.strictEqual(r.applied[1].facts.via, 'report');
  // a kept note that is itself held cannot be what another note stands against
  const heldKept = T.note('held kept', { vec: A, reported_wrong: [T.report()] });
  assert.strictEqual((await scrub('apply', [holdWrong(heldKept)])).applied[0].outcome, 'held');
  const again = T.note('another near', { vec: A_NEAR });
  const hk = await scrub('apply', [dup(again, heldKept)]);
  assert.strictEqual(hk.refused[0].code, 'E_PRECONDITION');
  assert.match(hk.refused[0].message, /itself held/);
  const refutedKept = T.note('refuted kept', { vec: A, status: 'refuted' });
  const rk = await scrub('apply', [dup(again, refutedKept)]);
  assert.strictEqual(rk.refused[0].code, 'E_PRECONDITION');
  assert.match(rk.refused[0].message, /refuted/);
});

test('S4 superseded: the replacement must be live and newer', async () => {
  const old = T.note('old claim', { created_at: 1000 }), newer = T.note('newer claim', { created_at: 5000 }), older = T.note('even older claim', { created_at: 10 });
  const sup = (id, of) => ({ id, action: 'hold', kind: 'superseded', of, ground: 'replaced_by_newer', reason: 'a newer note states it', cites: [T.cite] });
  const r = await scrub('apply', [sup(old, newer), sup(newer, older), sup(older, 'no-such-note')]);
  assert.strictEqual(r.applied[0].outcome, 'held');
  assert.strictEqual(r.refused[0].code, 'E_PRECONDITION');
  assert.match(r.refused[0].message, /not newer/);
  assert.strictEqual(r.refused[1].code, 'E_PRECONDITION');
});

test('a hold writes the held row and leaves the note live in project, with its pointer; a second hold waits for the reviewer', async () => {
  const n = T.note('held target', { reported_wrong: [T.report()] });
  const r = await scrub('apply', [holdWrong(n)]);
  const h = r.applied[0];
  assert.strictEqual(h.outcome, 'held');
  assert.strictEqual(h.held.namespace, `held/${PROJECT}`);
  assert.deepStrictEqual({ state: h.held.body.state, note_id: h.held.body.note_id, kind: h.held.body.kind, run_id: h.held.body.run_id, head_sha: h.held.body.head_sha }, { state: 'held', note_id: n, kind: 'wrong', run_id: 'lc-apply', head_sha: T.head });
  assert.strictEqual(h.held.body.cites[0].quote, T.cite.quote);
  assert.strictEqual(h.held.body.scrub.verified[0].source, `loader.js@${T.head.slice(0, 12)}`, 'the scrub receipt names what was verified');
  assert.strictEqual(T.row(n).namespace, `project/${PROJECT}`, 'the note stays live');
  assert.strictEqual(T.body(n).held.row, h.held.id);
  const idx = await T.call(T.who.tool('apply'), 'memory.index', { max_bytes: 4096 }); // a held note ranks last (ADR 0047 amendment of 2026-10-25), so room is given
  assert.ok(idx.row_ids.includes(n), 'a held note is still in the index candidate set');
  const again = await scrub('apply', [holdWrong(n)]);
  assert.strictEqual(again.refused[0].code, 'E_EXISTS');
  assert.strictEqual(heldRows().filter(x => x.id === h.held.id).length, 1);
});

test('the alarm: more holds than scrub_alarm_holds still succeed and carry an alarm field', async () => {
  const ids = [1, 2, 3].map(i => T.note(`alarm ${i}`, { reported_wrong: [T.report()] }));
  const r = await scrub('alarm', ids.map(id => holdWrong(id)));
  assert.strictEqual(r.counts.holds, 3);
  assert.strictEqual(r.applied.length, 3);
  assert.strictEqual(r.alarm.kind, 'many_holds');
  assert.strictEqual(r.alarm.limit, 2);
  const two = [T.note('quiet 1', { reported_wrong: [T.report()] }), T.note('quiet 2', { reported_wrong: [T.report()] })];
  assert.strictEqual((await scrub('alarm', two.map(id => holdWrong(id)))).alarm, undefined, 'at the limit is not over it');
});

test('propose mode writes proposals and applies nothing, refused entries are not proposed', async () => {
  const ok = T.note('proposed hold', { reported_wrong: [T.report()] }), bare = T.note('proposed without a trigger');
  const before = heldRows().length;
  const r = await scrub('propose', [holdWrong(ok), holdWrong(bare), { id: ok, action: 'dismiss' }].slice(0, 2));
  assert.strictEqual(r.mode, 'propose');
  assert.strictEqual(r.applied.length, 0);
  assert.strictEqual(r.proposed.length, 1);
  assert.strictEqual(r.refused[0].id, bare);
  const p = r.proposed[0].row;
  assert.strictEqual(p.namespace, `proposal/${PROJECT}`);
  assert.strictEqual(p.body.note_id, ok);
  assert.strictEqual(p.body.entry.kind, 'wrong');
  assert.strictEqual(heldRows().length, before, 'no held row');
  assert.strictEqual(T.body(ok).held, undefined, 'the note is untouched');
  assert.ok(proposalRows().length >= 1);
  const listed = await T.call(T.who.operator('propose'), 'memory.proposals', {});
  assert.ok(listed.proposals.some(x => x.id === p.id));
});

test('dismiss ends the report without hiding anything and leaves a receipt on the note', async () => {
  const n = T.note('dismissed report', { reported_wrong: [T.report()] });
  const r = await scrub('apply', [{ id: n, action: 'dismiss', ground: 'code_supports_note', reason: 'the loader does skip unlisted fixtures', cites: [T.cite] }]);
  assert.strictEqual(r.applied[0].outcome, 'applied');
  assert.strictEqual(T.body(n).dismissed[0].ground, 'code_supports_note');
  assert.strictEqual(T.row(n).namespace, `project/${PROJECT}`);
  assert.strictEqual(T.body(n).held, undefined);
});

test('resolve settles a pending note with the existing resolve logic; a pending hold is applied directly, no review', async () => {
  const live = T.note('resolve target', { vec: A, created_at: 100 });
  const pend = T.note('pending repeat', { ns: `pending/${PROJECT}`, vec: A_NEAR, state: 'pending', matches: [{ id: live, title: 'resolve target', kind: 'lesson', basis: 'observed', similarity: 0.99 }], task_id: 'other-task' });
  const r = await scrub('apply', [{ id: pend, action: 'resolve', resolve: 'repeats', of: live, ground: 'same_claim', reason: 'same claim', cites: [] }]);
  assert.strictEqual(r.applied[0].resolved.resolved, 'repeats');
  assert.strictEqual(T.row(pend).namespace, `archive/${PROJECT}`, 'nothing is deleted: the pending row is archived');
  assert.strictEqual(T.body(pend).archived.of, live);
  assert.strictEqual(T.body(live).seen_total, 1);
  const pend2 = T.note('pending wrong', { ns: `pending/${PROJECT}`, vec: B, state: 'pending', reported_wrong: [T.report()] });
  const h = await scrub('apply', [holdWrong(pend2)]);
  assert.strictEqual(h.applied[0].outcome, 'archived_directly');
  assert.strictEqual(T.row(pend2).namespace, `archive/${PROJECT}`);
  assert.strictEqual(T.body(pend2).archived.direct, true);
  const outOfState = await scrub('apply', [{ id: live, action: 'resolve', resolve: 'new', reason: 'x' }]);
  assert.strictEqual(outOfState.refused[0].code, 'E_ARGS', 'resolve acts on a pending note only');
});

test('draft stores a promotion draft and promotes nothing', async () => {
  const n = T.note('nominated note');
  const r = await scrub('apply', [{ id: n, action: 'draft', reason: 'three tasks saw it', draft: { rule: 'Never read fixtures outside the manifest.', target: 'CLAUDE.md' } }]);
  const d = r.applied[0].draft;
  assert.strictEqual(d.namespace, `draft/${PROJECT}`);
  assert.deepStrictEqual({ note_id: d.body.note_id, target: d.body.target }, { note_id: n, target: 'CLAUDE.md' });
  assert.strictEqual(T.row(n).namespace, `project/${PROJECT}`);
  assert.strictEqual(T.body(n).promoted_to, undefined);
});


test('the duplicate and supersede cosine is the notes_match_threshold lever: a stricter run refuses a pair the default accepts', async () => {
  const kept = T.note('lever kept claim', { vec: A, created_at: 1000 });
  const near = T.note('lever near duplicate', { vec: A_NEAR, created_at: 2000 });
  const dup = { id: near, action: 'hold', kind: 'duplicate', of: kept, ground: 'same_claim', reason: 'same claim in other words', cites: [T.cite] };
  const strict = await scrub('strict', [dup]);
  assert.strictEqual(strict.refused.length, 1);
  assert.strictEqual(strict.refused[0].code, 'E_PRECONDITION');
  assert.match(strict.refused[0].message, /needs 0\.995/);
  const loose = await scrub('apply', [dup]);
  assert.strictEqual(loose.applied[0].facts.via, 'similarity');
  const newer = T.note('lever replacement', { vec: A_NEAR, created_at: 5000 });
  const sup = { id: kept, action: 'hold', kind: 'superseded', of: newer, ground: 'replaced_by_newer', reason: 'a newer note says it', cites: [T.cite] };
  const s = await scrub('strict', [sup]);
  assert.strictEqual(s.refused[0].code, 'E_PRECONDITION');
  assert.match(s.refused[0].message, /needs 0\.995/);
});

test('a short real quote is accepted by the scrub cite check; empty, whitespace, over-long and absent quotes are refused', async () => {
  const n = T.note('short scrub target', { reported_wrong: [T.report()] });
  for (const quote of ['', '   ', 'x'.repeat(2001)]) {
    await assert.rejects(scrub('apply', [holdWrong(n, { cites: [{ where: 'loader.js', quote }] })]), x => x.code === 'E_ARGS', JSON.stringify(quote.slice(0, 5)));
  }
  const absent = await scrub('apply', [holdWrong(n, { cites: [{ where: 'loader.js', quote: 'nope()' }] })]);
  assert.strictEqual(absent.refused[0].code, 'E_CITATION');
  const bracket = await scrub('apply', [holdWrong(n, { cites: [{ where: 'loader.js', quote: '}' }] })]);
  assert.strictEqual(bracket.refused[0].code, 'E_CITATION', 'a bare bracket line proves nothing was read');
  const ok = await scrub('apply', [holdWrong(n, { cites: [{ where: 'loader.js', quote: 'function load(name) {' }, { where: 'loader.js', quote: 'return fixtures.get(name);' }] })]);
  assert.strictEqual(ok.refused.length, 0, JSON.stringify(ok.refused));
  assert.strictEqual(ok.applied[0].outcome, 'held');
});

test('a 1500-byte verbatim quote is accepted by the scrub apply path', async () => {
  const fs = require('node:fs');
  const n = T.note('long quote scrub target', { reported_wrong: [T.report()] });
  const long = 'long line ' + 'abcdefghij'.repeat(149) + 'END';
  const stream = `${T.dir}/long-scrub.jsonl`;
  fs.writeFileSync(stream, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: long }] }] } })}\n`);
  const ok = await scrub('apply', [holdWrong(n, { cites: [{ where: `stream:${stream}`, quote: long }, { where: 'loader.js', quote: 'function load(name) {' }] })], null, { evidence_files: [stream] });
  assert.strictEqual(ok.refused.length, 0, JSON.stringify(ok.refused));
  assert.strictEqual(ok.applied[0].outcome, 'held');
});
