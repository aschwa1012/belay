'use strict';
// report-marks.test.cjs — one identity and one settlement for a report. Pure: no store.

const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../../src/core/report-marks.cjs');

const legacy = (over = {}) => ({ by: 'worker:w2', worker_id: 'w2', task_id: 'tx-1', run_id: 'r', why: 'wrong', replaced_by: null, at: 11, ...over });
const fresh = (seq, over = {}) => legacy({ seq, ...over });

test('a report has one key: s:<seq> when it has a sequence number, l:<task>@<at>@<by> when it does not', () => {
  assert.strictEqual(M.reportKey(fresh(3)), 's:3');
  assert.strictEqual(M.reportKey(legacy()), 'l:tx-1@11@worker:w2');
  assert.notStrictEqual(M.reportKey(legacy()), M.reportKey(legacy({ by: 'worker:w3' })), 'two legacy reports of one task and time differ by writer');
});

test('a judgment names its report by key, or, written before keys, by the reporter task and the report time', () => {
  const w = fresh(2);
  assert.strictEqual(M.sameReport({ report_key: 's:2' }, w), true);
  assert.strictEqual(M.sameReport({ report_key: 's:3' }, w), false);
  assert.strictEqual(M.sameReport({ task_id: 'tx-1', report_at: 11 }, w), true);
  assert.strictEqual(M.sameReport({ task_id: 'tx-1', report_at: 12 }, w), false);
});

test('standing drops a rejected report and a settled one; unsettled keeps the rejected one (a rejection is advice)', () => {
  const a = fresh(1), b = fresh(2, { task_id: 'tx-2' }), c = legacy({ task_id: 'tx-3', at: 30 });
  const body = { reported_wrong: [a, b, c], report_judgments: [{ verdict: 'rejected', report_key: 's:2' }], reports_settled: [M.reportKey(c)] };
  assert.deepStrictEqual(M.standing(body).map(M.reportKey), ['s:1']);
  assert.deepStrictEqual(M.unsettled(body).map(M.reportKey), ['s:1', 's:2']);
  assert.strictEqual(M.isSettled(body, c), true);
});

test('an upheld judgment of a settled report no longer counts as upheld; an unsettled one does', () => {
  const w = fresh(1);
  const body = { reported_wrong: [w], report_judgments: [{ verdict: 'upheld', report_key: 's:1' }] };
  assert.strictEqual(M.isUpheld(body, w), true);
  assert.deepStrictEqual(M.upheld(body), [w]);
  body.reports_settled = ['s:1'];
  assert.strictEqual(M.isUpheld(body, w), false);
  assert.deepStrictEqual(M.upheld(body), []);
});

test('settlement does not depend on the bounded judgment list: 25 later judgments leave the settled report settled', () => {
  const w = fresh(1);
  const body = { reported_wrong: [w], reports_settled: ['s:1'], report_judgments: Array.from({ length: 25 }, (_, i) => ({ verdict: 'upheld', report_key: `s:${100 + i}` })) };
  assert.strictEqual(M.isSettled(body, w), true);
  assert.deepStrictEqual(M.standing(body), []);
});

test('pruneSettled keeps only the keys of reports still on the note, and drops the field when none is left', () => {
  const body = { reported_wrong: [fresh(2), fresh(3)], reports_settled: ['s:1', 's:2', 's:3'] };
  assert.deepStrictEqual(M.pruneSettled(body).reports_settled, ['s:2', 's:3']);
  body.reported_wrong = [];
  assert.strictEqual(M.pruneSettled(body).reports_settled, undefined);
  assert.deepStrictEqual(M.pruneSettled({}), {});
});

test('a report made after a settlement has a new key, so it stands again', () => {
  const old = fresh(1), later = fresh(2);
  const body = { reported_wrong: [old, later], reports_settled: ['s:1'] };
  assert.deepStrictEqual(M.standing(body).map(M.reportKey), ['s:2']);
});
