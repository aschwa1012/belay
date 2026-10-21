'use strict';
// memory-report-gate.test.cjs — which worker reports open the scrubber's relation gate, and the gate's other guards.
//   A report a reviewer REJECTED is not evidence: it opens no relate gate, names no pair for the scrubber, gives no direction, and is
//   shown to the scrubber as rejected and to workers not at all. An UNJUDGED report is a worker's say-so: it opens no relate gate and
//   archives nothing; only a report a reviewer UPHELD does.
//   Gate (b) (both notes live) and the redaction of a relation's reason are pinned here, each by a case a one-line change would fail.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT, A, A_NEAR, B } = require('./lifecycle-env.cjs');
const F = require('../../src/core/memory-facts.cjs');

let T;
before(async () => { T = await setup(); });
after(() => T.close());

const RUN = 'lc-apply';
const rep = (to, over = {}) => ({ by: 'worker:w2', worker_id: 'w2', task_id: 'tx-1', run_id: RUN, why: 'it is wrong', replaced_by: to, at: 11, ...over });
const rejected = (over = {}) => ({ task_id: 'tx-1', report_at: 11, verdict: 'rejected', by: 'rev-1', ref: 'rt-1', at: 20, ...over });
const setBody = (id, fn) => { const b = T.body(id); fn(b); T.store.p('UPDATE memory_entries SET body = ? WHERE id = ?').run(JSON.stringify(b), id); };
const upheld = (over = {}) => rejected({ verdict: 'upheld', ...over });
const relate = (id, relation, of, over = {}) => ({ id, action: 'relate', relation, of, reason: `they relate as ${relation}`, ...over });
const scrub = (kind, entries) => T.call(T.who.harness(kind), 'memory.scrubApply', { scrub: entries, scope: entries.flatMap((e) => [e.id, e.of].filter(Boolean)), ...T.evidence });
const scope = (kind = 'apply') => T.call(T.who.operator(kind), 'memory.scrubScope', {});
const ns = (id) => T.row(id).namespace;
// A pair the score does not relate (cosine 0): only a report of this run can open the gate. x carries the report naming y.
const unrelated = (mark) => {
  const y = T.note('gate partner', { vec: B, created_at: 100 });
  const x = T.note('gate reported', { vec: A, created_at: 200, reported_wrong: [rep(y)] });
  if (mark) setBody(x, mark);
  return { x, y };
};

test('D10: an unjudged report opens no relate gate: the relation is refused and the reported note stays live', async () => {
  const { x, y } = unrelated();
  const r = await scrub('apply', [relate(x, 'repeats', y)]);
  assert.deepStrictEqual([r.counts.applied, r.refused[0].code], [0, 'E_PRECONDITION']);
  assert.match(r.refused[0].message, /no worker report of this run/);
  assert.strictEqual(ns(x), `project/${PROJECT}`, 'not archived');
});

test('D10: a report a reviewer upheld opens the relate gate and archives the reported note', async () => {
  const { x, y } = unrelated((b) => { b.report_judgments = [upheld()]; });
  const r = await scrub('apply', [relate(x, 'repeats', y)]);
  assert.strictEqual(r.counts.applied, 1, JSON.stringify(r.refused));
  assert.strictEqual(r.applied[0].facts.source, 'stored_cosine');
  assert.strictEqual(r.applied[0].facts.via, 'report');
  assert.strictEqual(ns(x), `archive/${PROJECT}`);
});

test('D10: a report the reviewer rejected opens no gate: the relation is refused and the reported note stays live', async () => {
  for (const mark of [
    (b) => { b.report_judgments = [rejected()]; },
    (b) => { b.report_rejected = [rejected()]; }, // the judgment list is capped, the receipt list is its own
  ]) {
    const { x, y } = unrelated(mark);
    const r = await scrub('apply', [relate(x, 'repeats', y)]);
    assert.deepStrictEqual([r.counts.applied, r.refused[0].code], [0, 'E_PRECONDITION']);
    assert.match(r.refused[0].message, /no worker report of this run/);
    assert.strictEqual(ns(x), `project/${PROJECT}`, 'not archived');
  }
});

