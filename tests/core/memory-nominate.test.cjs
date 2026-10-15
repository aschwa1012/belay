'use strict';
// memory-nominate.test.cjs — nomination of a note for promotion to an instruction file: the independent-sighting count,
// the 3-task / 2-run bar, no renomination, reject then a new sighting, the operator's approve and reject with their
// receipts, nominationsForScope, and the reads (proposals with nominations, the promoted-text check). Deterministic: the
// facts are planted straight into the store, nothing starts a session.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { setup, PROJECT, A, A_NEAR } = require('./lifecycle-env.cjs');
const { callerFor } = require('./helpers.cjs');
const NM = require('../../src/core/memory-nominate.cjs');

let T;
before(async () => { T = await setup(); });
after(() => T.close());

let ids = 0;
const sight = (task, run, w = 'w2', over = {}) => ({ task_id: task, written_by: `worker:${w}`, run_id: run, in_index_beforehand: false, at: 5000, evidence: [], ...over });
// A note authored in (author task, run rA) with the given later sightings.
function mk(seen, over = {}) {
  const k = ++ids;
  return T.note(`nominee ${k} about the gate`, { task_id: `a${k}`, run_id: 'rA', created_at: 1000, seen_in: seen(k), seen_total: 0, ...over });
}
const nominate = (run = 'propose') => T.call(T.who.harness(run), 'memory.nominate', {});
const chance = (note, task, worker, route, at, key) => T.call(T.who.tool('propose'), 'memory.recordEvent', {
  kind: 'note_chance', worker_id: worker, task_id: task, row_ids: [note], key: key || `${task}:${worker}:${note}:${route}:${++ids}`, message: JSON.stringify({ route, delivered_at: at, used: false }),
});
const hits = (r, id) => r.nominated.filter(n => n.body.note_id === id);
const skippedFor = (r, id) => r.skipped.find(s => s.id === id);

test('the bar is 3 distinct tasks across 2 distinct runs, counted over the author and the sightings', async () => {
  const two = mk(k => [sight(`b${k}`, 'rB')]);                              // 2 tasks, 2 runs
  const oneRun = mk(k => [sight(`b${k}`, 'rA', 'w2'), sight(`c${k}`, 'rA', 'w3')]); // 3 tasks, 1 run
  const exact = mk(k => [sight(`b${k}`, 'rA', 'w2'), sight(`c${k}`, 'rB', 'w3')]);  // 3 tasks, 2 runs
  const r = await nominate();
  assert.strictEqual(hits(r, two).length, 0);
  assert.strictEqual(hits(r, oneRun).length, 0);
  const h = hits(r, exact);
  assert.strictEqual(h.length, 1, 'exactly the bar nominates');
  assert.deepStrictEqual([h[0].body.counts.tasks, h[0].body.counts.runs, h[0].body.state], [3, 2, 'nominated']);
  assert.strictEqual(h[0].namespace, `nomination/${PROJECT}`);
  assert.strictEqual(h[0].type, 'nomination');
  assert.deepStrictEqual(h[0].body.sightings.map(s => s.via), ['author', 'seen_in', 'seen_in']);
  assert.strictEqual(r.run_id, 'lc-propose');
});

test('the same writer in the same task counts once; a second writer in that task is the same task', async () => {
  const n = mk(k => [sight(`b${k}`, 'rB', 'w2'), sight(`b${k}`, 'rB', 'w2', { at: 6000 }), sight(`b${k}`, 'rB', 'w3')]);
  const c = await NM.countFor(T.E, T.row(n));
  assert.strictEqual(c.sightings.length, 3, 'author, w2 in b, w3 in b; the repeat of w2 is dropped');
  assert.deepStrictEqual([c.tasks, c.runs], [2, 2], 'two writers in one task are one task');
  assert.strictEqual(hits(await nominate(), n).length, 0);
});

test('a writer shown the note by the index flag, a search or a retrieve beforehand is not independent; the others are', async () => {
  const third = (k, shownKind) => [sight(`b${k}`, 'rB', 'w2'), sight(`c${k}`, 'rA', 'w3', shownKind === 'flag' ? { in_index_beforehand: true } : {})];
  const flag = mk(k => third(k, 'flag'));
  const idx = mk(k => third(k)), srch = mk(k => third(k)), ret = mk(k => third(k));
  const task = id => T.body(id).seen_in[1].task_id;
  await chance(idx, task(idx), 'w3', 'index', 4000);
  await chance(srch, task(srch), 'w3', 'search', 4500);
  await chance(ret, task(ret), 'w3', 'retrieve', 4800);
  const r = await nominate();
  for (const [id, why] of [[flag, 'index flag'], [idx, 'index'], [srch, 'search'], [ret, 'retrieve']]) {
    assert.strictEqual(hits(r, id).length, 0, `shown by ${why}: only 2 independent tasks are left`);
  }
  const c = await NM.countFor(T.E, T.row(srch));
  assert.deepStrictEqual(c.excluded.map(e => [e.writer, e.shown_by]), [['worker:w3', 'search']]);
});

