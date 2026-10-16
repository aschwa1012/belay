'use strict';
// memory-relations.test.cjs — the fourth resolution `refines` at write time, and the scrubber's relation verdicts on two live notes
// (`relate`): applied directly behind the gates, history moved or kept per relation, propose mode applying nothing, restore undoing a
// move, and `hold` / `dismiss` refused from the scrubber.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT, A, A_NEAR, B } = require('./lifecycle-env.cjs');

let T;
before(async () => { T = await setup(); });
after(() => T.close());

const sighting = (task, n = 1) => Array.from({ length: n }, (_, i) => ({ task_id: `${task}-${i}`, written_by: `worker:s${i}`, run_id: 'old-run', at: 5 + i, evidence: [] }));
const scrub = (kind, entries) => T.call(T.who.harness(kind), 'memory.scrubApply', { scrub: entries, scope: entries.flatMap(e => [e.id, e.of].filter(Boolean)), ...T.evidence });
const relate = (id, relation, of, over = {}) => ({ id, action: 'relate', relation, of, reason: `they relate as ${relation}`, ...over });
const count = () => T.store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n;
const ns = id => T.row(id).namespace;
const restore = id => T.call(T.who.operator('apply'), 'memory.noteRestore', { id, reason: 'undo' });
const pair = (o = {}) => {
  const old = T.note('old claim', { vec: A, created_at: 100, seen_in: sighting('o', 2), seen_total: 2, ...(o.old || {}) });
  const neu = T.note('new claim', { vec: A_NEAR, created_at: 200, seen_in: [], seen_total: 0, ...(o.neu || {}) });
  return { old, neu };
};

test('write time: refines puts the new note live, archives the old as superseded and moves its history; restore undoes it', async () => {
  const old = T.note('refine old', { vec: A, created_at: 100, seen_in: sighting('r', 2), seen_total: 2 });
  const pend = T.note('refine new', { ns: `pending/${PROJECT}`, state: 'pending', vec: A_NEAR, matches: [{ id: old, title: 'refine old', kind: 'lesson', basis: 'observed', similarity: 0.99 }] });
  const before = count();
  const out = await T.call(T.who.operator('apply'), 'memory.noteResolve', { resolutions: [{ id: pend, resolve: 'refines', of: old }] });
  assert.strictEqual(out.resolved[0].resolved, 'refines');
  assert.strictEqual(count(), before, 'no row is added or deleted');
  assert.strictEqual(ns(pend), `project/${PROJECT}`);
  assert.strictEqual(ns(old), `archive/${PROJECT}`);
  const a = T.body(old).archived;
  assert.deepStrictEqual([a.kind, a.relation, a.of, a.history_moved.to], ['superseded', 'refines', pend, pend]);
  assert.strictEqual(T.body(pend).resolved.as, 'refines');
  assert.strictEqual(T.body(pend).seen_total, 3, 'the old note\'s two sightings and its own observation moved');
  assert.strictEqual(T.body(old).seen_total, 0);
  assert.deepStrictEqual(T.body(pend).merged_from.map(m => [m.id, m.via]), [[old, 'refines']]);
  const back = await restore(old);
  assert.strictEqual(back.restored, true);
  assert.strictEqual(ns(old), `project/${PROJECT}`);
  assert.deepStrictEqual([T.body(old).seen_total, T.body(pend).seen_total, (T.body(pend).merged_from || []).length], [2, 0, 0], 'history went back to the old note');
});

test('write time: refines takes evidence as optional, a missing of is refused, and a repeat of the same text shape still works', async () => {
  const old = T.note('refine ev old', { vec: A, created_at: 100 });
  const pend = T.note('refine ev new', { ns: `pending/${PROJECT}`, state: 'pending', vec: A_NEAR, matches: [{ id: old, title: 'x', kind: 'lesson', basis: 'observed', similarity: 0.99 }] });
  await assert.rejects(T.call(T.who.operator('apply'), 'memory.noteResolve', { resolutions: [{ id: pend, resolve: 'refines' }] }), x => x.code === 'E_ARGS' && /of must be/.test(x.message));
  await assert.rejects(T.call(T.who.operator('apply'), 'memory.noteResolve', { resolutions: [{ id: pend, resolve: 'refines', of: old, evidence: [{ where: 'x' }] }] }), x => x.code === 'E_ARGS');
  const ok = await T.call(T.who.operator('apply'), 'memory.noteResolve', { resolutions: [{ id: pend, resolve: 'refines', of: old, evidence: [{ where: 'src/x.js', saw: 'the caveat' }] }] });
  assert.strictEqual(ok.resolved[0].of, old);
  assert.strictEqual(T.body(pend).resolved.evidence[0].saw, 'the caveat');
});

