'use strict';
// memory-refute-withheld.test.cjs — across the two halves of ADR 0047 amendment of 2026-10-22: a reviewer's or the orchestrator's `refuted` on a note is a
// report (the note is held, its status is left), and a held note is withheld from a worker of a later run, as a refuted note was before. The orchestrator,
// the operator and the knowledge agent still see it.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./report-env.cjs');
const { callerFor } = require('./helpers.cjs');

let X;
const LATER = 'r-xw-later';
before(async () => {
  X = await setup('r-xw');
  await X.call('run.attach', callerFor('orchestrator', { run_id: LATER }), { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
});
after(() => X.cleanup());

const later = () => callerFor('worker', { run_id: LATER, worker_id: 'w-later' });
const Q = 'the loader worked as the note says';
async function seen(caller, id) {
  const idx = await X.call('memory.index', caller, { namespaces: ['project/acme'], query: 'loader fixtures' });
  const srch = await X.call('memory.search', caller, { namespaces: ['project/acme'], query: 'loader fixtures', mode: 'keyword', k: 50 });
  const list = await X.call('memory.list', caller, { namespaces: ['project/acme'] });
  return [idx.row_ids.includes(id), srch.results.some((r) => r.id === id), list.rows.some((r) => r.id === id)];
}
const ALL = [true, true, true], NONE = [false, false, false];

test('XW1: a reviewer\'s refuted leaves the note held, unrefuted, and withheld from a later run\'s worker; the orchestrator and the operator still see it', async () => {
  const a = await X.written('w-xw1', 'K1');
  assert.deepStrictEqual(await seen(later(), a.note), ALL, 'visible to the later worker before the review');
  const rt = await X.review('rev-xw1', a.task, { memory_verdicts: [X.rv(a.note, 'refuted', [X.cite(Q)], 'what the stream shows')] });
  const out = await X.apply(rt);
  assert.strictEqual(out.applied.length, 1, JSON.stringify(out.refused));
  assert.notStrictEqual(X.rowOf(a.note).status, 'refuted');
  assert.ok(X.activeHold(a.note));
  assert.deepStrictEqual(await seen(later(), a.note), NONE, 'withheld from the later worker');
  assert.deepStrictEqual(await seen(X.orch, a.note), ALL, 'the orchestrator sees it');
  assert.deepStrictEqual((await seen(callerFor('operator'), a.note)).slice(1), [true, true], 'so does the operator');
});

test('XW2: the orchestrator\'s refuted (memory_verify) is the same: held and withheld, never a status', async () => {
  const a = await X.written('w-xw2', 'K2');
  assert.deepStrictEqual(await seen(later(), a.note), ALL);
  const out = await X.call('memory.setStatus', X.orch, { id: a.note, status: 'refuted', receipt: 'test:the loader reads unlisted fixtures' });
  assert.strictEqual(out.state, 'held');
  assert.notStrictEqual(X.rowOf(a.note).status, 'refuted');
  assert.deepStrictEqual(await seen(later(), a.note), NONE);
  assert.deepStrictEqual(await seen(X.orch, a.note), ALL);
});

test('XW3: the archive review\'s release makes the note visible to the later worker again', async () => {
  const a = await X.written('w-xw3', 'K3');
  await X.call('memory.setStatus', X.orch, { id: a.note, status: 'refuted', receipt: 'test:x' });
  assert.deepStrictEqual(await seen(later(), a.note), NONE);
  await X.call('memory.heldSettle', X.operator, { id: a.note, action: 'release', reason: 'the operator checked: it is correct' });
  assert.deepStrictEqual(await seen(later(), a.note), ALL);
});