test('D10: only an upheld judgment of THIS report opens the gate (same task, same report time, verdict upheld)', async () => {
  for (const mark of [
    (b) => { b.report_judgments = [upheld({ report_at: 12 })]; },
    (b) => { b.report_judgments = [upheld({ task_id: 'tx-2' })]; },
    (b) => { b.report_judgments = [upheld({ verdict: 'recommended' })]; }, // the Haiku job's recommendation is not a judgment
  ]) {
    const { x, y } = unrelated(mark);
    const r = await scrub('apply', [relate(x, 'repeats', y)]);
    assert.deepStrictEqual([r.counts.applied, r.refused[0].code], [0, 'E_PRECONDITION']);
    assert.strictEqual(ns(x), `project/${PROJECT}`);
  }
});

test('D10: a rejected report gives no direction, so a pair the score relates falls back to the notes\' own age', async () => {
  const old = T.note('direction old', { vec: A, created_at: 100 });
  const neu = T.note('direction new', { vec: A_NEAR, created_at: 200, reported_wrong: [rep(old)] });
  setBody(neu, (b) => { b.report_judgments = [rejected()]; });
  const r = await scrub('apply', [relate(neu, 'repeats', old)]);
  assert.strictEqual(r.applied[0].archived, neu, 'the newer of a repeat is archived by age');
  const old2 = T.note('direction old 2', { vec: A, created_at: 100 });
  const neu2 = T.note('direction new 2', { vec: A_NEAR, created_at: 200, reported_wrong: [rep(old2)] });
  const r2 = await scrub('apply', [relate(neu2, 'repeats', old2)]);
  assert.strictEqual(r2.applied[0].archived, neu2, 'the newer is archived by age');
  const o3 = T.note('direction old 3', { vec: A, created_at: 100 });
  const n3 = T.note('direction new 3', { vec: A_NEAR, created_at: 200 });
  setBody(o3, (b) => { b.reported_wrong = [rep(n3)]; b.report_judgments = [upheld()]; }); // the OLDER note is the reported one: an upheld report flips the usual direction
  const r3 = await scrub('apply', [relate(o3, 'repeats', n3)]);
  assert.strictEqual(r3.applied[0].archived, o3);
  const o4 = T.note('direction old 4', { vec: A, created_at: 100 });
  const n4 = T.note('direction new 4', { vec: A_NEAR, created_at: 200 });
  setBody(o4, (b) => { b.reported_wrong = [rep(n4)]; b.report_judgments = [rejected()]; });
  const r4 = await scrub('apply', [relate(o4, 'repeats', n4)]);
  assert.strictEqual(r4.applied[0].archived, n4, 'rejected: age decides, the newer one goes');
  const o5 = T.note('direction old 5', { vec: A, created_at: 100 });
  const n5 = T.note('direction new 5', { vec: A_NEAR, created_at: 200 });
  setBody(o5, (b) => { b.reported_wrong = [rep(n5)]; }); // unjudged: the older note is reported, but a say-so gives no direction
  const r5 = await scrub('apply', [relate(o5, 'repeats', n5)]);
  assert.strictEqual(r5.applied[0].archived, n5, 'unjudged: age decides, the newer one goes');
});

