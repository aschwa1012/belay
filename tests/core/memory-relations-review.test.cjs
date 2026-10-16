'use strict';
// memory-relations-review.test.cjs — the review's findings on relations: the gate's score source, held rows closed by an archive, restore
// order after chains, verified notes, the report gate, delivery history on a second hop, the alarm, ties and the judged-pair record.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT, A, A_NEAR, B } = require('./lifecycle-env.cjs');

let T;
before(async () => { T = await setup(); });
after(() => T.close());

const sighting = (task, n = 1) => Array.from({ length: n }, (_, i) => ({ task_id: `${task}-${i}`, written_by: `worker:s${i}`, run_id: 'old-run', at: 5 + i, evidence: [] }));
const scrub = (kind, entries) => T.call(T.who.harness(kind), 'memory.scrubApply', { scrub: entries, scope: entries.flatMap(e => [e.id, e.of].filter(Boolean)), ...T.evidence });
const relate = (id, relation, of, over = {}) => ({ id, action: 'relate', relation, of, reason: `they relate as ${relation}`, ...over });
const ns = id => T.row(id).namespace;
const restore = id => T.call(T.who.operator('apply'), 'memory.noteRestore', { id, reason: 'undo' });
const heldOpen = () => T.store.p("SELECT id FROM memory_entries WHERE namespace = ? AND type = 'held' AND json_extract(body, '$.state') = 'held'").all(`held/${PROJECT}`).length;
const mkHold = async (id) => T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: [{ id, action: 'hold', kind: 'wrong', ground: 'report_confirmed', reason: 'it is wrong', cites: [T.cite] }], scope: [id], ...T.evidence });
const match = (id, over = {}) => ({ id, title: 't', kind: 'lesson', basis: 'observed', similarity: 0.99, embedding_model: 'm', dim: 3, template: 'v1', ...over });
const pendingOf = (title, target, over = {}) => T.note(title, { ns: `pending/${PROJECT}`, state: 'pending', vec: A_NEAR, matches: [{ id: target, title: 'x', kind: 'lesson', basis: 'observed', similarity: 0.99 }], ...over });

test('B1: the fresh stored cosine decides alone; a recorded match counts only with no cosine, and only if it names the same model and dim', async () => {
  const x = T.note('b1 x', { vec: A, created_at: 100 });
  const y = T.note('b1 y', { vec: B, created_at: 200, matches: [match(x)] });
  const stale = await scrub('apply', [relate(y, 'supersedes', x)]);
  assert.deepStrictEqual([stale.counts.applied, stale.refused[0].code], [0, 'E_PRECONDITION'], 'a 0.99 record cannot override a cosine of 0');
  assert.strictEqual(ns(x), `project/${PROJECT}`);
  const p = T.note('b1 p', { vec: null, created_at: 100 });
  const q = T.note('b1 q', { vec: null, created_at: 200, matches: [match(p)] });
  const ok = await scrub('apply', [relate(q, 'supersedes', p)]);
  assert.deepStrictEqual([ok.applied[0].facts.source, ns(p)], ['recorded_match', `archive/${PROJECT}`]);
  const r = T.note('b1 r', { vec: null, created_at: 100 });
  const s = T.note('b1 s', { vec: null, created_at: 200, matches: [match(r, { embedding_model: 'other' }), match(r, { dim: 4 }), { ...match(r), embedding_model: undefined }, match(r, { template: 'v2' })] });
  const no = await scrub('apply', [relate(s, 'supersedes', r)]);
  assert.deepStrictEqual([no.counts.applied, no.refused[0].code], [0, 'E_PRECONDITION']);
});

test('B1b: vectors of different templates are never compared', async () => {
  const x = T.note('b1b x', { vec: A, created_at: 100 });
  const y = T.note('b1b y', { vec: A_NEAR, created_at: 200 });
  T.store.p("UPDATE memory_entries SET text_template = 'v2' WHERE id = ?").run(y);
  const r = await scrub('apply', [relate(y, 'supersedes', x)]);
  assert.deepStrictEqual([r.counts.applied, r.refused[0].code], [0, 'E_PRECONDITION']);
});

