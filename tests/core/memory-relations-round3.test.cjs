'use strict';
// memory-relations-round3.test.cjs — the second review's findings: v2 notes keep a `new` verdict, the scope offers only pairs the gate
// passes, a worker's report decides the direction, and a write-time refines or supersedes of a verified note is a hold.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT, A, A_NEAR, B } = require('./lifecycle-env.cjs');

let T;
before(async () => { T = await setup(); });
after(() => T.close());

const scrub = (kind, entries) => T.call(T.who.harness(kind), 'memory.scrubApply', { scrub: entries, scope: entries.flatMap(e => [e.id, e.of].filter(Boolean)), ...T.evidence });
const relate = (id, relation, of, over = {}) => ({ id, action: 'relate', relation, of, reason: `they relate as ${relation}`, ...over });
const scope = () => T.call(T.who.operator('apply'), 'memory.scrubScope', {});
const ns = id => T.row(id).namespace;
const v2 = id => T.store.p("UPDATE memory_entries SET text_template = 'v2' WHERE id = ?").run(id);
const offered = async id => (await scope()).items.some(i => i.id === id);
const match = (id, over = {}) => ({ id, title: 't', kind: 'lesson', basis: 'observed', similarity: 0.99, embedding_model: 'm', dim: 3, template: 'v1', ...over });
const report = (by, replaced_by) => ({ by: `worker:${by}`, worker_id: by, task_id: 'tx', run_id: 'lc-apply', why: 'a reason', at: 1, replaced_by });
const heldRows = () => T.store.p("SELECT id, body FROM memory_entries WHERE namespace = ? AND type = 'held'").all(`held/${PROJECT}`).map(r => JSON.parse(r.body));
const pendingFor = (title, target) => T.note(title, { ns: `pending/${PROJECT}`, state: 'pending', vec: A_NEAR, matches: [{ id: target, title: 'x', kind: 'lesson', basis: 'observed', similarity: 0.99 }] });

test('R1: a new verdict on two v2 notes settles the pair; v1 behaves the same', async () => {
  for (const t of ['v1', 'v2']) {
    const x = T.note(`r1 ${t} x`, { vec: A, created_at: 100 });
    const y = T.note(`r1 ${t} y`, { vec: A_NEAR, created_at: 200, matches: [match(x, { template: t })] });
    if (t === 'v2') { v2(x); v2(y); }
    assert.strictEqual(await offered(y), true, `${t}: offered before the verdict`);
    const r = await scrub('apply', [relate(y, 'new', x)]);
    assert.strictEqual(r.applied.length, 1, `${t}: the verdict applied`);
    assert.strictEqual(await offered(y), false, `${t}: not offered again`);
  }
});

test('R3: a legacy match with no model, on notes of different models, is not offered', async () => {
  const x = T.note('r3 x', { vec: A, created_at: 100 });
  const y = T.note('r3 y', { vec: A_NEAR, created_at: 200, matches: [{ id: x, similarity: 0.95 }] });
  T.store.p('UPDATE memory_entries SET embedding_model = ? WHERE id = ?').run('m2', x);
  assert.strictEqual(await offered(y), false);
});

test('R4: a recorded 0.85 against a stored cosine below the threshold is not offered', async () => {
  const x = T.note('r4 x', { vec: A, created_at: 100 });
  const y = T.note('r4 y', { vec: [0.7, 0.714, 0], created_at: 200, matches: [match(x, { similarity: 0.85 })] });
  assert.strictEqual(await offered(y), false);
});

test('R2: a report names the pair, so the reported note is the one archived even when the score passes', async () => {
  const old = T.note('r2 old', { vec: A, created_at: 100 });
  const neu = T.note('r2 new', { vec: A_NEAR, created_at: 200, reported_wrong: [report('w2', old)] });
  const r = await scrub('apply', [relate(neu, 'supersedes', old)]);
  assert.deepStrictEqual([r.applied[0].archived, r.applied[0].kept, r.applied[0].facts.via], [neu, old, 'similarity']);
  assert.strictEqual(ns(old), `project/${PROJECT}`);
  assert.strictEqual(ns(neu), `archive/${PROJECT}`);
});