test('the scrubber resolves a pending note as refines (apply), and propose mode only writes a proposal', async () => {
  const old = T.note('scrub refine old', { vec: A, created_at: 100, seen_in: sighting('sr', 1), seen_total: 1 });
  const mk = () => T.note('scrub refine new', { ns: `pending/${PROJECT}`, state: 'pending', vec: A_NEAR, matches: [{ id: old, title: 'x', kind: 'lesson', basis: 'observed', similarity: 0.99 }] });
  const p1 = mk();
  const prop = await scrub('propose', [{ id: p1, action: 'resolve', resolve: 'refines', of: old, reason: 'same lesson plus a caveat' }]);
  assert.deepStrictEqual([prop.counts.proposed, prop.counts.applied, prop.proposed[0].resolve], [1, 0, 'refines']);
  assert.deepStrictEqual([ns(p1), ns(old)], [`pending/${PROJECT}`, `project/${PROJECT}`], 'propose applied nothing');
  const done = await scrub('apply', [{ id: p1, action: 'resolve', resolve: 'refines', of: old, reason: 'same lesson plus a caveat' }]);
  assert.strictEqual(done.applied[0].resolved.resolved, 'refines');
  assert.deepStrictEqual([ns(p1), ns(old)], [`project/${PROJECT}`, `archive/${PROJECT}`]);
  assert.ok(T.body(p1).seen_total >= 2);
});

test('relate repeats: the newer is archived by default and its history moves to the older; keep id keeps the newer', async () => {
  const { old, neu } = pair({ neu: { seen_in: sighting('n', 1), seen_total: 1 } });
  const before = count();
  const r = await scrub('apply', [relate(neu, 'repeats', old)]);
  assert.deepStrictEqual([r.applied[0].archived, r.applied[0].kept, r.applied[0].facts.via], [neu, old, 'similarity']);
  assert.strictEqual(count(), before, 'nothing deleted');
  assert.deepStrictEqual([ns(neu), ns(old)], [`archive/${PROJECT}`, `project/${PROJECT}`]);
  assert.strictEqual(T.body(neu).archived.kind, 'duplicate');
  assert.strictEqual(T.body(old).seen_total, 2 + 2, 'the older kept its two and took the newer\'s one plus its own observation');
  assert.strictEqual(T.body(neu).seen_total, 0);
  await restore(neu);
  assert.deepStrictEqual([T.body(old).seen_total, T.body(neu).seen_total], [2, 1], 'restore gave the history back');

  const keepNew = await scrub('apply', [relate(neu, 'repeats', old, { keep: 'id' })]);
  assert.deepStrictEqual([keepNew.applied[0].archived, keepNew.applied[0].kept], [old, neu]);
  assert.strictEqual(ns(old), `archive/${PROJECT}`);
});

test('relate supersedes: the older is archived and keeps its history; the newer is untouched', async () => {
  const { old, neu } = pair();
  const r = await scrub('apply', [relate(old, 'supersedes', neu)]); // the entry may name either note first: the newer one stays
  assert.deepStrictEqual([r.applied[0].archived, r.applied[0].kept], [old, neu]);
  assert.strictEqual(ns(old), `archive/${PROJECT}`);
  assert.deepStrictEqual([T.body(old).seen_total, T.body(neu).seen_total, T.body(old).archived.history_moved], [2, 0, undefined]);
  assert.strictEqual(T.body(old).archived.relation, 'supersedes');
  await restore(old);
  assert.strictEqual(ns(old), `project/${PROJECT}`);
});

test('relate refines: the older is archived and its history moves to the newer; restore undoes it', async () => {
  const { old, neu } = pair();
  const r = await scrub('apply', [relate(neu, 'refines', old)]);
  assert.deepStrictEqual([r.applied[0].archived, r.applied[0].kept, r.applied[0].history_moved.to], [old, neu, neu]);
  assert.deepStrictEqual([T.body(old).seen_total, T.body(neu).seen_total], [0, 3]);
  await restore(old);
  assert.deepStrictEqual([T.body(old).seen_total, T.body(neu).seen_total], [2, 0]);
});