test('B2: a refines (write time or scrubber) that archives a held note closes its held row', async () => {
  const old = T.note('b2 old', { vec: A, created_at: 100, reported_wrong: [T.report()] });
  assert.strictEqual((await mkHold(old)).applied[0].outcome, 'held');
  const open = heldOpen();
  const heldRow = T.body(old).held.row;
  const pend = pendingOf('b2 new', old);
  await T.call(T.who.operator('apply'), 'memory.noteResolve', { resolutions: [{ id: pend, resolve: 'refines', of: old }] });
  assert.strictEqual(ns(old), `archive/${PROJECT}`);
  assert.strictEqual(heldOpen(), open - 1, 'the open hold count dropped');
  assert.deepStrictEqual([T.body(heldRow).state, T.body(heldRow).reviews.pop().outcome, T.body(old).archived.held_row_closed], ['closed', 'closed', heldRow]);
  const old2 = T.note('b2 old two', { vec: A, created_at: 100, reported_wrong: [T.report()] });
  await mkHold(old2);
  const pend2 = pendingOf('b2 new two', old2);
  const open2 = heldOpen();
  await scrub('apply', [{ id: pend2, action: 'resolve', resolve: 'refines', of: old2, reason: 'same lesson plus a caveat' }]);
  assert.strictEqual(heldOpen(), open2 - 1);
});

test('B3: restoring a refines chain in any order ends at the same counts, and exactly the right rows come back', async () => {
  for (const order of [['b', 'a'], ['a', 'b']]) {
    const b = T.note(`b3 b ${order}`, { vec: A, created_at: 100, seen_in: sighting('b', 2), seen_total: 2 });
    const a = T.note(`b3 a ${order}`, { vec: A_NEAR, created_at: 200, seen_in: sighting('a', 1), seen_total: 1 });
    const c = T.note(`b3 c ${order}`, { vec: A, created_at: 300 });
    await scrub('apply', [relate(a, 'refines', b)]);
    await scrub('apply', [relate(c, 'refines', a)]);
    const tot = () => [T.body(b).seen_total, T.body(a).seen_total, T.body(c).seen_total];
    assert.deepStrictEqual(tot(), [0, 0, 5], 'everything is on the head of the chain');
    const ids = { a, b };
    await restore(ids[order[0]]);
    await restore(ids[order[1]]);
    assert.deepStrictEqual(tot(), [2, 1, 0], `restored ${order.join(' then ')}`);
    assert.strictEqual(T.body(c).merged_from.length, 0);
    assert.deepStrictEqual([T.body(b).seen_in.length, T.body(a).seen_in.length], [2, 1], 'the rows are back with their owners');
  }
  const x = T.note('b3 x', { vec: A, created_at: 100, seen_in: sighting('x', 1), seen_total: 1 });
  const y = T.note('b3 y', { vec: A, created_at: 200, seen_in: sighting('y', 1), seen_total: 1 });
  const z = T.note('b3 z', { vec: A, created_at: 50 });
  await scrub('apply', [relate(y, 'repeats', x)]);
  await scrub('apply', [relate(x, 'repeats', z)]);
  assert.deepStrictEqual([T.body(x).seen_total, T.body(y).seen_total, T.body(z).seen_total], [0, 0, 4]);
  await restore(y);
  await restore(x);
  assert.deepStrictEqual([T.body(x).seen_total, T.body(y).seen_total, T.body(z).seen_total], [1, 1, 0], 'a duplicate chain too');
});

test('should-fix 4: the second hop of a chain carries the first hop\'s delivery history, and a restore takes it back out', async () => {
  const b = T.note('d b', { vec: A, created_at: 100 });
  const a = T.note('d a', { vec: A_NEAR, created_at: 200 });
  const c = T.note('d c', { vec: A, created_at: 300 });
  T.store.patchBody(b, x => { x.delivery_history = [{ from: b, hops: [b], kind: 'index_injected', route: 'index', task_id: 't9', worker_id: 'w9', at: 1 }]; return x; });
  await scrub('apply', [relate(a, 'refines', b)]);
  assert.strictEqual(T.body(a).delivery_history.length, 1);
  await scrub('apply', [relate(c, 'refines', a)]);
  assert.deepStrictEqual(T.body(c).delivery_history.map(d => d.hops), [[b, a]]);
  assert.deepStrictEqual([T.body(a).delivery_history.length, T.body(b).delivery_history.length], [0, 0]);
  await restore(b);
  assert.strictEqual(T.body(c).delivery_history.length, 0);
});

test('should-fix 1: a relation that would archive a verified note becomes a hold for the reviewer; a scrubber resolve against one is refused', async () => {
  const ver = T.note('sf1 verified', { vec: A, created_at: 100, status: 'verified' });
  const dupe = T.note('sf1 duplicate', { vec: A_NEAR, created_at: 200 });
  const before = heldOpen();
  const r = await scrub('apply', [relate(dupe, 'repeats', ver, { keep: 'id' })]);
  assert.deepStrictEqual([r.applied[0].outcome, r.applied[0].kind, ns(ver), heldOpen()], ['held', 'duplicate', `project/${PROJECT}`, before + 1]);
  assert.strictEqual(T.body(ver).held.of, dupe);
  const old = T.note('sf1 verified old', { vec: A, created_at: 100, status: 'verified' });
  const pend = pendingOf('sf1 pending', old);
  const res = await scrub('apply', [{ id: pend, action: 'resolve', resolve: 'refines', of: old, reason: 'caveat' }]);
  assert.strictEqual(res.refused[0].code, 'E_PRECONDITION');
  assert.strictEqual(ns(old), `project/${PROJECT}`);
});

