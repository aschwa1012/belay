'use strict';
// report-marks.cjs — which of a note's `reported_wrong` entries still stand. A report the task reviewer or the note-review job REJECTED
// (a `rejected` entry in `report_judgments` or `report_rejected`, keyed by the reporter's task and the report's time) is not evidence any
// more: it opens no relate gate, names no pair for the scrubber, and is not shown to workers as "reported wrong". An unjudged report
// still stands (the scrubber's relation verdicts need no reviewer, ruling of 2026-10-15), and so does an upheld one. Pure, no store access.

const isRejected = (b, w) => !!(b && w) && [b.report_judgments, b.report_rejected].some((list) => Array.isArray(list)
  && list.some((j) => j && j.verdict === 'rejected' && j.task_id === w.task_id && j.report_at === w.at));

// The reports of the note's body that were not rejected.
const standing = (b) => ((b && b.reported_wrong) || []).filter((w) => w && !isRejected(b, w));

module.exports = { isRejected, standing };
