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

  // K11 is the query's best match by both halves, and still ranks below the note that is not held.
  const o = await X.call('memory.search', X.orch, { namespaces: NS, query: 'K11 loader', view: 'compact', k: 50 });
  const ids = o.results.map((r) => r.id);
  assert.ok(ids.indexOf(plain.note) >= 0 && ids.indexOf(plain.note) < ids.indexOf(held.note), 'the held note ranks below the note that is not held');
  const r = o.results.find((x) => x.id === held.note);
  assert.deepStrictEqual([r.held.kind, /unlisted/.test(r.held.reason)], ['wrong', true], 'marked with the hold kind and the report reason');
  assert.strictEqual(o.results.find((x) => x.id === plain.note).held, undefined);
  for (const x of o.results.slice(0, ids.indexOf(held.note))) assert.strictEqual(x.held, undefined, 'no held note above it');

  // The same order and mark in the debug view and for the operator; the list marks it in time order.
  const d = await X.call('memory.search', X.operator, { namespaces: NS, query: 'K11 loader', view: 'debug', k: 50 });
  assert.ok(d.results.findIndex((x) => x.id === plain.note) < d.results.findIndex((x) => x.id === held.note));
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
  const marks = o.results.map((x) => !!x.held);
  assert.deepStrictEqual(marks, [...marks].sort((p, q) => p - q), 'every note that is not held ranks above every held one');
  assert.ok(marks.includes(false) && marks.includes(true));
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
