'use strict';
// close-stages-review.test.cjs — the Opus archive reviewer stage and the run-close orchestration, with a fake run manager. The
// reviewer's triggers, the whole-queue drain, the caps and carry-over, and the adversarial verdicts refused by memory.reviewApply.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { env, fakeManager, json, LV, RUN } = require('./close-stages-env.cjs');
const { runReview, triggerOf } = require('../../src/run/review-stage.cjs');
const { closeStages } = require('../../src/run/close-stages.cjs');

let X, T;
before(async () => { X = await env(); T = X.T; await X.worker('apply', 'w-head'); });
after(() => T.close());

const lv = (over = {}) => ({ ...LV.apply, ...over });
const review = (manager, over = {}, extra = {}) => runReview({ core: X.coreFor('apply'), runId: RUN.apply, lv: lv(over), dataDir: T.dir, getManager: async () => manager, worktree: T.repo, ...extra });
const archiveV = (id, over = {}) => ({ id, verdict: 'archive', reason: 'the code confirms the hold', cites: [T.cite], ...over });
const releaseV = (id) => ({ id, verdict: 'release', reason: 'the code supports the note' });
const queue = async () => (await T.call(T.who.operator('apply'), 'memory.reviewQueue', {})).held;
const nsOf = (id) => T.row(id).namespace;

// A live note with a worker report from another writer, held by the scrubber.
async function held(title, over = {}) {
  const n = T.note(title, { reported_wrong: [T.report()], ...over });
  const r = await T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: [X.hold(n)], scope: [n], ...T.evidence });
  assert.strictEqual(r.applied[0].outcome, 'held', JSON.stringify(r.refused));
  return n;
}
// The queue is the project's: each test starts from an empty one.
async function drain() {
  const q = await queue();
  if (q.length) await T.call(T.who.harness('apply'), 'memory.reviewApply', { verdicts: q.map((h) => releaseV(h.id)), ...T.evidence });
  assert.strictEqual((await queue()).length, 0);
}

test('the triggers: enough marks, an old enough mark, or a mark on a review-verified note; and nothing otherwise', () => {
  const L = { review_min_held: 3, review_max_age_runs: 3 };
  assert.strictEqual(triggerOf({ count: 2, max_runs_waited: 2, review_verified: 0 }, L), null);
  assert.match(triggerOf({ count: 3, max_runs_waited: 0, review_verified: 0 }, L), /3 marks held/);
  assert.match(triggerOf({ count: 1, max_runs_waited: 3, review_verified: 0 }, L), /waited 3 runs/);
  assert.match(triggerOf({ count: 1, max_runs_waited: 0, review_verified: 1 }, L), /verified/);
  assert.strictEqual(triggerOf({ count: 0, max_runs_waited: 9, review_verified: 0 }, L), null, 'an empty queue never triggers');
});

test('an empty queue or a queue below every trigger spawns nothing', async () => {
  await drain();
  let asked = 0;
  const mgr = async () => { asked += 1; };
  const empty = await runReview({ core: X.coreFor('apply'), runId: RUN.apply, lv: lv(), dataDir: T.dir, getManager: mgr, worktree: T.repo });
  assert.deepStrictEqual([empty.ran, empty.reason], [false, 'empty queue']);
  await held('one lonely mark');
  await held('two lonely marks');
  const below = await runReview({ core: X.coreFor('apply'), runId: RUN.apply, lv: lv(), dataDir: T.dir, getManager: mgr, worktree: T.repo });
  assert.deepStrictEqual([below.ran, below.reason, below.counts.count, asked], [false, 'below the triggers', 2, 0]);
  const off = await review(null, { scrub_action: 'off' });
  assert.deepStrictEqual([off.ran, off.reason], [false, 'scrub_action off']);
  const none = await runReview({ core: X.coreFor('plain'), runId: RUN.plain, lv: LV.plain, dataDir: T.dir, getManager: mgr });
  assert.deepStrictEqual([none.ran, none.reason], [false, 'notes off']);
});