test('should-fix 3: a report counts only from this run and from another writer, and it gives the direction', async () => {
  const mk = (rep) => { const o = T.note('sf3 older', { vec: A, created_at: 100 }); const n = T.note('sf3 newer', { vec: B, created_at: 200 }); T.store.patchBody(n, b => { b.reported_wrong = [rep(o)]; return b; }); return { o, n }; };
  const good = o => ({ ...T.report('worker:w2', o), run_id: 'lc-apply' });
  const oldRun = mk(o => ({ ...good(o), run_id: 'old-run' }));
  assert.strictEqual((await scrub('apply', [relate(oldRun.n, 'repeats', oldRun.o)])).refused[0].code, 'E_PRECONDITION', 'an old run\'s report');
  const own = mk(o => ({ ...good(o), by: 'worker:w1' }));
  assert.strictEqual((await scrub('apply', [relate(own.n, 'repeats', own.o)])).refused[0].code, 'E_PRECONDITION', 'the note\'s own writer');
  const dir = mk(good);
  const r = await scrub('apply', [relate(dir.n, 'supersedes', dir.o)]);
  assert.deepStrictEqual([r.applied[0].archived, r.applied[0].kept, r.applied[0].facts.via], [dir.n, dir.o, 'report'], 'the reported note is archived although it is the newer');
});

test('should-fix 5: a pending repeat is not counted by the alarm', async () => {
  const live = T.note('sf5 live', { vec: A, created_at: 100 });
  const ids = [1, 2, 3].map(i => pendingOf(`sf5 pending ${i}`, live, { task_id: `sf5-${i}` }));
  const r = await scrub('alarm', ids.map(id => ({ id, action: 'resolve', resolve: 'repeats', of: live, reason: 'same claim' })));
  assert.deepStrictEqual([r.counts.applied, r.counts.archives, r.alarm], [3, 0, undefined]);
});

test('should-fix 6: notes written in the same millisecond are ordered by insertion', async () => {
  const first = T.note('sf6 first', { vec: A, created_at: 500 });
  const second = T.note('sf6 second', { vec: A_NEAR, created_at: 500 });
  const r = await scrub('apply', [relate(first, 'supersedes', second)]);
  assert.deepStrictEqual([r.applied[0].archived, r.applied[0].kept], [first, second]);
});

test('should-fix 7: a superseded partner is not offered', async () => {
  const partner = T.note('sf7 partner', { vec: A, created_at: 100 });
  const n = T.note('sf7 note', { vec: A_NEAR, created_at: 200, matches: [match(partner)] });
  const newer = T.note('sf7 replacement', { vec: B, created_at: 300 });
  T.store.setSupersedes(newer, partner);
  const s = await T.call(T.who.operator('apply'), 'memory.scrubScope', {});
  assert.strictEqual((s.items.find(i => i.id === n) || {}).why, undefined);
});

test('should-fix 8: a new verdict is dropped when a note\'s text changes, and a cut of the oldest is recorded', async () => {
  const hub = T.note('sf8 hub', { vec: A, created_at: 100 });
  const parts = Array.from({ length: 21 }, (_, i) => T.note(`sf8 partner ${i}`, { vec: A_NEAR, created_at: 200 + i }));
  for (const p of parts) await scrub('apply', [relate(hub, 'new', p)]);
  const h = T.body(hub);
  assert.deepStrictEqual([h.pair_judged.length, h.pair_judged_cut.count], [20, 1]);
  assert.match(h.pair_judged_cut.note, /may be offered again/);
  const p = parts[5];
  T.store.patchBody(p, b => { b.matches = [match(hub)]; return b; });
  const s1 = await T.call(T.who.operator('apply'), 'memory.scrubScope', {});
  assert.strictEqual((s1.items.find(i => i.id === p) || {}).why, undefined, 'judged: not offered');
  T.store.p("UPDATE memory_entries SET text_hash = 'changed' WHERE id = ?").run(p);
  const s2 = await T.call(T.who.operator('apply'), 'memory.scrubScope', {});
  assert.deepStrictEqual((s2.items.find(i => i.id === p) || {}).why, ['matched'], 'the text changed, so the pair is open again');
});
