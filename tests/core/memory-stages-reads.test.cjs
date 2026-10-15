'use strict';
// memory-stages-reads.test.cjs — memory.scrubScope and memory.reviewQueue, the reads the run-close stages stand on. The scope is
// exactly the three kinds of item the rulings allow; the queue carries the facts the reviewer's triggers are decided from.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { setup, PROJECT } = require('./lifecycle-env.cjs');
const { callerFor } = require('./helpers.cjs');

let T;
before(async () => { T = await setup(); });
after(() => T.close());

const RUN = 'lc-apply';
const scope = (kind = 'apply') => T.call(T.who.operator(kind), 'memory.scrubScope', {});
const queue = (kind = 'apply') => T.call(T.who.operator(kind), 'memory.reviewQueue', {});
const mine = (over = {}) => T.report('worker:w2', null, over);
const event = (kind, ids, extra = {}) => T.call(T.who.harness('apply'), 'memory.recordEvent', { kind, run_id: RUN, key: `run:${RUN}`, row_ids: ids, ...extra });

test('scrubScope holds notes reported wrong IN THIS RUN, pending notes of this run, and nothing else', async () => {
  const hit = T.note('reported this run', { reported_wrong: [{ ...T.report(), run_id: RUN, worker_id: 'w2' }] });
  const old = T.note('reported in an old run', { reported_wrong: [T.report()] });
  const plain = T.note('delivered, never reported');
  const pend = T.note('pending from this run', { ns: `pending/${PROJECT}`, state: 'pending', run_id: RUN });
  const pendOld = T.note('pending from another run', { ns: `pending/${PROJECT}`, state: 'pending', run_id: 'old-run' });
  const archived = T.note('archived but reported', { ns: `archive/${PROJECT}`, reported_wrong: [{ ...T.report(), run_id: RUN }] });
  const other = T.note('another project', { ns: 'project/elsewhere', reported_wrong: [{ ...T.report(), run_id: RUN }] });
  const s = await scope();
  const ids = s.items.map((i) => i.id);
  assert.ok(ids.includes(hit) && ids.includes(pend));
  for (const n of [old, plain, pendOld, archived, other]) assert.ok(!ids.includes(n), `${n} is out of scope`);
  const it = s.items.find((i) => i.id === hit);
  assert.deepStrictEqual([it.state, it.why], ['live', ['reported_wrong']]);
  assert.strictEqual(it.reports[0].why, 'it is wrong');
  assert.strictEqual(s.items.find((i) => i.id === pend).state, 'pending');
  assert.deepStrictEqual([s.project, s.run_id], [PROJECT, RUN]);
});

test('scrubScope names the reporting workers\' streams that exist, the notes a report names and the stored matches', async () => {
  fs.mkdirSync(`${T.dir}/workers/w2`, { recursive: true });
  fs.writeFileSync(`${T.dir}/workers/w2/stream.jsonl`, '{}\n');
  const better = T.note('the replacement');
  const m = T.note('has matches', { ns: `pending/${PROJECT}`, state: 'pending', run_id: RUN, matches: [{ id: better, similarity: 0.9 }] });
  const rep = T.note('names a replacement', { reported_wrong: [{ ...T.report('worker:w2', better), run_id: RUN, worker_id: 'w2' }] });
  const s = await scope();
  const a = s.items.find((i) => i.id === rep), b = s.items.find((i) => i.id === m);
  assert.deepStrictEqual(a.streams.map((x) => x.worker_id), ['w2']);
  assert.ok(a.streams[0].path.endsWith('/workers/w2/stream.jsonl') && !a.streams[0].path.includes('\\'));
  assert.deepStrictEqual(a.related.map((r) => r.id), [better]);
  assert.deepStrictEqual(b.matches, [{ id: better, similarity: 0.9 }]);
  const ghost = T.note('report by a worker with no stream', { reported_wrong: [{ ...T.report(), run_id: RUN, worker_id: 'w-nowhere' }] });
  assert.deepStrictEqual((await scope()).items.find((i) => i.id === ghost).streams, []);
});

test('an owed item comes first, stays owed until a scrub handled it, and a failed job does not clear it', async () => {
  const n = T.note('owed from an earlier scrub');
  assert.ok(!(await scope()).items.some((i) => i.id === n));
  await event('scrub_owed', [n], { ok: false, code: 'E_TIMEOUT', message: 'did not finish' });
  const s = await scope();
  assert.strictEqual(s.items[0].id, n);
  assert.deepStrictEqual(s.items[0].why, ['owed']);
  assert.strictEqual(s.items[0].owed.code, 'E_TIMEOUT');
  await event('scrub_job', [n], { ok: false, code: 'E_COST_CAP', message: 'over' });
  assert.ok((await scope()).items.some((i) => i.id === n), 'a failed job handled nothing');
  await event('scrub_job', [n], { ok: true, message: 'handled' });
  assert.ok(!(await scope()).items.some((i) => i.id === n), 'a job that handled it clears it');
  await event('scrub_owed', [n], { ok: false, code: 'E_ARGS', message: 'again' });
  assert.ok((await scope()).items.some((i) => i.id === n), 'the last event decides');
});