test('a delivery that does not exclude: another task, another worker, or after the write', async () => {
  const n = mk(k => [sight(`b${k}`, 'rB', 'w2'), sight(`c${k}`, 'rA', 'w3')]);
  const c3 = T.body(n).seen_in[1].task_id, b2 = T.body(n).seen_in[0].task_id;
  await chance(n, 'elsewhere', 'w3', 'search', 4000);   // w3 was shown the note in another task
  await chance(n, c3, 'w9', 'index', 4000);             // another worker in w3's task
  await chance(n, c3, 'w3', 'retrieve', 9000);          // w3 saw it after it wrote its own (at 5000)
  await chance(n, b2, 'w2', 'index', 4999);             // ...but this one is just before w2's write
  const c = await NM.countFor(T.E, T.row(n));
  assert.deepStrictEqual(c.excluded.map(e => e.writer), ['worker:w2']);
  assert.deepStrictEqual([c.tasks, c.runs], [2, 1], 'author and w3 remain, both of run rA');
});

test('transferred sightings count, and their history answers for the archived duplicate', async () => {
  const kept = mk(k => [sight(`b${k}`, 'rB', 'w2', { transferred_from: 'dupe-row' }), sight(`c${k}`, 'rA', 'w3', { transferred_from: 'dupe-row' })]);
  const c = await NM.countFor(T.E, T.row(kept));
  assert.deepStrictEqual([c.tasks, c.runs, c.sightings.map(s => s.via)], [3, 2, ['author', 'transferred', 'transferred']]);
  assert.strictEqual(hits(await nominate(), kept).length, 1);
  // The duplicate's own delivery history: w3 had been shown the duplicate (listed in merged_from) in its task.
  const kept2 = mk(k => [sight(`b${k}`, 'rB', 'w2', { transferred_from: 'dupe-row' }), sight(`c${k}`, 'rA', 'w3', { transferred_from: 'dupe-row' })]);
  const dupe = T.note('the archived duplicate', { ns: `archive/${PROJECT}`, vec: A_NEAR });
  T.store.patchBody(kept2, b => { b.merged_from = [{ id: dupe, at: 1, seen_total: 1, seen_in: 1, deliveries: 1, own: false, via: 'x' }]; return b; });
  await chance(dupe, T.body(kept2).seen_in[1].task_id, 'w3', 'index', 4000);
  const c2 = await NM.countFor(T.E, T.row(kept2));
  assert.deepStrictEqual(c2.excluded.map(e => [e.writer, e.shown_by]), [['worker:w3', 'index']]);
  assert.strictEqual(c2.tasks, 2);
  // And the delivery history kept on the note with no chance behind it.
  const kept3 = mk(k => [sight(`b${k}`, 'rB', 'w2'), sight(`c${k}`, 'rA', 'w3')]);
  T.store.patchBody(kept3, b => { b.delivery_history = [{ from: dupe, route: 'search', run_id: 'rA', worker_id: 'w3', task_id: b.seen_in[1].task_id, at: 3000 }]; return b; });
  assert.strictEqual((await NM.countFor(T.E, T.row(kept3))).tasks, 2);
});

test('a real duplicate archive hands its sightings over and they count toward the bar', async () => {
  const kept = T.note('kept: nominee by merge about hooks', { vec: A, created_at: 100, task_id: 'k1', run_id: 'rA', seen_in: [sight('k2', 'rA', 'w2')] });
  const dupe = T.note('dupe: nominee by merge about hooks too', { vec: A_NEAR, created_at: 200, task_id: 'k3', run_id: 'rB', written_by: 'worker:w4', seen_in: [] });
  const ev = { head_sha: T.head, worktree: T.repo };
  const sc = await T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: [{ id: dupe, action: 'hold', kind: 'duplicate', of: kept, ground: 'same_claim', reason: 'same claim', cites: [T.cite] }], scope: [dupe, kept], ...ev });
  assert.strictEqual(sc.applied[0].outcome, 'held');
  const rv = await T.call(T.who.harness('apply'), 'memory.reviewApply', { verdicts: [{ id: dupe, verdict: 'archive', reason: 'confirmed', cites: [T.cite] }], ...ev });
  assert.strictEqual(rv.applied[0].outcome, 'archived');
  const c = await NM.countFor(T.E, T.row(kept));
  assert.deepStrictEqual([c.tasks, c.runs], [3, 2], 'the duplicate\'s author is a sighting of the kept note');
  assert.ok(c.sightings.some(s => s.task_id === 'k3' && s.via === 'transferred'));
  assert.strictEqual(hits(await nominate('apply'), kept).length, 1);
});

