'use strict';
// memory-held-visibility.test.cjs — the proposed ADR 0047 amendment of 2026-10-25: a worker sees no held note on any read path (search, list,
// get, timeline, index), however it was held; the orchestrator and the operator see it marked from its hold row, ranked below every note that is
// not held; and the operator's settle still brings the note back, unmarked. Real core against a sandbox store, notes reported through lease.release.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./report-env.cjs');
const { renderSearchText, renderListText } = require('../../src/cli/memory-render.cjs');

let X;
before(async () => { X = await setup('r-hvis'); });
after(() => X.cleanup());

const NS = ['project/acme'];
// The note `id` as `caller` finds it on each read path a worker can reach: [search, list, get, timeline, index].
async function paths(caller, id, query) {
  const s = await X.call('memory.search', caller, { namespaces: NS, query, view: 'compact', k: 50 });
  const l = await X.call('memory.list', caller, { namespaces: NS, limit: 500 });
  const g = await X.call('memory.get', caller, { id });
  const t = await X.call('memory.timeline', caller, { anchor_id: id, scope: 'namespace' }).then((r) => r.anchor.id === id, (e) => (e.code === 'E_NOT_FOUND' ? false : Promise.reject(e)));
  const i = await X.call('memory.index', caller, { namespaces: NS, query });
  return [s.results.some((r) => r.id === id), l.rows.some((r) => r.id === id), g.found === true, t, i.row_ids.includes(id)];
}
// A live note of the project written straight to the store, on the fake embedder's axis `k` (cosine 1 to a query naming K<k>).
function direct(title, k) {
  const v = new Array(64).fill(0); v[k] = 1;
  return X.store.storeIn({ namespace: 'project/acme', worker_id: 'w-direct', type: 'note', text: title, title,
    body: { kind: 'lesson', basis: 'observed', evidence: [], applies_to: [], subjects: [], model: 'm', state: 'live', seen_in: [], seen_total: 0, reported_wrong: [] },
    embedding: v, embedding_model: 'fake', embedding_revision: 'r', dim: 64, run_id: null, task_id: null, source: 'model', written_by: 'worker:w-direct' }).id;
}
// Each result's tier: 0 not held and at the floor, 1 held at the floor, 2 not held below it, 3 held below it. A page is in tier order.
const tiers = (results) => results.map((x) => (x.low_relevance ? 2 : 0) + (x.held ? 1 : 0));
const inOrder = (t) => t.every((v, i) => i === 0 || t[i - 1] <= v);
const NONE = [false, false, false, false, false];
const ALL = [true, true, true, true, true];

