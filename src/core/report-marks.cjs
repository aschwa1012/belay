'use strict';
// report-marks.cjs — which of a note's `reported_wrong` entries still stand, and which a reviewer UPHELD. A report the task reviewer or the
// note-review job REJECTED (a `rejected` entry in `report_judgments` or `report_rejected`, keyed by the reporter's task and the report's time)
// is not evidence any more: it opens no relate gate, names no pair for the scrubber, and is not shown to workers as "reported wrong". An
// unjudged report still stands for the index line and the scope, but it is only a worker's say-so: it does not open the relate gate or give
// the archive its direction (`upheld`, below). Pure, no store access.

const isRejected = (b, w) => !!(b && w) && [b.report_judgments, b.report_rejected].some((list) => Array.isArray(list)
  && list.some((j) => j && j.verdict === 'rejected' && j.task_id === w.task_id && j.report_at === w.at));

// The reports of the note's body that were not rejected.
const standing = (b) => ((b && b.reported_wrong) || []).filter((w) => w && !isRejected(b, w));

// A report a reviewer upheld (an `upheld` judgment for the reporter's task and the report's time). Only this much of a report is evidence
// enough to open the relate gate below the match threshold and to say which note of a pair goes.
const isUpheld = (b, w) => !!(b && w) && Array.isArray(b.report_judgments)
  && b.report_judgments.some((j) => j && j.verdict === 'upheld' && j.task_id === w.task_id && j.report_at === w.at);

const upheld = (b) => standing(b).filter((w) => isUpheld(b, w));

module.exports = { isRejected, isUpheld, standing, upheld };