test('each trigger starts the reviewer: the count, the age in runs, and a mark on a review-verified note', async () => {
  await drain();
  const a = await held('count one'), b = await held('count two'), c = await held('count three');
  const m = fakeManager(T, 'apply', json('verdicts', []));
  const byCount = await review(m);
  assert.match(byCount.trigger, /3 marks held/);
  await drain();
  await held('the lonely old mark');
  assert.strictEqual((await review(fakeManager(T, 'apply', json('verdicts', [])))).ran, false);
  for (const r of Object.values(RUN)) T.store.db.prepare('UPDATE run SET started_at = ? WHERE id = ?').run(Date.now() + 60000, r);
  const byAge = await review(fakeManager(T, 'apply', json('verdicts', [])));
  assert.match(byAge.trigger, /waited \d+ runs/);
  for (const r of Object.values(RUN)) T.store.db.prepare('UPDATE run SET started_at = ? WHERE id = ?').run(1, r);
  await drain();
  await held('review-verified and held', { status: 'verified' });
  const n = (await queue())[0].id;
  assert.strictEqual((await review(fakeManager(T, 'apply', json('verdicts', [])))).ran, false, 'verified by hand is not review-verified');
  T.store.p("UPDATE memory_entries SET status_receipt = 'review:notereview-t9' WHERE id = ?").run(n);
  const byVerified = await review(fakeManager(T, 'apply', json('verdicts', [])));
  assert.match(byVerified.trigger, /verified/);
  void [a, b, c];
});

test('the whole queue is cleared in ONE spawn, no item cap, with both notes, the cites and the files at the head sha in the brief', async () => {
  await drain();
  const ids = [];
  for (let i = 0; i < 7; i += 1) ids.push(await held(`queue member ${i}`));
  const keep = T.note('the kept note for a duplicate');
  const dupe = T.note('duplicate of the kept note', { reported_wrong: [T.report('worker:w2', keep)] });
  await T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: [{ id: dupe, action: 'hold', kind: 'duplicate', of: keep, ground: 'same_claim', reason: 'same claim', cites: [T.cite] }], scope: [dupe, keep], ...T.evidence });
  const all = [...ids, dupe];
  const m = fakeManager(T, 'apply', json('verdicts', all.map((id) => archiveV(id))));
  const o = await review(m);
  assert.strictEqual(m.spawned.length, 1, 'one spawn for the whole queue');
  const a = m.spawned[0];
  assert.deepStrictEqual([a.model, a.allowed_tools, a.tools, a.max_budget_usd, m.waits[0].timeout_ms], ['claude-opus-5-5', ['Read', 'Glob', 'Grep'], ['Read', 'Glob', 'Grep'], 2, 600000]);
  assert.ok(a.worker_id.startsWith('archreview-lc-apply-') && !('task_id' in a));
  const brief = fs.readFileSync(/(\S+brief\.md)/.exec(a.prompt)[1], 'utf8');
  for (const id of all) assert.ok(brief.includes(id), `the brief holds ${id}`);
  assert.ok(brief.includes(keep), 'the note a duplicate stands against is in the brief');
  assert.ok(brief.includes(T.head) && brief.includes('loader.js'));
  const saved = brief.match(/"saved_at": "([^"]+)"/)[1];
  assert.ok(fs.readFileSync(saved, 'utf8').includes('return fixtures.get(name);'), 'the file at the held row\'s head sha is saved for the reviewer');
  assert.deepStrictEqual([o.result.counts.verdicts, o.result.counts.applied, o.result.counts.refused, o.left_held], [8, 8, 0, 0]);
  for (const id of all) assert.strictEqual(nsOf(id), 'archive/lc', id);
  assert.strictEqual((await queue()).length, 0);
  assert.match(o.result.applied[0].receipt, /^review:lc-apply:/);
  const ev = X.events('review_stage').pop();
  assert.deepStrictEqual([ev.ok, JSON.parse(ev.row_ids).length], [1, 8]);
  assert.deepStrictEqual(m.stopped, [a.worker_id]);
});

