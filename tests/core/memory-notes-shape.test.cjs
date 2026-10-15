'use strict';
// memory-notes-shape.test.cjs — ADR 0047 decision 2: a note's shape is refused by name with E_NOTE_SHAPE, never truncated;
// the notes lever and its tuning levers validate and default off.

const { test } = require('node:test');
const assert = require('node:assert');
const { core } = require('./helpers.cjs');

const N = core('memory-notes.cjs');
const L = core('memory-levers.cjs');

const good = (over = {}) => ({
  kind: 'lesson', title: 'the loader skips fixtures not listed in the index file', basis: 'observed',
  evidence: [{ where: 'test/loader.js', saw: 'an unlisted fixture was never loaded' }], applies_to: ['test/fixtures/index.json'], subjects: ['fixture loader'], ...over,
});
const refused = (fn, re) => assert.throws(fn, e => e.code === 'E_NOTE_SHAPE' && re.test(e.message), String(re));

test('a well-formed note is accepted and normalised', () => {
  const n = N.checkNote(good({ applies_to: 'one/path', title: '  spaced \n title  ' }));
  assert.strictEqual(n.title, 'spaced title');
  assert.deepStrictEqual(n.applies_to, ['one/path']);
  assert.deepStrictEqual(N.checkNotes([]), []);
});

test('a title over 160 bytes is refused, never truncated; exactly 160 passes', () => {
  assert.strictEqual(N.checkNote(good({ title: 'a'.repeat(160) })).title.length, 160);
  refused(() => N.checkNote(good({ title: 'a'.repeat(161) })), /161 bytes.*never truncated/);
  refused(() => N.checkNote(good({ title: 'é'.repeat(81) })), /162 bytes/); // bytes, not characters
});

test('a missing title, kind or basis is refused', () => {
  refused(() => N.checkNote(good({ title: '' })), /title/);
  refused(() => N.checkNote(good({ title: undefined })), /title/);
  refused(() => N.checkNote(good({ kind: 'fact' })), /kind/);
  refused(() => N.checkNote(good({ basis: undefined })), /basis is required/);
  refused(() => N.checkNote(good({ basis: 'guessed' })), /basis/);
});

test('observed needs evidence; inferred and relayed do not', () => {
  refused(() => N.checkNote(good({ evidence: [] })), /at least one evidence/);
  refused(() => N.checkNote(good({ evidence: undefined })), /at least one evidence/);
  assert.deepStrictEqual(N.checkNote(good({ basis: 'inferred', evidence: undefined })).evidence, []);
  assert.strictEqual(N.checkNote(good({ basis: 'relayed', evidence: [] })).basis, 'relayed');
  refused(() => N.checkNote(good({ evidence: [{ where: 'x' }] })), /saw/);
  refused(() => N.checkNote(good({ evidence: [{ where: 'x', saw: 'y', extra: 1 }] })), /extra/);
});

test('a field the harness owns (model, written_by, id) is refused: a note cannot name its writer', () => {
  for (const k of ['model', 'written_by', 'id', 'run_id']) refused(() => N.checkNote(good({ [k]: 'x' })), new RegExp(k));
  refused(() => N.checkNote('a string'), /object/);
  refused(() => N.checkNotes(Array.from({ length: 11 }, () => good())), /at most 10/);
  assert.throws(() => N.checkNotes('x'), e => e.code === 'E_ARGS');
});

test('reported_wrong and resolutions are checked', () => {
  assert.deepStrictEqual(N.checkReportedWrong(undefined), []);
  assert.deepStrictEqual(N.checkReportedWrong([{ id: 'n1', why: 'it moved' }]), [{ id: 'n1', why: 'it moved', replaced_by: null }]);
  assert.strictEqual(N.checkReportedWrong([{ id: 'n1', why: 'w', replaced_by: 'notes[0]' }])[0].replaced_by, 'notes[0]');
  assert.throws(() => N.checkReportedWrong([{ id: 'n1' }]), e => e.code === 'E_ARGS');
  assert.throws(() => N.checkReportedWrong([{ id: 'n1', why: 'w', replaced_by: 'bad id' }]), e => e.code === 'E_ARGS');
  assert.deepStrictEqual(N.checkResolutions([{ id: 'p', resolve: 'new' }]), [{ id: 'p', resolve: 'new' }]);
  assert.throws(() => N.checkResolutions([{ id: 'p', resolve: 'repeats' }]), e => e.code === 'E_ARGS');
  assert.throws(() => N.checkResolutions([{ id: 'p', resolve: 'supersedes', of: 'q' }]), /evidence/);
  assert.throws(() => N.checkResolutions([{ id: 'p', resolve: 'new' }, { id: 'p', resolve: 'new' }]), /twice/);
  assert.strictEqual(N.checkResolutions([{ id: 'p', resolve: 'supersedes', of: 'q', evidence: [{ where: 'a', saw: 'b' }] }])[0].of, 'q');
});

test('levers: notes defaults off with its tuning levers, and validates', () => {
  const d = L.parseMemoryBlock(undefined).value;
  assert.deepStrictEqual([d.notes, d.notes_reflection, d.notes_lesson_question, d.notes_match_n, d.notes_match_threshold], [false, false, false, 3, 0.8]);
  assert.ok(L.isDefault(d));
  const on = L.parseMemoryBlock({ project: 'p', notes: true, notes_reflection: true, notes_lesson_question: true, notes_match_n: 5, notes_match_threshold: 0.9 });
  assert.ok(on.value && !L.isDefault(on.value));
  for (const [b, re] of [
    [{ notes: true }, /needs memory.project/],
    [{ project: 'p', notes: true, redact: false }, /unredacted/],
    [{ notes_reflection: true }, /needs memory.notes/],
    [{ notes_lesson_question: true }, /needs memory.notes/],
    [{ project: 'p', notes: true, notes_match_n: 0 }, /notes_match_n/],
    [{ project: 'p', notes: true, notes_match_threshold: 0 }, /notes_match_threshold/],
    [{ project: 'p', notes: 'yes' }, /true or false/],
  ]) assert.match(L.parseMemoryBlock(b).error || '', re, JSON.stringify(b));
});