test('nomination is harness-only and needs notes; a note already nominated, promoted, held or refuted is not nominated again', async () => {
  await assert.rejects(T.call(T.who.tool('propose'), 'memory.nominate', {}), x => x.code === 'E_ROLE');
  await assert.rejects(T.call(T.who.harness('plain'), 'memory.nominate', {}), x => x.code === 'E_LEVER_OFF');
  await assert.rejects(T.call(T.who.harness('propose'), 'memory.nominate', { note_id: 'x' }), x => x.code === 'E_ARGS');
  const n = mk(k => [sight(`b${k}`, 'rB', 'w2'), sight(`c${k}`, 'rA', 'w3')]);
  const held = mk(k => [sight(`b${k}`, 'rB', 'w2'), sight(`c${k}`, 'rA', 'w3')]);
  T.store.patchBody(held, b => { b.held = { row: 'h', kind: 'wrong' }; return b; });
  const refuted = mk(k => [sight(`b${k}`, 'rB', 'w2'), sight(`c${k}`, 'rA', 'w3')], { status: 'refuted' });
  const first = await nominate();
  assert.strictEqual(hits(first, n).length, 1);
  assert.strictEqual(hits(first, held).length + hits(first, refuted).length, 0);
  assert.strictEqual(skippedFor(first, held).reason, 'held');
  assert.strictEqual(skippedFor(first, refuted).reason, 'refuted');
  const again = await nominate();
  assert.strictEqual(hits(again, n).length, 0);
  assert.strictEqual(skippedFor(again, n).reason, 'nominated', 'a nominated note is not nominated again');
  const rows = T.store.p("SELECT COUNT(*) AS c FROM memory_entries WHERE type = 'nomination' AND json_extract(body, '$.note_id') = ?").get(n).c;
  assert.strictEqual(rows, 1);
});

test('memory.promote: operator only, needs a nomination, and an approval needs a drafted rule', async () => {
  const n = mk(k => [sight(`b${k}`, 'rB', 'w2'), sight(`c${k}`, 'rA', 'w3')]);
  await nominate();
  const dec = { note_id: n, decision: 'approve', reason: 'ok' };
  for (const caller of [T.who.tool('propose'), T.who.harness('propose'), callerFor('worker', { run_id: 'lc-propose', worker_id: 'w1' })]) {
    await assert.rejects(T.call(caller, 'memory.promote', dec), x => x.code === 'E_ROLE', 'only the operator decides');
  }
  await assert.rejects(T.call(T.who.operator('propose'), 'memory.promote', dec), x => x.code === 'E_ARGS' && /no drafted rule/.test(x.message));
  await assert.rejects(T.call(T.who.operator('propose'), 'memory.promote', { note_id: n, decision: 'maybe' }), x => x.code === 'E_ARGS');
  await assert.rejects(T.call(T.who.operator('propose'), 'memory.promote', { note_id: n, decision: 'approve', extra: 1 }), x => x.code === 'E_ARGS');
  const plain = T.note('never nominated');
  await assert.rejects(T.call(T.who.operator('propose'), 'memory.promote', { note_id: plain, decision: 'reject' }), x => x.code === 'E_ARGS' && /never nominated/.test(x.message));
  assert.strictEqual(T.body(n).promoted_to, undefined, 'nothing was written by the refusals');
});

const draft = (run, id, rule, target) => T.call(T.who.harness(run), 'memory.scrubApply', { scrub: [{ id, action: 'draft', reason: 'the lesson holds', draft: { rule, target } }], scope: [id], ...T.evidence });

