'use strict';
// memory-note-report.test.cjs — memory.noteReport: the operator's (and the orchestrator's) report that a note is wrong holds it for the archive review
// exactly as a worker's report does (ADR 0047 amendment of 2026-10-21). Real core against a sandbox store; the faults are injected, never loaded.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./report-env.cjs');

let X;
before(async () => { X = await setup('r-oprep'); });
after(() => X.cleanup());

const op = () => ({ ...X.operator, pid: 4242 });
const report = (caller, args) => X.call('memory.noteReport', caller, args);
const hold = (id) => X.activeHold(id);

test('R1: the operator reports a live note: one hold, counted, harness-written, reporter operator:<pid>, proof returned', async () => {
  const a = await X.written('w-a1', 'K1');
  const before = await X.heldCount();
  const out = await report(op(), { note_id: a.note, why: 'the operator saw it fail' });
  assert.deepStrictEqual([out.state, out.reported_by, out.report.seq, out.reports], ['held', 'operator:4242', 1, 1]);
  const h = hold(a.note);
  assert.ok(h, 'one active hold');
  assert.deepStrictEqual([out.hold.row, out.held.id], [h.id, h.id]);
  assert.deepStrictEqual([h.b.ground, h.b.kind, h.b.reports.length, h.b.reports[0].by], ['reported', 'wrong', 1, 'operator:4242']);
  assert.strictEqual(X.rowOf(h.id).written_by, 'harness', 'the hold is written on the harness channel');
  assert.strictEqual(X.heldRows(a.note).length, 1);
  assert.strictEqual(await X.heldCount(), before + 1, 'counted in the held queue');
  assert.strictEqual(X.bodyOf(a.note).held.row, h.id);
  assert.strictEqual(X.bodyOf(a.note).reported_wrong[0].by, 'operator:4242');
});

test('R2: a second reporter appends to the same hold; the same reporter again replaces its own report', async () => {
  const a = await X.written('w-a2', 'K2');
  const first = await report(op(), { note_id: a.note, why: 'first reason' });
  const second = await report(X.orch, { note_id: a.note, why: 'the orchestrator agrees' });
  assert.deepStrictEqual([second.state, second.hold.row, second.reported_by], ['already_held', first.hold.row, 'orchestrator']);
  assert.strictEqual(hold(a.note).b.reports.length, 2);
  assert.strictEqual(X.heldRows(a.note).length, 1, 'still one hold');
  const again = await report(op(), { note_id: a.note, why: 'a better reason' });
  assert.strictEqual(again.state, 'already_held');
  const reports = X.bodyOf(a.note).reported_wrong;
  assert.deepStrictEqual(reports.map((r) => r.by).sort(), ['operator:4242', 'orchestrator']);
  assert.strictEqual(reports.find((r) => r.by === 'operator:4242').why, 'a better reason');
  assert.strictEqual(hold(a.note).b.reports.length, 2);
});

test('R3: a worker report on the note and the operator report share one hold; the reason is redacted', async () => {
  const a = await X.written('w-a3', 'K3');
  await X.reported('w-b3', a.note, 'the worker found it wrong');
  const key = ['sk', 'ant', 'api03', 'A'.repeat(40)].join('-');
  const out = await report(op(), { note_id: a.note, why: `leaked key ${key} in the text` });
  assert.strictEqual(out.state, 'already_held');
  assert.strictEqual(X.heldRows(a.note).length, 1);
  assert.deepStrictEqual(hold(a.note).b.reports.map((r) => r.by).sort(), ['operator:4242', 'worker:w-b3']);
  assert.ok(!JSON.stringify(X.bodyOf(a.note)).includes('AAAAAAAAAAAA'), 'the reason is stored redacted');
  assert.ok(!JSON.stringify(hold(a.note).b).includes('AAAAAAAAAAAA'));
});

test('R4: a fact is E_ARGS "not a note"; an archived or missing row is not_live', async () => {
  const f = await X.call('memory.store', X.orch, { namespace: 'project', type: 'fact', text: 'a plain fact about the build' });
  await assert.rejects(report(op(), { note_id: f.id, why: 'x' }), (e) => e.code === 'E_ARGS' && /not a note/.test(e.message));
  const a = await X.written('w-a4', 'K4');
  await report(op(), { note_id: a.note, why: 'x' });
  await X.call('memory.heldSettle', op(), { id: a.note, action: 'archive', reason: 'gone' });
  const rows = X.heldRows(a.note).length;
  await assert.rejects(report(op(), { note_id: a.note, why: 'again' }), (e) => e.code === 'E_NOT_FOUND' && e.detail.reason === 'not_live' && e.detail.state === 'archive');
  await assert.rejects(report(op(), { note_id: 'no-such-note', why: 'x' }), (e) => e.code === 'E_NOT_FOUND' && e.detail.reason === 'not_live');
  assert.strictEqual(X.heldRows(a.note).length, rows, 'nothing written by the refusals');
});