test('R5: a verified note the worker reported wrong, even the newer one, becomes a hold for the reviewer', async () => {
  const old = T.note('r5 old', { vec: A, created_at: 100 });
  const neu = T.note('r5 new', { vec: B, created_at: 200, status: 'verified', reported_wrong: [report('w2', old)] });
  const r = await scrub('apply', [relate(neu, 'supersedes', old)]);
  assert.deepStrictEqual(r.refused, []);
  assert.deepStrictEqual([r.applied[0].outcome, ns(neu)], ['held', `project/${PROJECT}`]);
  assert.ok(heldRows().some(h => h.note_id === neu && h.of === old && h.state === 'held'));
});

test('R6: a write-time refines or supersedes of a verified note by an orchestrator is a hold, not an archive; the operator may still replace it', async () => {
  for (const resolve of ['refines', 'supersedes']) {
    const v = T.note(`r6 ${resolve} verified`, { vec: A, created_at: 100, status: 'verified' });
    const pend = pendingFor(`r6 ${resolve} new`, v);
    const out = await T.call(T.who.tool('apply'), 'memory.noteResolve', { resolutions: [{ id: pend, resolve, of: v, evidence: [{ where: 'a.js', saw: 'it changed' }] }] });
    assert.strictEqual(out.resolved[0].state, 'live');
    assert.ok(out.resolved[0].held_for_review, `${resolve}: held for review`);
    assert.strictEqual(ns(v), `project/${PROJECT}`, `${resolve}: the verified note is not archived`);
    assert.ok(T.body(v).held, `${resolve}: the note carries the hold`);
    assert.strictEqual(T.store.p('SELECT supersedes FROM memory_entries WHERE id = ?').get(pend).supersedes, null);
  }
  const v = T.note('r6 op verified', { vec: A, created_at: 100, status: 'verified' });
  const pend = pendingFor('r6 op new', v);
  const out = await T.call(T.who.operator('apply'), 'memory.noteResolve', { resolutions: [{ id: pend, resolve: 'refines', of: v }] });
  assert.strictEqual(out.resolved[0].held_for_review, undefined);
  assert.strictEqual(ns(v), `archive/${PROJECT}`);
});

test('Q1: only a report of the hold\'s own run, by another writer, waives the newer-than and same-subject checks of a superseded hold', async () => {
  const hold = (n, older) => T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: [{ id: n, action: 'hold', kind: 'superseded', of: older, ground: 'replaced_by_newer', reason: 'x', cites: [T.cite] }], scope: [n, older], ...T.evidence });
  const older = T.note('q1 unrelated older note', { vec: B, created_at: 50 });
  const stale = T.note('q1 stale', { vec: A, created_at: 200, reported_wrong: [T.report('worker:w2', older)] }); // run old-run
  const r1 = await hold(stale, older);
  assert.deepStrictEqual([r1.applied.length, r1.refused[0].code], [0, 'E_PRECONDITION'], 'an old run\'s report waives nothing');
  const own = T.note('q1 own writer', { vec: A, created_at: 200, reported_wrong: [{ ...report('w2', older), by: 'worker:w1', run_id: 'lc-apply' }] });
  T.store.p('UPDATE memory_entries SET written_by = ? WHERE id = ?').run('worker:w1', own);
  const r2 = await hold(own, older);
  assert.deepStrictEqual([r2.applied.length, r2.refused[0].code], [0, 'E_PRECONDITION'], 'the note\'s own writer\'s report waives nothing');
  const fresh = T.note('q1 fresh', { vec: A, created_at: 200, reported_wrong: [report('w2', older)] });
  const r3 = await hold(fresh, older);
  assert.deepStrictEqual([r3.refused.length, r3.applied[0].outcome], [0, 'held'], 'this run\'s report from another writer does');
});