test('an item a scrub of this run already handled is not offered again; one handled for another run still is', async () => {
  const mineN = T.note('handled this run', { reported_wrong: [{ ...T.report(), run_id: RUN }] });
  assert.ok((await scope()).items.some((i) => i.id === mineN));
  await event('scrub_job', [mineN], { ok: true, message: 'handled' });
  assert.ok(!(await scope()).items.some((i) => i.id === mineN), 'the same run is not scrubbed twice for it');
  await event('scrub_owed', [mineN], { ok: false, code: 'E_TIMEOUT', message: 'a later scrub could not' });
  assert.ok((await scope()).items.some((i) => i.id === mineN), 'owed again');
  const other = T.note('handled by another run', { reported_wrong: [{ ...T.report(), run_id: RUN }] });
  await T.call(T.who.harness('propose'), 'memory.recordEvent', { kind: 'scrub_job', run_id: 'lc-propose', key: 'other', row_ids: [other], ok: true, message: 'handled elsewhere' });
  assert.ok((await scope()).items.some((i) => i.id === other), 'a different run\'s scrub does not stand in for this run\'s');
});

test('a report that arrives after a scrub of this run handled the note is offered again', async () => {
  const n = T.note('reported, scrubbed, then reported again', { reported_wrong: [{ ...T.report(), run_id: RUN, at: Date.now() - 10000 }] });
  await event('scrub_job', [n], { ok: true, message: 'handled' });
  assert.ok(!(await scope()).items.some((i) => i.id === n));
  T.store.db.prepare("UPDATE memory_entries SET body = json_set(body, '$.reported_wrong[0].at', ?) WHERE id = ?").run(Date.now() + 5000, n);
  assert.ok((await scope()).items.some((i) => i.id === n), 'the newer report is a new item for the run close scrub');
});

test('an owed item that is no longer live or pending is not in scope, and an item in two kinds is listed once with both', async () => {
  const gone = T.note('owed then archived', { ns: `archive/${PROJECT}` });
  await event('scrub_owed', [gone], { ok: false, code: 'E_TIMEOUT', message: 'x' });
  assert.ok(!(await scope()).items.some((i) => i.id === gone));
  const both = T.note('owed and reported', { reported_wrong: [{ ...T.report(), run_id: RUN }] });
  await event('scrub_owed', [both], { ok: false, code: 'E_TIMEOUT', message: 'x' });
  const hits = (await scope()).items.filter((i) => i.id === both);
  assert.strictEqual(hits.length, 1);
  assert.deepStrictEqual(hits[0].why.sort(), ['owed', 'reported_wrong']);
});

test('scrubScope and reviewQueue are reads: a worker is refused, a run with no project has none, and nothing is written', async () => {
  await assert.rejects(T.call(callerFor('worker', { run_id: RUN, worker_id: 'w1' }), 'memory.scrubScope', {}), (x) => x.code === 'E_ROLE');
  await assert.rejects(T.call(callerFor('worker', { run_id: RUN, worker_id: 'w1' }), 'memory.reviewQueue', {}), (x) => x.code === 'E_ROLE');
  await assert.rejects(T.call(T.who.operator('apply'), 'memory.scrubScope', { x: 1 }), (x) => x.code === 'E_ARGS');
  const before = T.store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n;
  await scope(); await queue();
  assert.strictEqual(T.store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n, before);
});

test('reviewQueue lists open holds with both notes, the age in runs and whether a review verified the note', async () => {
  const a = T.note('held wrong', { reported_wrong: [T.report()] });
  const keep = T.note('the kept note');
  const verified = T.note('held but review-verified', { reported_wrong: [T.report()], status: 'verified' });
  T.store.p("UPDATE memory_entries SET status_receipt = 'review:notereview-t1' WHERE id = ?").run(verified);
  const dup = T.note('held duplicate', { reported_wrong: [T.report('worker:w2', keep)] });
  const sc = (entries) => T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: entries, scope: entries.flatMap((e) => [e.id, e.of].filter(Boolean)), ...T.evidence });
  const wrong = (id) => ({ id, action: 'hold', kind: 'wrong', ground: 'report_confirmed', reason: 'it is wrong here', cites: [T.cite] });
  await sc([wrong(a), wrong(verified), { id: dup, action: 'hold', kind: 'duplicate', of: keep, ground: 'same_claim', reason: 'same claim', cites: [T.cite] }]);
  const q = await queue();
  assert.deepStrictEqual(q.held.map((h) => h.id).sort(), [a, verified, dup].sort());
  const h = q.held.find((x) => x.id === dup);
  assert.deepStrictEqual([h.kind, h.of, h.of_note.id, h.note.id, h.target_review_verified], ['duplicate', keep, keep, dup, false]);
  assert.strictEqual(q.held.find((x) => x.id === verified).target_review_verified, true);
  assert.strictEqual(q.counts.count, 3);
  assert.strictEqual(q.counts.review_verified, 1);
  assert.ok(h.cites[0].quote && h.head_sha === T.head);
  // age in runs: a run of the project started after the mark counts
  assert.ok(q.counts.max_runs_waited >= 0);
  const later = Date.now() + 5000;
  T.store.db.prepare('UPDATE run SET started_at = ? WHERE id = ?').run(later, 'lc-plain');
  assert.ok((await queue()).held.every((x) => x.runs_waited >= 1), 'a run that started after the mark has waited');
});

test('a hold whose note has left the project is not offered to the reviewer', async () => {
  const n = T.note('held then moved', { reported_wrong: [T.report()] });
  await T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: [{ id: n, action: 'hold', kind: 'wrong', ground: 'report_confirmed', reason: 'it is wrong here', cites: [T.cite] }], scope: [n], ...T.evidence });
  assert.ok((await queue()).held.some((x) => x.id === n));
  T.store.p('UPDATE memory_entries SET namespace = ? WHERE id = ?').run(`archive/${PROJECT}`, n);
  assert.ok(!(await queue()).held.some((x) => x.id === n));
});