test('D10: the scrub scope does not offer a pair on a rejected report, and shows the scrubber the rejection', async () => {
  const keep = T.note('scope keep', { vec: A, created_at: 10 });
  const open = T.note('scope open report', { vec: A_NEAR, reported_wrong: [rep(keep)] });
  const gone = T.note('scope rejected report', { vec: A_NEAR, reported_wrong: [rep(keep)] });
  setBody(gone, (b) => { b.report_judgments = [rejected()]; b.report_rejected = [{ ...rejected(), reason: 'the cite shows the note is right' }]; });
  const s = await scope();
  const why = (id) => (s.items.find((i) => i.id === id) || {}).why;
  assert.deepStrictEqual(why(open), ['replaced_by']);
  assert.strictEqual(why(gone), undefined, 'a rejected report names no pair');
  const mixed = T.note('scope mixed', { vec: A_NEAR, reported_wrong: [rep(keep, { by: 'worker:w3', worker_id: 'w3', task_id: 'tx-3', at: 13 }), rep(keep)] });
  setBody(mixed, (b) => { b.report_judgments = [rejected()]; b.report_rejected = [{ ...rejected(), reason: 'the cite shows the note is right' }]; });
  const item = (await scope()).items.find((i) => i.id === mixed);
  assert.deepStrictEqual(item.why, ['replaced_by'], 'the other, standing report still names the pair');
  const shown = item.reports.map((r) => [r.task_id, !!r.rejected, r.rejected_reason || null]);
  assert.deepStrictEqual(shown, [['tx-3', false, null], ['tx-1', true, 'the cite shows the note is right']]);
});

test('D10: no hold fact comes from a rejected report; an unjudged one still counts', () => {
  const note = (reports, marks = {}) => ({ id: 'n-1', written_by: 'worker:w1', status: 'unverified', created_at: 100, b: { reported_wrong: reports, ...marks } });
  const wrong = (n) => F.checkHoldFacts(T.E, PROJECT, n, 'wrong', null, 'report_confirmed', 0.8, RUN);
  assert.throws(() => wrong(note([rep(null)], { report_judgments: [rejected()] })), (e) => e.code === 'E_PRECONDITION' && /no trigger fact/.test(e.message));
  assert.strictEqual(wrong(note([rep(null)])).reports, 1);
  const kept = T.note('facts kept', { vec: A, created_at: 50 });
  const dup = (n) => F.checkHoldFacts(T.E, PROJECT, { ...n, ...T.row(n.id), b: n.b }, 'duplicate', kept, 'same_claim', 0.99, RUN);
  const lone = T.note('facts lone', { vec: B, created_at: 300, reported_wrong: [rep(kept)] });
  const loneRow = { id: lone, b: T.body(lone) };
  assert.strictEqual(dup(loneRow).via, 'report');
  setBody(lone, (b) => { b.report_judgments = [rejected()]; });
  assert.throws(() => dup({ id: lone, b: T.body(lone) }), (e) => e.code === 'E_PRECONDITION' && /no worker report names/.test(e.message));
  // superseded: the replacement is OLDER than the note, so only a standing report of this run gives the direction
  const sup = (marks) => F.checkHoldFacts(T.E, PROJECT, { id: lone, written_by: 'worker:w1', created_at: 400, status: 'unverified', b: { reported_wrong: [rep(kept)], ...marks } }, 'superseded', kept, 'replaced_by_newer', 0.99, RUN);
  assert.strictEqual(sup({}).shared, 'report');
  assert.throws(() => sup({ report_judgments: [rejected()] }), (e) => e.code === 'E_PRECONDITION' && /is not newer/.test(e.message));
});

test('D10: the index line tells workers a note was reported wrong only while a report of this run stands', async () => {
  const mk = (marks) => {
    const id = T.note(`index tag ${Math.random()}`, { reported_wrong: [rep(null)] });
    if (marks) setBody(id, marks);
    return id;
  };
  const standing = mk(), judged = mk((b) => { b.report_judgments = [rejected()]; });
  const text = (await T.call(T.who.tool('apply'), 'memory.index', {})).text;
  const line = (id) => text.split('\n').find((l) => l.includes(id));
  assert.match(line(standing), /a worker reported this wrong/);
  assert.ok(line(judged), 'the note itself is still listed');
  assert.doesNotMatch(line(judged), /reported this wrong/);
});

const TOKEN = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

