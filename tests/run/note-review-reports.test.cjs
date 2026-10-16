'use strict';
// The text side of judging "wrong" reports: the reviewer's brief and the review job's prompt carry the reports, the job's answer may hold
// report_verdicts, and the brief stays small enough for the 4096 byte hand-back. Pure text; no store, no process.

const { test } = require('node:test');
const assert = require('node:assert');
const T = require('../../src/run/note-review-text.cjs');
const { heldEvents, unjudgedEvents } = require('../../src/cli/cmd-notices.cjs');
const { heldText } = require('../../src/cli/panel-common.cjs');

const report = (i) => ({
  note: { id: `n-${i}`, title: `note ${i} says the loader skips fixtures`, kind: 'lesson', basis: 'observed', task_id: 't-w', written_by: 'worker:w-a', status: 'unverified', evidence: [{ where: 'src/a.js', saw: 'never read' }] },
  report: { task_id: 't-b', by: 'worker:w-b', why: 'x'.repeat(400), replaced_by: null, at: 1 },
  head_sha: 'abcdef0123456789abcdef0123456789abcdef01',
});
const noteRow = (i) => ({ id: `m-${i}`, title: `a note ${i}`, task_id: 't-b', written_by: 'worker:w-c', kind: 'lesson', basis: 'observed', evidence: [] });

test('the reviewer\'s brief lists reports with the reporter\'s words marked as stated, the head sha and the report_verdicts shape', () => {
  const text = T.reviewerTail({ notes: [], refuted_shown: [], reports: [report(1)] }, [{ worker_id: 'w-b', task_id: 't-b', stream_path: 'C:/d/workers/w-b/stream.jsonl' }]);
  assert.match(text, /REPORTS TO JUDGE/);
  assert.match(text, /reporter-stated: x+/);
  assert.match(text, /head abcdef012345/);
  assert.match(text, /"report_verdicts": \[\{ "id"/);
  assert.match(text, /A cite is \{ where, quote \}/, 'with no notes to judge the cite rules are given here');
  assert.match(text, /workers' streams/);
  assert.match(text, /You may not judge a report about a note you wrote/);
});

test('with notes and reports together the note list gives way, and the brief stays small', () => {
  const text = T.reviewerTail({ notes: Array.from({ length: 12 }, (_, i) => noteRow(i)), refuted_shown: [], reports: Array.from({ length: 6 }, (_, i) => report(i)) }, []);
  assert.strictEqual((text.match(/^- note n-/gm) || []).length, 4, 'four reports shown');
  assert.strictEqual((text.match(/^- m-/gm) || []).length, 4, 'four notes shown beside them');
  assert.match(text, /2 more reports are not listed/);
  assert.match(text, /8 more notes are not listed/);
  assert.ok(Buffer.byteLength(text) < 6000);
  assert.strictEqual(T.reviewerTail({ notes: Array.from({ length: 12 }, (_, i) => noteRow(i)), refuted_shown: [] }, []).match(/^- m-/gm).length, 8, 'without reports the note list is as before');
});

test('the review job\'s prompt gains the reports, and its answer may hold report_verdicts', () => {
  const tpl = 'job {{task_id}} {{notes_file}} {{diff_file}} {{streams}} {{verdict_shape}} {{cite_rules}}';
  const plain = T.jobPrompt(tpl, { notesFile: 'n', diffFile: 'd', streams: [], taskId: 't-b' });
  const withReports = T.jobPrompt(tpl, { notesFile: 'n', diffFile: 'd', streams: [], taskId: 't-b', reports: [report(1)] });
  assert.ok(!plain.includes('REPORTS TO JUDGE'));
  assert.ok(withReports.startsWith(plain) && withReports.includes('REPORTS TO JUDGE') && withReports.includes('"report_verdicts"'));
  const both = JSON.stringify({ memory_verdicts: [], report_verdicts: [{ id: 'n-1', verdict: 'rejected', cites: [], reason: 'r' }] });
  assert.deepStrictEqual(T.parseJobOutput(both), { verdicts: [], report_verdicts: [{ id: 'n-1', verdict: 'rejected', cites: [], reason: 'r' }] });
  assert.deepStrictEqual(T.parseJobOutput('{"report_verdicts": []}'), { verdicts: [], report_verdicts: [] });
  assert.deepStrictEqual(T.parseJobOutput('{"memory_verdicts": []}'), { verdicts: [] }, 'an answer without reports is as before');
  assert.ok(T.parseJobOutput('{"x": 1}').error);
});

test('the held notice is modelled on notes_unembedded: count, by_project, oldest_age_runs; none while nothing is held', () => {
  assert.deepStrictEqual(heldEvents({ total: 0 }, 'r1'), []);
  const [e] = heldEvents({ total: 3, by_project: { acme: 3 }, oldest_age_runs: 2, newest_at: 99 }, 'r1');
  assert.deepStrictEqual([e.kind, e.ts, e.run_id, e.count, e.by_project, e.oldest_age_runs, e.command], ['notes_held', 99, 'r1', 3, { acme: 3 }, 2, 'belay memory review']);
  assert.strictEqual(heldText({ total: 3, by_project: { acme: 3 }, oldest_age_runs: 2 }), '3 notes held for review, oldest 2 runs: review with belay memory review --project acme');
  const [u] = unjudgedEvents([{ id: 'n-1', at: 5 }, { id: 'n-2', at: 7 }], null);
  assert.deepStrictEqual([u.kind, u.count, u.ts, u.note_ids], ['reports_unjudged', 2, 7, ['n-1', 'n-2']]);
  assert.deepStrictEqual(unjudgedEvents([], null), []);
});