test('a reported note: no worker path shows it; the orchestrator sees it marked and ranked below a note that is not held', async () => {
  const held = await X.written('w-a1', 'K11');
  const plain = await X.written('w-a2', 'K12');
  await X.reported('w-b1', held.note, 'the loader does read unlisted fixtures');
  assert.ok(X.activeHold(held.note), 'the report held the note');
  assert.deepStrictEqual(await paths(X.worker('w-c1'), held.note, 'K11 loader'), NONE);
  assert.deepStrictEqual(await paths(X.worker('w-c1'), plain.note, 'K12 loader'), ALL);
  assert.deepStrictEqual(await paths(X.orch, held.note, 'K11 loader'), ALL);

  // The held note ranks below a note that is not held and reaches the floor, and above one that does not (K12 is unrelated to the query).
  const sibling = direct('the fixture index of K11 lists every file', 11);
  const o = await X.call('memory.search', X.orch, { namespaces: NS, query: 'K11 loader', view: 'compact', k: 50 });
  const ids = o.results.map((r) => r.id);
  assert.ok(ids.indexOf(sibling) >= 0 && ids.indexOf(sibling) < ids.indexOf(held.note), 'below a relevant note that is not held');
  assert.ok(ids.indexOf(plain.note) > ids.indexOf(held.note), 'above a low-relevance note');
  assert.strictEqual(o.results.find((x) => x.id === plain.note).low_relevance, true);
  assert.ok(inOrder(tiers(o.results)), JSON.stringify(tiers(o.results)));
  const r = o.results.find((x) => x.id === held.note);
  assert.deepStrictEqual([r.held.kind, /unlisted/.test(r.held.reason)], ['wrong', true], 'marked with the hold kind and the report reason');
  assert.strictEqual(o.results.find((x) => x.id === plain.note).held, undefined);

  // The same order and mark in the debug view and for the operator; the list marks it in time order.
  const d = await X.call('memory.search', X.operator, { namespaces: NS, query: 'K11 loader', view: 'debug', k: 50 });
  const at = (id) => d.results.findIndex((x) => x.id === id);
  assert.ok(at(sibling) < at(held.note) && at(held.note) < at(plain.note));
  assert.deepStrictEqual([d.results.find((x) => x.id === held.note).held.kind, d.results.find((x) => x.id === held.note).held.ground], ['wrong', 'reported']);
  const l = await X.call('memory.list', X.orch, { namespaces: NS, limit: 500 });
  assert.strictEqual(l.rows.find((x) => x.id === held.note).held.kind, 'wrong');
  assert.strictEqual(l.rows.find((x) => x.id === plain.note).held, undefined);
  const li = await X.call('memory.list', X.operator, { namespaces: NS, limit: 500, view: 'index' });
  assert.strictEqual(li.rows.find((x) => x.id === held.note).held.kind, 'wrong');
  // The operator's text output says so on the row.
  const line = (text, id) => text.split('\n').find((x) => x.includes(id));
  assert.match(line(renderListText(l, 'full'), held.note), /held:wrong/);
  assert.doesNotMatch(line(renderListText(l, 'full'), plain.note), /held:/);
  assert.match(line(renderSearchText(d, 'full'), held.note), /held:wrong/);
});

test('a note the scrubber held as a duplicate is withheld from a worker too, and marked for the orchestrator', async () => {
  const a = await X.written('w-d1', 'K21');
  const b = await X.written('w-d2', 'K22');
  X.store.storeIn({ namespace: 'held/acme', worker_id: 'harness', type: 'held', text: `held duplicate ${b.note}`, title: 'h', body: { state: 'held', note_id: b.note, kind: 'duplicate', of: a.note, ground: 'same_claim', reason: 'the same claim as K21', rev: 0 }, run_id: X.RUN, source: 'harness', written_by: 'harness' });
  assert.deepStrictEqual(await paths(X.worker('w-d3'), b.note, 'K22 loader'), NONE);
  const o = await X.call('memory.search', X.orch, { namespaces: NS, query: 'K22 loader', view: 'compact', k: 50 });
  assert.strictEqual(o.results.find((x) => x.id === b.note).held.kind, 'duplicate');
  assert.ok(inOrder(tiers(o.results)), JSON.stringify(tiers(o.results)));
  assert.strictEqual(o.results[0].id, b.note, 'no other note reaches the floor, so the held best match leads the page, marked');
});

test('a pointer that outlived its hold marks nothing and demotes nothing', async () => {
  const a = await X.written('w-e1', 'K31');
  X.store.patchBody(a.note, (body) => { body.held = { row: 'gone-row', kind: 'wrong', reason: 'stale', at: 1 }; return body; });
  const o = await X.call('memory.search', X.orch, { namespaces: NS, query: 'K31 loader', view: 'compact', k: 50 });
  assert.strictEqual(o.results[0].id, a.note);
  assert.strictEqual(o.results[0].held, undefined);
  assert.strictEqual((await X.call('memory.list', X.orch, { namespaces: NS, limit: 500 })).rows.find((x) => x.id === a.note).held, undefined);
  X.store.patchBody(a.note, (body) => { delete body.held; return body; });
});