test('D65: a relation\'s reason is redacted before it is stored, in an archive, a judged pair and a proposal', async () => {
  const everywhere = (id) => JSON.stringify(T.body(id)) + JSON.stringify(T.row(id));
  const o = T.note('redact old', { vec: A, created_at: 100 }), n = T.note('redact new', { vec: A_NEAR, created_at: 200 });
  await scrub('apply', [relate(n, 'repeats', o, { reason: `${TOKEN} appears in both` })]);
  assert.ok(!everywhere(n).includes(TOKEN) && !everywhere(o).includes(TOKEN), 'the archived note and the kept one');
  assert.ok(!everywhere(n).includes('ghp_a1B2'), 'not even a prefix of the token is left');
  const a = T.note('redact judged a', { vec: A, created_at: 100 }), b = T.note('redact judged b', { vec: A_NEAR, created_at: 200 });
  await scrub('apply', [relate(a, 'new', b, { reason: `distinct, though ${TOKEN} is in both` })]);
  assert.ok(!everywhere(a).includes(TOKEN) && !everywhere(b).includes(TOKEN), 'pair_judged on both notes');
  const c = T.note('redact proposed a', { vec: A, created_at: 100 }), d = T.note('redact proposed b', { vec: A_NEAR, created_at: 200 });
  const p = await scrub('propose', [relate(d, 'repeats', c, { reason: `${TOKEN} appears in both` })]);
  assert.strictEqual(p.counts.proposed, 1, JSON.stringify(p.refused));
  assert.ok(!JSON.stringify(p).includes(TOKEN) && !JSON.stringify(T.row(p.proposed[0].row.id)).includes(TOKEN), 'the proposal row and the answer');
});

test('D30: gate (b): a refuted, a superseded and a held partner are each refused, and the live control applies', async () => {
  const pairWith = (over) => ({ y: T.note('gate b partner', { vec: A, created_at: 100, ...over }), x: T.note('gate b subject', { vec: A_NEAR, created_at: 200 }) });
  const refused = async ({ x, y }) => (await scrub('apply', [relate(x, 'repeats', y)]));
  const r1 = await refused(pairWith({ status: 'refuted' }));
  assert.deepStrictEqual([r1.counts.applied, r1.refused[0].code], [0, 'E_PRECONDITION']);
  assert.match(r1.refused[0].message, /is refuted/);
  const p2 = pairWith({}), z = T.note('gate b replacement', { vec: B, created_at: 150 });
  T.store.p('UPDATE memory_entries SET supersedes = ? WHERE id = ?').run(p2.y, z);
  const r2 = await refused(p2);
  assert.deepStrictEqual([r2.counts.applied, r2.refused[0].code], [0, 'E_PRECONDITION']);
  assert.match(r2.refused[0].message, /was superseded by/);
  const p3 = pairWith({});
  setBody(p3.y, (b) => { b.held = { row: 'held-1', kind: 'wrong', reason: 'x', run_id: RUN, at: 1 }; });
  const r3 = await refused(p3);
  assert.deepStrictEqual([r3.counts.applied, r3.refused[0].code], [0, 'E_PRECONDITION']);
  assert.match(r3.refused[0].message, /is held for archive/);
  const live = pairWith({});
  assert.strictEqual((await refused(live)).counts.applied, 1, 'the same pair, live, applies');
});

test('S25: an error that is not a refusal propagates; it is never read as a clean per-entry refusal', async () => {
  const { x, y } = unrelated((b) => { b.report_judgments = [upheld()]; });
  const real = T.store.p.bind(T.store);
  let armed = false;
  T.store.p = (sql) => { if (armed && /FROM memory_entries WHERE supersedes = \?/.test(sql)) throw new TypeError('injected internal failure'); return real(sql); };
  try {
    armed = true;
    await assert.rejects(scrub('apply', [relate(x, 'repeats', y)]), (e) => e instanceof TypeError && /injected/.test(e.message));
  } finally { armed = false; T.store.p = real; }
  assert.strictEqual(ns(x), `project/${PROJECT}`, 'nothing was written');
});