test('a note the reviewer leaves out stays held and carries over; a release clears the warning', async () => {
  await drain();
  const ids = [];
  for (let i = 0; i < 4; i += 1) ids.push(await held(`partial ${i}`));
  const o = await review(fakeManager(T, 'apply', json('verdicts', [archiveV(ids[0]), releaseV(ids[1])])));
  assert.deepStrictEqual([o.result.counts.applied, o.left_held], [2, 2]);
  assert.deepStrictEqual([nsOf(ids[0]), nsOf(ids[1]), JSON.parse(T.row(ids[1]).body).held], ['archive/lc', 'project/lc', undefined]);
  assert.deepStrictEqual((await queue()).map((h) => h.id).sort(), [ids[2], ids[3]].sort());
});

test('a cost over the cap, no recorded cost, a timeout, a dead child or junk applies nothing and the whole queue stays held', async () => {
  await drain();
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push(await held(`capped ${i}`));
  const verdicts = json('verdicts', ids.map((id) => archiveV(id)));
  for (const [label, m, code] of [
    ['over the cap', fakeManager(T, 'apply', verdicts, { cost: 5 }), 'E_COST_CAP'],
    ['no recorded cost', fakeManager(T, 'apply', verdicts, { cost: 0 }), 'E_COST_CAP'],
    ['timeout', fakeManager(T, 'apply', '', { event: 'timeout' }), 'E_TIMEOUT'],
    ['died', fakeManager(T, 'apply', '', { event: 'death' }), 'E_WORKER_NOT_LIVE'],
    ['junk', fakeManager(T, 'apply', 'Everything looks archivable to me.'), 'E_ARGS'],
  ]) {
    const o = await review(m);
    assert.strictEqual(o.error.code, code, label);
    assert.strictEqual((await queue()).length, 3, `${label}: nothing applied, nothing lost`);
    for (const id of ids) assert.strictEqual(nsOf(id), 'project/lc');
    const ev = X.events('review_stage').filter((e) => !e.ok).pop();
    assert.deepStrictEqual([ev.code, JSON.parse(ev.row_ids).length], [code, 3]);
    assert.deepStrictEqual(m.stopped, [m.spawned[0].worker_id], `${label}: the child was stopped`);
  }
});

// REPORT 6.1: the adversarial verdicts are refused by the core at no cost beyond the reviewer's own call.
test('adversarial verdicts: an id with no hold, an archive without a cite, a cite that is not there, forged verdicts and fields', async () => {
  await drain();
  const a = await held('adversarial a'), b = await held('adversarial b'), c = await held('adversarial c');
  const unheld = T.note('never held at all');
  const queueIds = () => queue().then((q) => q.map((h) => h.id).sort());
  const before = await queueIds();

  const nohold = await review(fakeManager(T, 'apply', json('verdicts', [archiveV(unheld)])), {}, {});
  assert.deepStrictEqual(nohold.result.refused.map((r) => r.code), ['E_NOT_FOUND'], 'a note nobody held cannot be archived');
  assert.strictEqual(nsOf(unheld), 'project/lc');

  const nocite = await review(fakeManager(T, 'apply', json('verdicts', [archiveV(a, { cites: [] })])));
  assert.strictEqual(nocite.error.code, 'E_ARGS');
  const badcite = await review(fakeManager(T, 'apply', json('verdicts', [archiveV(a, { cites: [{ where: 'loader.js', quote: 'a line that the file does not contain anywhere' }] })])));
  assert.deepStrictEqual(badcite.result.refused.map((r) => r.code), ['E_CITATION']);
  const body = JSON.parse(T.row((await queue()).find((h) => h.id === a).held_row).body);
  assert.strictEqual(body.reviews.pop().outcome, 'refused', 'the refusal is a fact on the held row');
  for (const [label, v] of [
    ['forged verdict', [{ id: a, verdict: 'delete', reason: 'remove it for good' }]],
    ['forged verdict purge', [{ id: a, verdict: 'purge', reason: 'remove it for good', cites: [T.cite] }]],
    ['extra field', [archiveV(a, { namespace: 'project/other' })]],
    ['twice', [archiveV(a), archiveV(a)]],
    ['not an array item', ['archive everything']],
  ]) {
    const o = await review(fakeManager(T, 'apply', json('verdicts', v)));
    assert.strictEqual(o.error && o.error.code, 'E_ARGS', label);
  }
  assert.deepStrictEqual(await queueIds(), before, 'no adversarial verdict moved a note');
  for (const id of [a, b, c]) assert.strictEqual(nsOf(id), 'project/lc');
});

