'use strict';
// held-breaker.test.cjs — ADR 0047 amendment (2026-10-22), decision 9: the circuit breaker is decided at report time, from the reporter's run. A run's
// reports withhold their notes up to min(held_breaker_count, max(3, floor(held_breaker_share x live notes))); the report past that is still held but
// stays visible with its warning, and one notice says the run disputed too much. The operator's reports are exempt. Real core, sandbox store.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { callerFor } = require('./helpers.cjs');
const env = require('./report-env.cjs');
const { DEFAULTS } = require('../../src/core/memory-levers.cjs');
const setup = (run, levers = {}) => env.setup(run, { held_breaker_count: DEFAULTS.held_breaker_count, held_breaker_share: DEFAULTS.held_breaker_share, ...levers }); // the default limit, which these tests test
const Breaker = require('../../src/core/held-breaker.cjs');
const { breakerEvents, renderText } = require('../../src/cli/cmd-notices.cjs');

const DIM = 64;
let n = 0;
const vec = () => { const v = new Array(DIM).fill(0); v[DIM - 1] = 1; return v; };
function liveNote(X, title) {
  n += 1;
  return X.store.storeIn({
    namespace: 'project/acme', worker_id: 'w1', type: 'note', text: `${title} ${n} breakercase`, title: `${title} ${n}`,
    body: { kind: 'lesson', basis: 'inferred', evidence: [], applies_to: [], subjects: [], model: 'm', state: 'live', seen_in: [], seen_total: 0, reported_wrong: [] },
    embedding: vec(), embedding_model: 'fake', embedding_revision: 'r', dim: DIM, run_id: 'gone-run', task_id: null, source: 'model', written_by: 'worker:w1',
  }).id;
}
const notes = (X, count) => Array.from({ length: count }, () => liveNote(X, 'live note'));
const report = (X, caller, id, why = 'it is wrong') => X.call('memory.noteReport', caller, { note_id: id, why });
const reader = (X, run = X.RUN) => callerFor('worker', { run_id: run, worker_id: 'w-reader' });
const listed = async (X, caller, id) => (await X.call('memory.list', caller, { namespaces: ['project/acme'] })).rows.some((r) => r.id === id);
const breakersOf = async (X) => (await X.call('memory.held', X.orch, { reports: true })).breakers;

// The scenario every limit test shares: 40 live notes, the default limit of 5, one run reporting 7 notes. Returns each answer.
async function sevenReports(X) {
  const ids = notes(X, 40);
  const outs = [];
  for (let i = 0; i < 7; i += 1) outs.push(await report(X, X.orch, ids[i]));
  return { ids, outs };
}

let A;
before(async () => { A = await setup('brk-a'); });
after(() => A.cleanup());

test('B1: under the limit a report withholds; the (limit+1)th is queued for review and stays visible; one notice; the proof says why', async () => {
  const { ids, outs } = await sevenReports(A);
  assert.deepStrictEqual(outs.slice(0, 5).map((o) => o.withheld), [true, true, true, true, true]);
  assert.deepStrictEqual(outs.slice(0, 5).map((o) => o.breaker.count), [1, 2, 3, 4, 5]);
  assert.strictEqual(outs[0].breaker.limit, 5);
  assert.ok(outs[0].breaker.live >= 40);
  // Held means hidden (amendment of 2026-10-25): past the limit the orchestrator's report (it has no task) is queued for the archive review, hiding nothing.
  assert.deepStrictEqual([outs[5].withheld, outs[5].state, outs[5].breaker.count, outs[5].breaker.limit], [false, 'queued', 6, 5]);
  assert.match(outs[5].withheld_why, /breaker: this run has disputed 6 notes, over its limit of 5; the report is queued for the archive review but hides nothing/);
  assert.deepStrictEqual([outs[6].withheld, outs[6].state], [false, 'queued']);
  // The hold and the report entry carry the decision; the note stays visible to a worker, a withheld one does not.
  const h6 = A.activeHold(ids[5]);
  assert.deepStrictEqual([h6.b.state, h6.b.reports[0].withhold], ['queued', false]);
  assert.deepStrictEqual(h6.b.reports[0].breaker, { count: 6, limit: 5, live: outs[5].breaker.live });
  assert.strictEqual(A.bodyOf(ids[5]).reported_wrong[0].withhold, false);
  // The archive review's input holds it, and the held count counts it.
  const queue = await A.call('memory.reviewQueue', A.harness, {});
  assert.ok(queue.held.some((e) => e.id === ids[5]) && queue.held.some((e) => e.id === ids[6]), 'the archive review is offered the queued holds');
  assert.ok((await A.call('memory.held', A.orch, { project: 'acme', list: true })).entries.some((e) => e.note_id === ids[5] && e.state === 'queued'), 'the held listing names it queued');
  // Unmarked for the orchestrator, as a note with no hold.
  const s = await A.call('memory.list', A.orch, { namespaces: ['project/acme'], limit: 500 });
  assert.strictEqual(s.rows.find((x) => x.id === ids[5]).held, undefined);
  assert.strictEqual(A.activeHold(ids[0]).b.reports[0].withhold, true);
  assert.strictEqual(await listed(A, reader(A), ids[0]), false, 'a withheld note is absent for a worker');
  assert.strictEqual(await listed(A, reader(A), ids[5]), true, 'a past-limit note stays visible');
  assert.strictEqual(await listed(A, reader(A), ids[6]), true);
  // One notice for the run, whose count follows the run (7 now), not one per report.
  const br = await breakersOf(A);
  assert.deepStrictEqual(br.map((b) => [b.run_id, b.project, b.disputed, b.limit]), [['brk-a', 'acme', 7, 5]]);
  const events = breakerEvents(br, 'brk-a');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].kind, 'run_disputed');
  assert.match(renderText(events), /run brk-a disputed 7 notes; review before trusting/);
});

