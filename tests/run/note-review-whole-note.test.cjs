'use strict';
// The review job's prompt has one rule about values, and the brief shows each note capped (title, when, kind, basis, applies_to, subjects in
// full; text, evidence cut and counted), as data.
const test = require('node:test');
const assert = require('node:assert');
const T = require('../../src/run/note-review-text.cjs');

const noteOf = (extra = {}) => ({
  id: 'm-1', kind: 'lesson', basis: 'observed', task_id: 't1', written_by: 'worker:w1', title: 'mailbox lookup is case-insensitive in the domain', when: 'editing the mailbox lookup',
  text: 'mailbox lookup is case-insensitive in the domain editing the mailbox lookup mailbox',
  evidence: [{ where: 'run', saw: 'data/postwell/mailboxes.json lists mb_1021' }, { where: 'second', saw: 'test/mailbox.test.cjs line 40' }],
  applies_to: ['data/postwell/mailboxes.json', 'src/mailbox.cjs'], subjects: ['mailbox', 'postwell'], ...extra,
});
const lineOf = (n) => T.reviewerTail({ notes: [n], refuted_shown: [] }, []).split('\n').find((l) => l.startsWith('- m-1'));

test('the job prompt has the one value rule and neither of the two lines it replaced', () => {
  const p = T.jobPrompt(T.jobTemplate(), { notesFile: 'n.json', diffFile: 'd.diff', streams: [], taskId: 't1' });
  assert.match(p, /a wrong path or value anywhere in the note makes it refuted/);
  assert.ok(!p.includes('Judge the claim the note makes'));
  assert.ok(!p.includes("do not trust a note's own wording about what it saw"));
  assert.match(p, /neither proves nor disproves is unsupported/);
  assert.ok(!p.includes('is left out'));
  assert.match(p, /"unsupported" means no single place proves or disproves the note/);
});

test('a short note appears whole in the brief, as writer-stated data', () => {
  const out = lineOf(noteOf());
  for (const piece of ['writer-stated: mailbox lookup is case-insensitive in the domain', 'writer-stated situation (when): editing the mailbox lookup', 'writer-stated text: mailbox lookup',
    'run: data/postwell/mailboxes.json lists mb_1021', 'second: test/mailbox.test.cjs line 40', 'writer-stated applies_to: data/postwell/mailboxes.json; src/mailbox.cjs', 'writer-stated subjects: mailbox; postwell', '[lesson/observed]']) {
    assert.ok(out.includes(piece), piece);
  }
  assert.ok(!out.includes('[cut'));
});

test('a long note is capped: text at 400 bytes, saw at 200, three evidence entries, each cut naming its length', () => {
  const text = 'a'.repeat(900), saw = 'b'.repeat(500);
  const n = noteOf({ text, evidence: [1, 2, 3, 4, 5].map((i) => ({ where: `src/very/long/where/path-${i}.cjs`, saw })) });
  const out = lineOf(n);
  assert.ok(out.includes(`${'a'.repeat(400)}… [cut: 900 bytes in all]`));
  assert.ok(!out.includes('a'.repeat(401)));
  assert.strictEqual(out.split(`${'b'.repeat(200)}… [cut: 500 bytes in all]`).length - 1, 3);
  assert.ok(out.includes('src/very/long/where/path-3.cjs') && !out.includes('path-4.cjs'));
  assert.ok(out.includes('(2 more evidence entries not shown)'));
  const c = T.capNote(n);
  assert.strictEqual(c.evidence.length, 3); assert.strictEqual(c.evidence_not_shown, 2); assert.strictEqual(c.title, n.title);
});

test('belay-derived applies_to entries are not labelled writer-stated', () => {
  const out = lineOf(noteOf({ applies_to: ['src/a.cjs', 'src/b.cjs', 'src/c.cjs'], applies_to_from: ['worker', 'evidence', 'diff'] }));
  assert.ok(out.includes('writer-stated applies_to: src/a.cjs |'));
  assert.ok(out.includes('belay-derived applies_to (from the evidence or the diff, not stated by the writer): src/b.cjs; src/c.cjs'));
});