test('nominationsForScope lists the nominated notes that still need a draft, and stops asking once drafted or decided', async () => {
  const n = mk(k => [sight(`b${k}`, 'rB', 'w2'), sight(`c${k}`, 'rA', 'w3')]);
  const m = mk(k => [sight(`b${k}`, 'rB', 'w2'), sight(`c${k}`, 'rA', 'w3')]);
  await nominate();
  const want = () => NM.nominationsForScope(T.E, PROJECT).map(x => x.id);
  assert.ok(want().includes(n) && want().includes(m));
  const e = NM.nominationsForScope(T.E, PROJECT).find(x => x.id === n);
  assert.deepStrictEqual([typeof e.nomination_id, e.counts.tasks, e.title.startsWith('nominee')], ['string', 3, true]);
  const d = await draft('propose', n, 'Always mock the gate in tests.', 'CLAUDE.md');
  assert.strictEqual(d.proposed[0].action, 'draft', 'propose mode stores a draft proposal');
  assert.ok(!want().includes(n) && want().includes(m), 'a draft proposal answers the need');
  await draft('apply', m, 'Never call the gate live.', 'rules/CLAUDE.md');
  assert.ok(!want().includes(m), 'so does a draft row');
  assert.deepStrictEqual(NM.nominationsForScope(T.E, 'no-such-project'), []);
});

test('approve sets promoted_to from the draft and closes the nomination with a receipt; belay writes no instruction file', async () => {
  const n = mk(k => [sight(`b${k}`, 'rB', 'w2'), sight(`c${k}`, 'rA', 'w3')]);
  await nominate();
  await draft('apply', n, 'Mock the gate in unit tests.', 'CLAUDE.md');
  const before = fs.readdirSync(T.repo).sort();
  const r = await T.call(T.who.operator('propose'), 'memory.promote', { note_id: n, decision: 'approve', reason: 'seen by three workers' });
  assert.deepStrictEqual([r.note_id, r.decision, r.receipt.kind, r.receipt.by, r.receipt.reason], [n, 'approve', 'approve', 'operator', 'seen by three workers']);
  assert.deepStrictEqual([r.promoted_to.target, r.promoted_to.text, typeof r.promoted_to.at], ['CLAUDE.md', 'Mock the gate in unit tests.', 'number']);
  assert.deepStrictEqual(T.body(n).promoted_to, r.promoted_to, 'the row on disk says the same');
  assert.strictEqual(r.nomination.body.state, 'promoted');
  assert.strictEqual(r.nomination.body.decision.nomination, r.nomination.id);
  assert.strictEqual(r.receipt.draft.source, 'draft');
  assert.deepStrictEqual(fs.readdirSync(T.repo).sort(), before, 'no instruction file is created or edited');
  assert.strictEqual(T.row(n).namespace, `project/${PROJECT}`, 'the note stays; the index filter reads promoted_to');
  await assert.rejects(T.call(T.who.operator('propose'), 'memory.promote', { note_id: n, decision: 'approve' }), x => x.code === 'E_ARGS' && /promoted/.test(x.message), 'decided once');
  const again = await nominate();
  assert.strictEqual(hits(again, n).length, 0);
  assert.strictEqual(skippedFor(again, n).reason, 'promoted');
  assert.ok(!NM.nominationsForScope(T.E, PROJECT).some(x => x.id === n));
});

test('reject closes the nomination; no renomination until a new independent sighting, and a shown one does not count', async () => {
  const n = mk(k => [sight(`b${k}`, 'rB', 'w2'), sight(`c${k}`, 'rA', 'w3')]);
  const first = await nominate();
  const old = hits(first, n)[0];
  const r = await T.call(T.who.operator('propose'), 'memory.promote', { note_id: n, decision: 'reject', reason: 'too project specific' });
  assert.deepStrictEqual([r.decision, r.receipt.kind, r.receipt.reason, r.nomination.body.state], ['reject', 'reject', 'too project specific', 'rejected']);
  assert.strictEqual(r.promoted_to, undefined);
  assert.strictEqual(T.body(n).promoted_to, undefined);
  assert.strictEqual(r.nomination.body.rejected.keys.length, 3, 'the independent sightings at the moment of rejection');
  const same = await nominate();
  assert.strictEqual(skippedFor(same, n).reason, 'rejected, and no new independent sighting since');
  // a sighting whose writer had been shown the note adds nothing
  T.store.patchBody(n, b => { b.seen_in.push(sight('d-shown', 'rC', 'w5', { in_index_beforehand: true })); return b; });
  assert.strictEqual(hits(await nominate(), n).length, 0);
  // a new independent sighting renominates, as a new row that points back
  T.store.patchBody(n, b => { b.seen_in.push(sight('d-new', 'rC', 'w6')); return b; });
  const again = await nominate();
  const h = hits(again, n);
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].body.previous, old.id);
  assert.strictEqual(h[0].body.counts.tasks, 4);
  assert.strictEqual(T.row(old.id).type, 'nomination', 'the rejected nomination is kept');
  assert.strictEqual(JSON.parse(T.row(old.id).body).state, 'rejected');
  // and the second rejection does not forget the first
  await T.call(T.who.operator('propose'), 'memory.promote', { note_id: n, decision: 'reject' });
  assert.strictEqual(skippedFor(await nominate(), n).reason, 'rejected, and no new independent sighting since');
});