test('B2: a later run starts fresh', async () => {
  await A.call('run.attach', callerFor('orchestrator', { run_id: 'brk-b' }), { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  const o2 = callerFor('orchestrator', { run_id: 'brk-b' });
  const out = await report(A, o2, notes(A, 1)[0]);
  assert.deepStrictEqual([out.withheld, out.breaker.count], [true, 1]);
  const br = await breakersOf(A);
  assert.deepStrictEqual(br.map((b) => b.run_id), ['brk-a'], 'only the run that went over is named');
});

test('B3: the operator is exempt and does not count toward a run; a repeat is not counted twice', async () => {
  const X = await setup('brk-c');
  try {
    const ids = notes(X, 40);
    const outs = [];
    for (let i = 0; i < 8; i += 1) outs.push(await report(X, { ...X.operator, peer_pid: 4242 }, ids[i]));
    assert.ok(outs.every((o) => o.withheld === true && o.breaker === undefined), 'the operator is never over a limit');
    assert.strictEqual((await breakersOf(X)).length, 0);
    // The run's own count starts at zero: five distinct notes (one reported four times, on top of the operator's eight) all withhold.
    const mine = ids.slice(10, 15);
    for (let k = 0; k < 4; k += 1) assert.strictEqual((await report(X, X.orch, mine[0], `again ${k}`)).withheld, true);
    for (const id of mine.slice(1)) assert.strictEqual((await report(X, X.orch, id)).withheld, true);
    const sixth = await report(X, X.orch, ids[20]);
    assert.deepStrictEqual([sixth.withheld, sixth.breaker.count], [false, 6]);
    // A repeat on the note past the limit keeps its decision and the count does not move.
    const again = await report(X, X.orch, ids[20], 'still wrong');
    assert.deepStrictEqual([again.withheld, again.breaker.count], [false, 6]);
    const fifth = await report(X, X.orch, mine[1], 'second look');
    assert.strictEqual(fifth.withheld, true, 'a repeat on a withheld note stays withheld');
  } finally { await X.cleanup(); }
});

test('B4: the share binds in a small project, and the share part is never below three notes', async () => {
  const X = await setup('brk-d');
  try {
    const ids = notes(X, 20); // floor(0.2 x 20) = 4 < 5
    const outs = [];
    for (let i = 0; i < 5; i += 1) outs.push(await report(X, X.orch, ids[i]));
    assert.deepStrictEqual(outs.map((o) => o.withheld), [true, true, true, true, false]);
    assert.strictEqual(outs[4].breaker.limit, 4);
    assert.strictEqual(outs[4].breaker.live, 20);
  } finally { await X.cleanup(); }
  const Y = await setup('brk-e', { held_breaker_count: 50 });
  try {
    const ids = notes(Y, 4); // floor(0.2 x 4) = 0, raised to 3
    const outs = [];
    for (let i = 0; i < 4; i += 1) outs.push(await report(Y, Y.orch, ids[i]));
    assert.deepStrictEqual(outs.map((o) => o.withheld), [true, true, true, false]);
    assert.strictEqual(outs[0].breaker.limit, 3);
    assert.strictEqual(Breaker.limitOf({ held_breaker_count: 5, held_breaker_share: 0.2 }, 3), 3);
    assert.strictEqual(Breaker.limitOf({ held_breaker_count: 2, held_breaker_share: 0.2 }, 3), 2, 'a count under 3 wins');
    assert.strictEqual(Breaker.limitOf({ held_breaker_count: 5, held_breaker_share: 0.2 }, 100), 5);
    assert.strictEqual(Breaker.limitOf({ held_breaker_count: 50, held_breaker_share: 1 }, 7), 7);
  } finally { await Y.cleanup(); }
});

test('B5: a hold released as correct frees the run\'s count; reads write nothing', async () => {
  const X = await setup('brk-f');
  try {
    const ids = notes(X, 40);
    for (let i = 0; i < 5; i += 1) await report(X, X.orch, ids[i]);
    const h = X.activeHold(ids[0]);
    X.store.patchBody(h.id, (b) => { b.state = 'released'; return b; });
    assert.strictEqual((await report(X, X.orch, ids[5])).withheld, true, 'five held, one released: four count, so the next withholds');
    const snap = () => JSON.stringify(X.store.p('SELECT COUNT(*) AS n, MAX(rowid) AS m, SUM(LENGTH(body)) AS b FROM memory_entries').get()) + JSON.stringify(X.store.p('SELECT COUNT(*) AS n FROM memory_event').get());
    const before = snap();
    await X.call('memory.held', X.orch, { reports: true });
    await listed(X, reader(X), ids[1]);
    breakerEvents((await breakersOf(X)), 'brk-f');
    assert.strictEqual(snap(), before, 'a read of the notices, the held count and the notes wrote nothing');
  } finally { await X.cleanup(); }
});

test('B6: mutation check — with the breaker removed the limit scenario fails', async () => {
  const real = Breaker.decide;
  Breaker.decide = () => ({ withhold: true, breaker: null, why: 'mutant' }); // the breaker taken out
  const X = await setup('brk-g');
  try {
    const { outs } = await sevenReports(X);
    assert.strictEqual(outs[5].withheld, true, 'without the breaker the sixth note is withheld');
    assert.notStrictEqual(outs[5].withheld, false, 'which is exactly what B1 asserts against');
    assert.strictEqual((await breakersOf(X)).length, 0, 'and no run is ever named');
  } finally { Breaker.decide = real; await X.cleanup(); }
  const Z = await setup('brk-h');
  try {
    const { outs } = await sevenReports(Z);
    assert.strictEqual(outs[5].withheld, false, 'with the real breaker the sixth is past the limit');
  } finally { await Z.cleanup(); }
});

const attach = (X, run) => X.call('run.attach', callerFor('orchestrator', { run_id: run }), { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true, held_breaker_count: 1 }) });