test('the operator\'s release settles the hold: the worker sees the note again and nobody sees a mark', async () => {
  const a = await X.written('w-f1', 'K41');
  await X.reported('w-f2', a.note, 'the loader reads unlisted fixtures');
  assert.deepStrictEqual(await paths(X.worker('w-f3'), a.note, 'K41 loader'), NONE);
  const out = await X.call('memory.heldSettle', X.operator, { id: a.note, action: 'release', reason: 'the reports were unfounded' });
  assert.strictEqual(out.outcome, 'released');
  assert.deepStrictEqual(await paths(X.worker('w-f3'), a.note, 'K41 loader'), ALL);
  const o = await X.call('memory.search', X.orch, { namespaces: NS, query: 'K41 loader', view: 'compact', k: 50 });
  assert.deepStrictEqual([o.results[0].id, o.results[0].held], [a.note, undefined]);
  assert.strictEqual((await X.call('memory.held', X.orch, { project: 'acme', list: true })).entries.some((e) => e.note_id === a.note), false);
});

test('an unsupported row marks and demotes nothing, for a worker or the orchestrator', async () => {
  const a = await X.written('w-g1', 'K51');
  await X.written('w-g2', 'K52');
  X.store.storeIn({ namespace: 'held/acme', worker_id: 'harness', type: 'held', text: `held unsupported ${a.note}`, title: 'h', body: { state: 'held', note_id: a.note, kind: 'unsupported', ground: 'unsupported', reason: 'no single place proves it', rev: 0 }, run_id: X.RUN, source: 'harness', written_by: 'harness' });
  for (const who of [X.worker('w-g3'), X.orch]) {
    const o = await X.call('memory.search', who, { namespaces: NS, query: 'K51 loader', view: 'compact', k: 50 });
    assert.deepStrictEqual([o.results[0].id, o.results[0].held], [a.note, undefined], who.role);
    const l = await X.call('memory.list', who, { namespaces: NS, limit: 500 });
    assert.strictEqual(l.rows.find((x) => x.id === a.note).held, undefined, who.role);
  }
});

test('a hand-back that restates a held note names it by id and verdict only, never its claim', async () => {
  const a = await X.written('w-h1', 'K61');
  X.store.storeIn({ namespace: 'held/acme', worker_id: 'harness', type: 'held', text: `held duplicate ${a.note}`, title: 'h', body: { state: 'held', note_id: a.note, kind: 'wrong', ground: 'scrubber', reason: 'the scrubber found it wrong', rev: 0 }, run_id: X.RUN, source: 'harness', written_by: 'harness' });
  const s = await X.startTask('w-h2', 'the loader worked\n');
  const out = await X.call('lease.release', X.worker('w-h2'), { lease_id: s.lease, notes: [{ ...X.note('K61'), title: 'a restated K61 claim, worded anew' }] });
  const n = out.notes[0];
  assert.strictEqual(n.state, 'pending', 'the restatement waits in pending');
  const named = [...(n.matches || []), ...(n.prior_verdicts || [])].filter((m) => m.id === a.note);
  assert.ok(named.length >= 1, 'the held note is named');
  for (const m of named) {
    assert.strictEqual(m.verdict, 'held_for_review');
    for (const k of ['title', 'kind', 'basis', 'text', 'reason']) assert.strictEqual(m[k], undefined, k);
  }
  assert.ok(!JSON.stringify(out).includes(X.rowOf(a.note).title), 'the held claim\'s title is nowhere in the answer');
  assert.doesNotMatch(n.held_back, /after a report/);
});

test('a long hold reason is cut to the compact row\'s bound in every view', async () => {
  const a = await X.written('w-i1', 'K9');
  X.store.storeIn({ namespace: 'held/acme', worker_id: 'harness', type: 'held', text: `held long ${a.note}`, title: 'h', body: { state: 'held', note_id: a.note, kind: 'wrong', ground: 'scrubber', reason: 'y'.repeat(400), rev: 0 }, run_id: X.RUN, source: 'harness', written_by: 'harness' });
  const marks = [];
  for (const view of ['compact', 'debug', 'index']) marks.push((await X.call('memory.search', X.orch, { namespaces: NS, query: 'K9 loader', view, k: 50 })).results.find((x) => x.id === a.note).held);
  for (const view of ['full', 'index']) marks.push((await X.call('memory.list', X.orch, { namespaces: NS, limit: 500, view })).rows.find((x) => x.id === a.note).held);
  for (const m of marks) assert.strictEqual(Buffer.byteLength(m.reason), 160);
});
