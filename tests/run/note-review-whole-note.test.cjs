'use strict';
// The review job's prompt has one rule about values, and the brief shows each note whole (as data, nothing cut).
const test = require('node:test');
const assert = require('node:assert');
const T = require('../../src/run/note-review-text.cjs');

test('the job prompt has the one value rule and neither of the two lines it replaced', () => {
  const p = T.jobPrompt(T.jobTemplate(), { notesFile: 'n.json', diffFile: 'd.diff', streams: [], taskId: 't1' });
  assert.match(p, /a wrong path or value anywhere in the note makes it refuted/);
  assert.ok(!p.includes('Judge the claim the note makes'));
  assert.ok(!p.includes("do not trust a note's own wording about what it saw"));
  assert.match(p, /"unsupported" means no single place proves or disproves the note/);
});

test('the reviewer\'s brief carries every field of a note, uncut', () => {
  const long = 'x'.repeat(480);
  const note = {
    id: 'm-1', kind: 'lesson', basis: 'observed', task_id: 't1', written_by: 'worker:w1', title: 'mailbox lookup is case-insensitive in the domain', when: 'editing the mailbox lookup',
    text: 'mailbox lookup is case-insensitive in the domain editing the mailbox lookup mailbox',
    evidence: [{ where: 'run', saw: `data/postwell/mailboxes.json lists mb_1021 ${long}` }, { where: 'second', saw: 'test/mailbox.test.cjs line 40' }],
    applies_to: ['data/postwell/mailboxes.json', 'src/mailbox.cjs'], subjects: ['mailbox', 'postwell'],
  };
  const out = T.reviewerTail({ notes: [note], refuted_shown: [] }, []);
  for (const piece of ['writer-stated: mailbox lookup is case-insensitive in the domain', 'writer-stated situation (when): editing the mailbox lookup', 'writer-stated text: mailbox lookup is case-insensitive in the domain editing the mailbox lookup mailbox',
    `data/postwell/mailboxes.json lists mb_1021 ${long}`, 'second: test/mailbox.test.cjs line 40', 'writer-stated applies_to: data/postwell/mailboxes.json; src/mailbox.cjs', 'writer-stated subjects: mailbox; postwell', '[lesson/observed]']) {
    assert.ok(out.includes(piece), piece);
  }
  assert.ok(!out.split('\n').find((l) => l.startsWith('- m-1')).includes('...'), 'nothing is cut');
});
