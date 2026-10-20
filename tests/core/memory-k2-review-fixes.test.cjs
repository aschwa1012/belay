'use strict';
// memory-k2-review-fixes.test.cjs — the second-look fixes of the note lifecycle: an unsupported hold's file cite is read at the hold's own head,
// a chain of merges and a restore keep each note's own deliveries, the archive of a superseder names every note that left with it, a
// write-time hold keeps its writer's head, and the recorded-match guard fails a one-line mutation of each of its clauses.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { setup, PROJECT, A, A_NEAR, B } = require('./lifecycle-env.cjs');
const { queueUnsupported } = require('../../src/core/note-unsupported.cjs');

let T;
before(async () => { T = await setup(); });
after(() => T.close());

const scrub = (entries, extra = {}) => T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: entries, scope: entries.flatMap(e => [e.id, e.of].filter(Boolean)), ...T.evidence, ...extra });
const relate = (id, relation, of) => ({ id, action: 'relate', relation, of, reason: `they relate as ${relation}` });
const resolve = (resolutions, who = T.who.tool('apply')) => T.call(who, 'memory.noteResolve', { resolutions });
const ns = id => T.row(id).namespace;
const pendingFor = (title, target, over = {}) => T.note(title, { ns: `pending/${PROJECT}`, state: 'pending', vec: A_NEAR, matches: [{ id: target, title: 'x', kind: 'lesson', basis: 'observed', similarity: 0.99 }], ...over });
const git = (...a) => execFileSync('git', a, { cwd: T.repo, encoding: 'utf8', windowsHide: true }).trim();

test('an unsupported hold\'s file cite is read at the hold\'s own head, not at the call\'s head from another worker', async () => {
  const n = T.note('uns head note', { task_id: 'uns-t' });
  const route = { reviewer: 'rv', ref: 'ref1', keyBase: 'k1' };
  queueUnsupported(T.E, T.who.harness('apply'), route, { id: n, reason: 'no single place', cites: [] }, { id: n, task_id: 'uns-t', run_id: 'old-run' });
  const heldRow = T.body(n).unsupported.held_row;
  T.store.patchBody(heldRow, b => { b.head_sha = T.head; return b; });
  // another worker's newer commit no longer holds the line the cite quotes
  fs.writeFileSync(`${T.repo}/loader.js`, 'function load(name) {\n  return fixtures.fetch(name);\n}\n');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-am', 'other worker');
  const other = git('rev-parse', 'HEAD');
  assert.notStrictEqual(other, T.head);
  const r = await T.call(T.who.harness('apply'), 'memory.reviewApply', { verdicts: [{ id: n, verdict: 'verify', reason: 'the loader throws on unlisted names', cites: [T.cite] }], worktree: T.repo, head_sha: other });
  assert.deepStrictEqual([r.counts.applied, r.counts.refused], [1, 0], JSON.stringify(r.refused));
  assert.strictEqual(T.body(n).unsupported.state, 'verified');
});

test('D63: a delivery a merged note carried does not hide that note\'s own delivery, so a restore of the first leaves it', async () => {
  const a = T.note('chain a', { vec: A, created_at: 100 });
  const b = T.note('chain b', { vec: A_NEAR, created_at: 200, task_id: 'ch-b', written_by: 'worker:wb' });
  const c = T.note('chain c', { vec: A_NEAR, created_at: 300, task_id: 'ch-c', written_by: 'worker:wc' });
  const op = T.who.operator('apply');
  await T.call(T.who.tool('apply'), 'memory.recordEvent', { kind: 'index_injected', worker_id: 'w9', task_id: 'tz', row_ids: [b, c] });
  await scrub([relate(c, 'repeats', b)]);
  await scrub([relate(b, 'repeats', a)]);
  assert.ok(T.body(a).delivery_history.length >= 2, 'both the carried and the own delivery arrive');
  await T.call(op, 'memory.noteRestore', { id: c, reason: 'not a repeat' });
  assert.strictEqual((await T.call(op, 'memory.noteDeliveries', { note_id: c })).deliveries.length, 1, 'c gets its own back');
  assert.strictEqual((await T.call(op, 'memory.noteDeliveries', { note_id: a })).deliveries.length, 1, 'b\'s own delivery stays on a');
  assert.ok(T.body(a).delivery_history.some(d => d.hops && d.hops[0] === b));
});