test('B7: another run\'s report is never overwritten, and the proof reflects what workers can see', async () => {
  const X = await setup('brk-i', { held_breaker_count: 1 });
  try {
    await attach(X, 'brk-j');
    const oB = callerFor('orchestrator', { run_id: 'brk-j' });
    const [n1, x1] = notes(X, 40);
    assert.strictEqual((await report(X, X.orch, n1)).withheld, true);
    assert.strictEqual((await report(X, oB, x1)).withheld, true);
    const over = await report(X, oB, n1, 'run B agrees');
    assert.strictEqual(over.breaker.count, 2, 'B is over its limit of 1');
    assert.strictEqual(over.withheld, true, 'but run A\'s report still withholds the note');
    assert.match(over.withheld_why, /withheld by another report on the note/);
    const reports = X.activeHold(n1).b.reports;
    assert.deepStrictEqual(reports.map((r) => [r.run_id, r.withhold]).sort(), [['brk-i', true], ['brk-j', false]]);
    assert.strictEqual(X.bodyOf(n1).reported_wrong.length, 2, 'both runs\' reports stand');
    assert.strictEqual(await listed(X, reader(X, 'brk-i'), n1), false, 'workers still cannot see it');
    // Within one run a repeat still replaces its own report.
    await report(X, X.orch, n1, 'again');
    assert.strictEqual(X.bodyOf(n1).reported_wrong.length, 2);
  } finally { await X.cleanup(); }
});