test('R5: who may call: a worker, the harness channel and the close stages are E_ROLE; no argument names a reporter', async () => {
  const a = await X.written('w-a5', 'K5');
  for (const who of [X.worker('w-a5'), X.harness, { ...X.operator, channel: 'harness' }]) {
    await assert.rejects(report(who, { note_id: a.note, why: 'x' }), (e) => e.code === 'E_ROLE');
  }
  await assert.rejects(report(op(), { note_id: a.note, why: 'x', by: 'operator:1' }), (e) => e.code === 'E_ARGS');
  await assert.rejects(report(op(), { note_id: a.note, why: '   ' }), (e) => e.code === 'E_ARGS');
  await assert.rejects(report(op(), { note_id: a.note, why: 'x', replaced_by: a.note }), (e) => e.code === 'E_ARGS');
  assert.strictEqual(hold(a.note), null, 'nothing written');
  assert.ok(!(X.bodyOf(a.note).reported_wrong || []).length);
});

test('R6: the orchestrator path records the reporter as "orchestrator"', async () => {
  const a = await X.written('w-a6', 'K6');
  const out = await report(X.orch, { note_id: a.note, why: 'the operator said it is wrong' });
  assert.deepStrictEqual([out.state, out.reported_by, hold(a.note).b.reports[0].by], ['held', 'orchestrator', 'orchestrator']);
});

test('R7: a report that names a replacement is held and records the replacement, as for a worker', async () => {
  const a = await X.written('w-a7', 'K7');
  const b = await X.written('w-b7', 'K12');
  const out = await report(op(), { note_id: a.note, why: 'replaced', replaced_by: b.note });
  assert.strictEqual(out.state, 'held');
  assert.strictEqual(hold(a.note).b.ground, 'reported');
  assert.ok(['wrong', 'superseded'].includes(hold(a.note).b.kind));
  assert.strictEqual(X.bodyOf(a.note).reported_wrong[0].replaced_by, b.note);
});

test('R8: the archive review is offered the operator\'s report, and the operator settles it as a worker\'s', async () => {
  const a = await X.written('w-a8', 'K8');
  await report(op(), { note_id: a.note, why: 'the operator found it false' });
  const q = await X.call('memory.reviewQueue', X.harness, {});
  const entry = q.held.find((e) => e.id === a.note);
  assert.ok(entry, 'the held note is in the review queue');
  assert.ok(JSON.stringify(entry).includes('operator:4242'), 'the entry carries the operator\'s report');
  const out = await X.call('memory.heldSettle', op(), { id: a.note, action: 'release', reason: 'judged unfounded' });
  assert.strictEqual(out.settled.count, 1);
  assert.strictEqual(hold(a.note), null);
});

// The mark on the note and the hold are one transaction. A fault in the hold writer leaves no mark; the same run against the method with its
// transaction removed finds the mark, which shows the test can fail.
let faultN = 20;
async function faultRun(method) {
  const a = await X.written(`w-at${faultN}`, `K${faultN++}`);
  const RH = require('../../src/core/memory-report-hold.cjs');
  const real = RH.holdReported;
  RH.holdReported = () => { throw new Error('injected fault in the hold writer'); };
  try { await method(X.E, op(), { note_id: a.note, why: 'x' }); assert.fail('the fault must reach the caller'); } catch (e) { assert.match(e.message, /injected fault/); } finally { RH.holdReported = real; }
  return { marked: (X.bodyOf(a.note).reported_wrong || []).length, hold: hold(a.note) };
}

test('R9: atomic: a fault in the hold leaves no mark; the mutation without the transaction is caught', async () => {
  const file = path.resolve(__dirname, '../../src/core/methods-memory-note-report.cjs');
  const real = await faultRun(require(file).noteReport);
  assert.deepStrictEqual([real.marked, real.hold], [0, null], 'rolled back as one');
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(src.includes('E.store.tx(() => {'), 'the transaction is where the test expects it');
  const mutated = new Module(file, null);
  mutated.filename = file;
  mutated.paths = Module._nodeModulePaths(path.dirname(file));
  mutated._compile(src.replace('E.store.tx(() => {', '((f) => f())(() => {'), file);
  const broken = await faultRun(mutated.exports.noteReport);
  assert.strictEqual(broken.marked, 1, 'without the transaction the mark survives the fault: the atomicity test would fail');
});
