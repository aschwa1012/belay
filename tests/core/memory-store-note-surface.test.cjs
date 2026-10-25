'use strict';
// memory-store-note-surface.test.cjs — what a project memory_store tells its writer (ADR 0047): the run-row fields a note refuses are named in the
// refusal, a `supersedes` refusal says how a note does replace another, and a note that matches a project note waits in pending with the match
// named and a next step for the orchestrator too. Real core, sandbox store, the fake embedder of report-env.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./report-env.cjs');
const tools = require('../../src/mcp/tools.cjs');

let X;
before(async () => { X = await setup('r-surface'); });
after(() => X.cleanup());

const note = (marker, over = {}) => ({ namespace: 'project/acme', ...X.note(marker), ...over });

test('a note refuses the run-row fields by name, and a supersedes refusal says how a note replaces another', async () => {
  for (const k of ['tags', 'type', 'provenance', 'ttl_seconds', 'text']) {
    const v = k === 'tags' ? ['a'] : k === 'ttl_seconds' ? 60 : k === 'type' ? 'fact' : 'x';
    await assert.rejects(X.call('memory.store', X.orch, note('K31', { [k]: v })), (e) => e.code === 'E_NOTE_SHAPE' && e.detail.field === k);
  }
  await assert.rejects(X.call('memory.store', X.orch, note('K31', { supersedes: 'some-id' })), (e) => e.code === 'E_NOTE_SHAPE'
    && /replaces another through review/.test(e.message) && /memory_report replaced_by/.test(e.message));
});

test('the listing names the fields a note does not take, for the worker and the orchestrator', () => {
  for (const role of ['worker', 'orchestrator']) {
    const ms = tools.toolsFor(role, { notes: true }).find((t) => t.name === 'memory_store');
    const ns = ms.inputSchema.properties.namespace.description;
    for (const k of ['text', 'type', 'tags', 'provenance', 'supersedes', 'ttl_seconds']) assert.ok(ns.includes(k), `${role}: ${k} named in ${ns}`);
  }
});

test('a note close to a project note waits in pending, names the match with its similarity, and tells the orchestrator what comes next', async () => {
  const first = await X.written('w-s1', 'K32');
  const out = await X.call('memory.store', X.orch, note('K32', { title: 'the K32 loader skips unlisted fixtures, restated' }));
  assert.strictEqual(out.state, 'pending');
  const m = out.matches.find((x) => x.id === first.note);
  assert.ok(m && typeof m.similarity === 'number' && m.similarity >= 0.9, JSON.stringify(out.matches));
  assert.match(out.next, /may duplicate the matches named here/);
});

test('memory_report answers compactly by default: the hold id, its state and what happened; view debug is the core answer', async () => {
  const V = require('../../src/mcp/views.cjs');
  const a = await X.written('w-s2', 'K33');
  const run = (args) => X.call('memory.noteReport', X.orch, args);
  const full = await run({ note_id: a.note, why: 'the loader reads unlisted fixtures' });
  const compact = V.memoryReport(full);
  assert.deepStrictEqual([compact.id, compact.state, compact.hold.row, compact.hold.state, compact.withheld], [a.note, full.state, full.hold.row, 'held', true]);
  assert.match(compact.withheld_why, /\S/);
  for (const k of ['held', 'row', 'project', 'reported_by']) assert.strictEqual(compact[k], undefined, k);
  const size = Buffer.byteLength(JSON.stringify(compact)), whole = Buffer.byteLength(JSON.stringify(full));
  console.log(`memory_report: compact ${size} bytes, debug ${whole} bytes`);
  assert.ok(size < 600 && whole > 4 * size, `${size} vs ${whole}`);
  // Through the adapter's view switch: no view is compact, view debug is the core's answer untouched, and view never reaches the core.
  const b = await X.written('w-s3', 'K34');
  const seen = [];
  const viaTool = (args) => V.viewed('memory_report', args, (rest) => { seen.push(rest); return run(rest); });
  const c = await viaTool({ note_id: b.note, why: 'wrong' });
  assert.strictEqual(c.held, undefined);
  const d = await viaTool({ note_id: b.note, why: 'still wrong', view: 'debug' });
  assert.ok(d.held && d.row, 'the debug answer carries the rows');
  assert.ok(seen.every((x) => !('view' in x)));
});