test('the lifecycle namespaces refuse a model write and a model delete', async () => {
  const n = mk(k => [sight(`b${k}`, 'rB', 'w2'), sight(`c${k}`, 'rA', 'w3')]);
  const id = (hits(await nominate(), n)[0] || { id: T.store.p("SELECT id FROM memory_entries WHERE type = 'nomination' AND json_extract(body, '$.note_id') = ?").get(n).id }).id;
  await assert.rejects(T.call(T.who.tool('propose'), 'memory.store', { namespace: `nomination/${PROJECT}`, text: 'forged nomination', type: 'nomination' }), x => x.code === 'E_ROLE');
  await assert.rejects(T.call(T.who.tool('propose'), 'memory.delete', { id }), x => x.code === 'E_ROLE');
});

test('proposals lists the nominations with their drafts; with the operator\'s root it says what the files hold', async () => {
  const n = mk(k => [sight(`b${k}`, 'rB', 'w2'), sight(`c${k}`, 'rA', 'w3')]);
  await nominate();
  let p = await T.call(T.who.operator('propose'), 'memory.proposals', { project: PROJECT });
  let mine = p.nominations.find(x => x.body.note_id === n);
  assert.ok(mine && mine.drafts.length === 0 && p.counts.nominations >= 1);
  await draft('apply', n, 'Stub the gate when testing the loader.', 'RULES.md');
  fs.writeFileSync(`${T.repo}/RULES.md`, '# Rules\n\nStub   the gate\nwhen testing the loader.\n');
  p = await T.call(T.who.operator('propose'), 'memory.proposals', { project: PROJECT, root: T.repo });
  mine = p.nominations.find(x => x.body.note_id === n);
  assert.deepStrictEqual([mine.drafts[0].source, mine.drafts[0].target, mine.drafts[0].present], ['draft', 'RULES.md', 'present'], 'whitespace re-wrapping still counts as present');
  assert.ok(!p.promoted_check.removed.some(x => x.note_id === n));
  await assert.rejects(T.call(T.who.tool('propose'), 'memory.proposals', { project: PROJECT, root: T.repo }), x => x.code === 'E_ROLE');
});

test('promotedCheck reports a promoted note whose text left its file, a missing file, and an unsafe target; it changes nothing', async () => {
  const mkP = async (rule, target) => {
    const n = mk(k => [sight(`b${k}`, 'rB', 'w2'), sight(`c${k}`, 'rA', 'w3')]);
    await nominate(); await draft('apply', n, rule, target);
    await T.call(T.who.operator('propose'), 'memory.promote', { note_id: n, decision: 'approve' });
    return n;
  };
  const kept = await mkP('Keep the manifest sorted.', 'KEEP.md');
  const gone = await mkP('Never retry the loader twice.', 'GONE.md');
  const nofile = await mkP('Run the gate suite last.', 'MISSING.md');
  const unsafe = await mkP('Escape hatch rule here.', '../outside.md');
  fs.writeFileSync(`${T.repo}/KEEP.md`, 'Keep the manifest sorted.\n');
  fs.writeFileSync(`${T.repo}/GONE.md`, 'Something else entirely now.\n');
  const before = T.store.p('SELECT COUNT(*) AS c, MAX(updated_at) AS u FROM memory_entries').get();
  const r = await T.call(T.who.operator('propose'), 'memory.promotedCheck', { root: T.repo, project: PROJECT });
  const st = Object.fromEntries(r.promoted.map(x => [x.note_id, x.state]));
  assert.deepStrictEqual([st[kept], st[gone], st[nofile], st[unsafe]], ['present', 'absent', 'file_missing', 'target_unsafe']);
  assert.deepStrictEqual(r.removed.map(x => x.note_id).filter(i => [kept, gone, nofile, unsafe].includes(i)).sort(), [gone, nofile].sort(), 'removed lists the text that left its file, and a file that is gone');
  assert.deepStrictEqual(T.store.p('SELECT COUNT(*) AS c, MAX(updated_at) AS u FROM memory_entries').get(), before, 'a read writes nothing');
  await assert.rejects(T.call(T.who.tool('propose'), 'memory.promotedCheck', { root: T.repo }), x => x.code === 'E_ROLE');
  await assert.rejects(T.call(T.who.operator('propose'), 'memory.promotedCheck', {}), x => x.code === 'E_ARGS');
});