test('relate gates: (a) a score or a report, (b) both live', async () => {
  const far = pair({ neu: { vec: B } });
  const refused = await scrub('apply', [relate(far.neu, 'repeats', far.old)]);
  assert.deepStrictEqual([refused.refused[0].code, refused.counts.applied], ['E_PRECONDITION', 0]);
  assert.match(refused.refused[0].message, /not shown to be related/);
  // A worker report naming the pair opens the gate without a score.
  const rep = pair({ neu: { vec: B, reported_wrong: [{ ...T.report('worker:w2', null), run_id: 'lc-apply' }] } });
  T.store.patchBody(rep.neu, b => { b.reported_wrong[0].replaced_by = rep.old; return b; });
  const viaReport = await scrub('apply', [relate(rep.neu, 'refines', rep.old)]);
  assert.strictEqual(viaReport.applied[0].facts.via, 'report');
  // (b): an archived partner, a pending partner and a held partner are refused.
  const live = T.note('gate live', { vec: A, created_at: 300 });
  const archived = T.note('gate archived', { ns: `archive/${PROJECT}`, vec: A_NEAR, created_at: 100 });
  const pending = T.note('gate pending', { ns: `pending/${PROJECT}`, state: 'pending', vec: A_NEAR, created_at: 100 });
  const held = T.note('gate held', { vec: A_NEAR, created_at: 100 });
  T.store.patchBody(held, b => { b.held = { row: 'h1', kind: 'wrong', reason: 'x', run_id: 'r', at: 1 }; return b; });
  for (const other of [archived, pending, held]) {
    const r = await scrub('apply', [relate(live, 'repeats', other)]);
    assert.strictEqual(r.refused[0].code, r.refused[0].code === 'E_NOT_FOUND' ? 'E_NOT_FOUND' : 'E_PRECONDITION', other);
    assert.strictEqual(r.counts.applied, 0, other);
  }
  assert.strictEqual(ns(live), `project/${PROJECT}`);
  // A relation whose partner is unreachable (not in scope, no match, no report) is out of scope.
  const lone = T.note('gate lone', { vec: A, created_at: 400 });
  const out = await T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: [relate(live, 'repeats', lone)], scope: [live], ...T.evidence });
  assert.strictEqual(out.refused[0].code, 'E_SCOPE');
});

test('relate new records the judgement on both notes and archives nothing', async () => {
  const { old, neu } = pair();
  const r = await scrub('apply', [relate(neu, 'new', old)]);
  assert.strictEqual(r.applied[0].relation, 'new');
  assert.deepStrictEqual([ns(old), ns(neu)], [`project/${PROJECT}`, `project/${PROJECT}`]);
  assert.strictEqual(T.body(old).pair_judged[0].of, neu);
  assert.strictEqual(T.body(neu).pair_judged[0].of, old);
});

test('propose mode applies no relation: it writes proposals, and a pair that fails the gates is not proposed', async () => {
  const good = pair(), far = pair({ neu: { vec: B } });
  const before = count();
  const r = await scrub('propose', [relate(good.neu, 'refines', good.old), relate(far.neu, 'repeats', far.old)]);
  assert.deepStrictEqual([r.counts.proposed, r.counts.applied, r.counts.refused], [1, 0, 1]);
  assert.strictEqual(r.proposed[0].relation, 'refines');
  assert.strictEqual(count(), before + 1, 'one proposal row and nothing else');
  assert.deepStrictEqual([ns(good.old), ns(good.neu), T.body(good.old).seen_total], [`project/${PROJECT}`, `project/${PROJECT}`, 2]);
});

test('wrong, and every hold and dismissal, is refused from the scrubber; the held machinery still works through holdApply', async () => {
  const n = T.note('wrongly reported', { reported_wrong: [T.report()] });
  const asScrubber = T.E.handle('memory.scrubApply', { caller: T.who.harness('apply'), scrub: [
    { id: n, action: 'hold', kind: 'wrong', ground: 'report_confirmed', reason: 'it is wrong', cites: [T.cite] },
    { id: T.note('other reported', { reported_wrong: [T.report()] }), action: 'dismiss', ground: 'report_unfounded', reason: 'no' },
  ], scope: null, ...T.evidence });
  await assert.rejects(asScrubber, x => x.code === 'E_ARGS' || x.code === 'E_SCOPE');
  const ids = [n];
  const r = await T.E.handle('memory.scrubApply', { caller: T.who.harness('apply'), scrub: [{ id: n, action: 'hold', kind: 'wrong', ground: 'report_confirmed', reason: 'it is wrong', cites: [T.cite] }], scope: ids, ...T.evidence });
  assert.deepStrictEqual([r.counts.applied, r.refused[0].code], [0, 'E_ARGS']);
  assert.match(r.refused[0].message, /not a scrubber action/);
  assert.strictEqual(T.body(n).held, undefined);
  const viaSeam = await T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: [{ id: n, action: 'hold', kind: 'wrong', ground: 'report_confirmed', reason: 'it is wrong', cites: [T.cite] }], scope: ids, ...T.evidence });
  assert.strictEqual(viaSeam.applied[0].outcome, 'held');
});

test('shape: relate needs a relation, an of and keep only for repeats', async () => {
  const { old, neu } = pair();
  for (const bad of [{ relation: 'merge' }, { of: undefined }, { relation: 'refines', keep: 'id' }, { keep: 'neither', relation: 'repeats' }]) {
    await assert.rejects(scrub('apply', [relate(neu, 'repeats', old, bad)]), x => x.code === 'E_ARGS', JSON.stringify(bad));
  }
  assert.strictEqual(ns(old), `project/${PROJECT}`);
});