test('adversarial verdicts: the facts are checked again at apply time, so a hold whose trigger vanished is refused with a receipt', async () => {
  await drain();
  const n = await held('trigger vanishes');
  T.store.db.prepare("UPDATE memory_entries SET body = json_set(body, '$.reported_wrong', json('[]')) WHERE id = ?").run(n);
  const o = await review(fakeManager(T, 'apply', json('verdicts', [archiveV(n)])), {}, { force: true });
  assert.deepStrictEqual(o.result.refused.map((r) => r.code), ['E_PRECONDITION']);
  assert.strictEqual(nsOf(n), 'project/lc', 'not archived');
  assert.strictEqual((await queue()).length, 1, 'still held');
});

test('by hand the reviewer ignores the triggers, and an empty queue is still nothing', async () => {
  await drain();
  const empty = await review(null, {}, { force: true });
  assert.strictEqual(empty.reason, 'empty queue');
  const n = await held('forced review');
  const o = await review(fakeManager(T, 'apply', json('verdicts', [releaseV(n)])), {}, { force: true });
  assert.deepStrictEqual([o.ran, o.trigger, o.result.counts.applied], [true, 'asked by hand', 1]);
  const off = await review(fakeManager(T, 'apply', json('verdicts', [])), { scrub_action: 'off' }, { force: true });
  assert.strictEqual(off.ran, false, 'nothing to review after the release');
});

test('closeStages: the scrub then the review, one manager built only when a child is to be spawned, nothing at all with notes off', async () => {
  await drain();
  assert.strictEqual(await closeStages({ core: X.coreFor('plain'), runId: RUN.plain, levers: LV.plain, dataDir: T.dir }), null);
  let built = 0;
  const { log, core } = X.calls(X.coreFor('apply'));
  const none = await closeStages({ core, runId: RUN.apply, levers: { memory_levers: lv() }, dataDir: T.dir, worktree: T.repo, makeManager: async () => { built += 1; } });
  assert.deepStrictEqual([none.scrub.reason, none.review.reason, built, log], ['empty scope', 'empty queue', 0, ['memory.scrubScope', 'memory.reviewQueue']], 'two reads, no manager, nothing created');
  const evBefore = T.store.p('SELECT COUNT(*) AS n FROM memory_event').get().n;
  const rows = T.store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n;
  await closeStages({ core: X.coreFor('apply'), runId: RUN.apply, levers: lv(), dataDir: T.dir, worktree: T.repo });
  assert.strictEqual(T.store.p('SELECT COUNT(*) AS n FROM memory_event').get().n, evBefore);
  assert.strictEqual(T.store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n, rows);

  const rep = X.reported('close: reported wrong');
  const mk = [];
  const m = fakeManager(T, 'apply', (a) => (a.worker_id.startsWith('scrub-') ? json('scrub', [X.hold(rep)]) : json('verdicts', [archiveV(rep)])));
  const both = await closeStages({ core: X.coreFor('apply'), runId: RUN.apply, levers: lv({ review_min_held: 1 }), dataDir: T.dir, worktree: T.repo, makeManager: async () => { mk.push(1); return m; } });
  assert.strictEqual(mk.length, 1, 'one manager for both stages');
  assert.deepStrictEqual(m.spawned.map((s) => s.worker_id.split('-')[0]), ['scrub', 'archreview'], 'the scrub, then the review');
  assert.deepStrictEqual([both.scrub.result.counts.applied, both.review.result.counts.applied, nsOf(rep)], [1, 1, 'archive/lc']);
  const skipped = await closeStages({ core: X.coreFor('apply'), runId: RUN.apply, levers: lv(), dataDir: T.dir, worktree: T.repo, review: false, makeManager: async () => m });
  assert.strictEqual(skipped.review, null);
});

test('a stage that throws is a returned fact, never an exception out of run close', async () => {
  const bad = new Proxy({}, { get: () => { throw new Error('the core is gone'); } });
  const o = await closeStages({ core: bad, runId: RUN.apply, levers: lv(), dataDir: T.dir });
  assert.ok(o.scrub.ran === false && o.review.ran === false);
});