test('an archive that takes a replaced note with it returns the whole chain as proof, and the scrub counts every note that left', async () => {
  const first = T.note('proof first', { vec: B, created_at: 100 });
  const kept = T.note('proof kept', { vec: A, created_at: 100 });
  const second = pendingFor('proof second', first);
  await resolve([{ id: second, resolve: 'supersedes', of: first, evidence: [{ where: 'a.js', saw: 'one' }] }]);
  const third = pendingFor('proof third', second);
  await resolve([{ id: third, resolve: 'supersedes', of: second, evidence: [{ where: 'a.js', saw: 'two' }] }]);
  const r = await scrub([relate(third, 'repeats', kept)]);
  assert.deepStrictEqual(r.applied[0].replaced_also_archived, [second, first]);
  assert.strictEqual(r.counts.archives, 3, 'the relation and the two notes that left with it');
  // a refines resolution returns it too
  const older = T.note('proof older', { vec: B, created_at: 100 });
  const old = pendingFor('proof old', older);
  await resolve([{ id: old, resolve: 'supersedes', of: older, evidence: [{ where: 'a.js', saw: 'x' }] }]);
  const neu = pendingFor('proof neu', old);
  const res = await resolve([{ id: neu, resolve: 'refines', of: old }]);
  assert.deepStrictEqual(res.resolved[0].replaced_also_archived, [older]);
  assert.strictEqual(ns(older), `archive/${PROJECT}`);
});

test('a note that replaced a row that is not a note leaves that row where it is', async () => {
  const kept = T.note('nonnote kept', { vec: A, created_at: 100 });
  const sup = T.note('nonnote superseder', { vec: A_NEAR, created_at: 200 });
  const row = T.store.storeIn({ namespace: `project/${PROJECT}`, worker_id: 'w1', type: 'summary', text: 'a summary row', title: 'summary', body: {}, run_id: 'old-run', source: 'model', written_by: 'worker:w1' });
  T.store.setSupersedes(sup, row.id);
  await scrub([relate(sup, 'repeats', kept)]);
  assert.strictEqual(ns(sup), `archive/${PROJECT}`);
  assert.strictEqual(ns(row.id), `project/${PROJECT}`);
});

test('D32: a write-time hold records the head of the writer\'s own task when it has one, and none otherwise', async () => {
  const wh = 'a'.repeat(40);
  await T.call(T.who.tool('apply'), 'worker.write', { id: 'w-wt', substrate: 'claude-code', pid: process.pid, state: 'stopped', session_id: 's-wt', last_event_at: Date.now(), task_id: 'wt-task', worktree: T.repo, head_sha: wh, base_sha: T.head });
  const headOfHold = async (task_id) => {
    const v = T.note(`d32 head verified ${task_id}`, { vec: A, created_at: 100, status: 'verified' });
    const p = pendingFor(`d32 head new ${task_id}`, v, { task_id });
    await resolve([{ id: p, resolve: 'refines', of: v, evidence: [{ where: 'src/a.js', saw: 'x' }] }]);
    return JSON.parse(T.row(T.body(v).held.row).body).head_sha;
  };
  assert.strictEqual(await headOfHold('wt-task'), wh);
  assert.strictEqual(await headOfHold('wt-task-none'), null);
});

test('L07: a recorded match binds only to the dimension and template of both vectors', async () => {
  const dup = (id, of) => ({ id, action: 'hold', kind: 'duplicate', of, ground: 'same_claim', reason: 'same claim' });
  const mk = (name, patch = {}, match = {}) => {
    const kept = T.note(`l07b kept ${name}`, { vec: A, created_at: 100 });
    const id = T.note(`l07b ${name}`, { vec: B, created_at: 200, matches: [{ id: kept, title: 't', kind: 'lesson', basis: 'observed', similarity: 0.99, embedding_model: 'm', dim: 3, template: 'v1', ...match }] });
    T.store.p('UPDATE memory_entries SET embedding = NULL WHERE id = ?').run(id);
    if (patch.note) T.store.p(`UPDATE memory_entries SET ${patch.note} WHERE id = ?`).run(id);
    if (patch.target) T.store.p(`UPDATE memory_entries SET ${patch.target} WHERE id = ?`).run(kept);
    return dup(id, kept);
  };
  assert.strictEqual((await scrub([mk('control')])).applied[0].outcome, 'held', 'the control binds');
  const refused = async (name, patch, match) => assert.strictEqual((await scrub([mk(name, patch, match)])).refused[0].code, 'E_PRECONDITION', name);
  await refused('match dim', {}, { dim: 4 });
  await refused('note dim', { note: 'dim = 4' }, {});
  await refused('target dim', { target: 'dim = 4' }, {});
  await refused('note model', { note: "embedding_model = 'other'" }, {});
  await refused('target model', { target: "embedding_model = 'other'" }, {});
  await refused('match template', {}, { template: 'v2' });
  await refused('note template', { note: "text_template = 'v2'" }, {});
  await refused('target template', { target: "text_template = 'v2'" }, {});
});