test('B8: a repeat is decided again against the current count, never kept', async () => {
  const X = await setup('brk-k', { held_breaker_count: 1 });
  try {
    const [n1, n2] = notes(X, 40);
    assert.strictEqual((await report(X, X.orch, n1)).withheld, true);
    await X.call('memory.heldSettle', X.operator, { id: n1, action: 'release', reason: 'checked: correct' });
    assert.strictEqual((await report(X, X.orch, n2)).withheld, true);
    const again = await report(X, X.orch, n1, 'wrong after all');
    assert.deepStrictEqual([again.withheld, again.breaker.count, again.breaker.limit], [false, 2, 1]);
    assert.strictEqual(await listed(X, reader(X), n1), true);
  } finally { await X.cleanup(); }
});

test('B9: past the limit a reviewer\'s refuted is queued and the archive review applies it; a past-limit report on a hidden note keeps it hidden; a withholding report hides a queued note', async () => {
  const X = await setup('brk-l', { held_breaker_count: 1 });
  try {
    const first = await X.written('w-l1', 'K1');
    assert.strictEqual((await report(X, X.orch, first.note)).withheld, true, 'the run\'s one withholding report');
    // A task reviewer's refuted is a report of the same run: past its limit it is queued, visible, and the archive review's to judge.
    const a = await X.written('w-l2', 'K2');
    const rt = await X.review('rev-l1', a.task, { memory_verdicts: [X.rv(a.note, 'refuted', [X.cite('the loader worked as the note says')], 'what the stream shows')] });
    const got = (await X.apply(rt)).applied[0];
    const qa = X.activeHold(a.note);
    assert.deepStrictEqual([got.verdict, got.applied, got.held_row, got.withheld, qa.b.state], ['refuted', true, qa.id, false, 'queued']);
    assert.strictEqual(await listed(X, reader(X), a.note), true, 'a queued note stays visible to a worker');
    // The archive review applies its verdict to the queued hold as to any: the note is archived by the reviewer, not by the report.
    const q = await X.call('memory.reviewQueue', X.harness, {});
    const entry = q.held.find((e) => e.id === a.note);
    assert.ok(entry, 'offered to the archive review');
    const v = await X.call('memory.reviewApply', X.harness, { verdicts: [{ id: a.note, verdict: 'archive', reason: 'contradicted by the loader', cites: [{ where: 'loader.js:1', quote: "return 'reads unlisted fixtures'" }], held_row: qa.id, rev: qa.b.rev || 0 }], head_sha: X.head, worktree: X.repo });
    assert.strictEqual(v.applied.length, 1, JSON.stringify(v));
    assert.strictEqual(X.rowOf(a.note).namespace, 'archive/acme');
    // A note the scrubber hid stays hidden when a past-limit report arrives: the report's hold takes over one that already hid the note.
    const b = liveNote(X, 'scrubber held');
    X.store.storeIn({ namespace: 'held/acme', worker_id: 'harness', type: 'held', text: `held dup ${b}`, title: 'h', body: { state: 'held', note_id: b, kind: 'duplicate', of: first.note, ground: 'same_claim', reason: 'same claim', rev: 0 }, run_id: X.RUN, source: 'harness', written_by: 'harness' });
    const out = await report(X, X.orch, b, 'also wrong');
    assert.deepStrictEqual([out.state, out.withheld, X.activeHold(b).b.state], ['held', true, 'held']);
    assert.strictEqual(await listed(X, reader(X), b), false, 'and the note stays hidden');
    // A later run's report that withholds turns a queued hold into one that hides.
    const c = liveNote(X, 'queued then held');
    assert.strictEqual((await report(X, X.orch, c)).state, 'queued');
    await attach(X, 'brk-m');
    const again = await report(X, callerFor('orchestrator', { run_id: 'brk-m' }), c, 'another run agrees');
    assert.deepStrictEqual([again.withheld, X.activeHold(c).b.state], [true, 'held']);
    assert.strictEqual(await listed(X, reader(X), c), false);
  } finally { await X.cleanup(); }
});