test("D63: a note restored after a chain of merges has its own provenance back, and archiving it again hands over each delivery once", async () => {
  const a = T.note('prov a', { vec: A, created_at: 100 });
  const b = T.note('prov b', { vec: A_NEAR, created_at: 200, task_id: 'pv-b', written_by: 'worker:wb' });
  const c = T.note('prov c', { vec: A_NEAR, created_at: 300, task_id: 'pv-c', written_by: 'worker:wc' });
  const op = T.who.operator('apply');
  await T.call(T.who.tool('apply'), 'memory.recordEvent', { kind: 'index_injected', worker_id: 'w9', task_id: 'tz', row_ids: [c] });
  await scrub([relate(c, 'repeats', b)]);
  await scrub([relate(b, 'repeats', a)]);
  await T.call(op, 'memory.noteRestore', { id: c, reason: 'not a repeat' });
  assert.deepStrictEqual(T.body(c).delivery_history.map(d => [d.task_id, d.from, d.hops]), [['tz', c, undefined]], 'the delivery is c\'s own again, not b\'s');
  const shown = (await T.call(op, 'memory.noteDeliveries', { note_id: c })).deliveries;
  assert.deepStrictEqual(shown.map(d => [d.task_id, d.from_duplicate]), [['tz', undefined]]);
  await scrub([relate(c, 'repeats', a)]);
  const moved = T.body(a).delivery_history.filter(d => d.hops && d.hops[0] === c);
  assert.strictEqual(moved.length, 1, 'the delivery c carried is not copied a second time beside its ledger entry');
  assert.strictEqual(T.body(a).merged_from.filter(m => m.id === c).pop().deliveries, 1);
  assert.strictEqual(T.body(c).delivery_history.length, 0);
});

test("D30: a chain of replaced notes longer than any bound goes whole with the note that displaced it, and each archive names its replacer", async () => {
  const kept = T.note('long kept', { vec: A, created_at: 100 });
  const ids = [];
  for (let i = 0; i < 25; i += 1) {
    ids.push(T.note(`long ${i}`, { vec: i === 24 ? A_NEAR : B, created_at: 100 + i }));
    if (i > 0) T.store.setSupersedes(ids[i], ids[i - 1]);
  }
  const top = ids[24];
  const r = await scrub([relate(top, 'repeats', kept)]);
  assert.strictEqual(r.refused.length, 0, JSON.stringify(r.refused));
  assert.deepStrictEqual(r.applied[0].replaced_also_archived, ids.slice(0, 24).reverse(), 'every replaced note is returned, newest first');
  assert.strictEqual(r.counts.archives, 25);
  for (const id of ids) assert.strictEqual(ns(id), `archive/${PROJECT}`, 'no displaced note comes back to the project');
  assert.strictEqual(T.body(ids[0]).archived.replaced_by_archived, ids[1]);
  assert.strictEqual(T.body(ids[23]).archived.replaced_by_archived, top);
  assert.strictEqual(T.body(top).archived.replaced_also_archived, ids[23]);
});

test("D30: a cycle of replacements ends, and each note is archived once", async () => {
  const kept = T.note('cycle kept', { vec: A, created_at: 100 });
  const x = T.note('cycle x', { vec: B, created_at: 100 });
  const y = T.note('cycle y', { vec: B, created_at: 101 });
  const top = T.note('cycle top', { vec: A_NEAR, created_at: 102 });
  for (const [row, target] of [[top, x], [x, y], [y, x]]) T.store.p('UPDATE memory_entries SET supersedes = ? WHERE id = ?').run(target, row);
  const r = await scrub([relate(top, 'repeats', kept)]);
  assert.strictEqual(r.refused.length, 0, JSON.stringify(r.refused));
  assert.deepStrictEqual(r.applied[0].replaced_also_archived, [x, y]);
  assert.deepStrictEqual([ns(top), ns(x), ns(y)], [`archive/${PROJECT}`, `archive/${PROJECT}`, `archive/${PROJECT}`]);
});
