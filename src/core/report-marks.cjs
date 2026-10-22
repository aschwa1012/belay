'use strict';
// report-marks.cjs — which of a note's `reported_wrong` entries still stand. A report has one identity, its key (`reportKey`): `s:<seq>` for a
// report made with a sequence number (the note's `report_seq` counter, set when the report is written), and `l:<task>@<at>@<by>` for a report
// made before the counter existed. Every judgment, verdict, settlement and receipt names the key, so a report is addressed the same way
// wherever it is read, and a legacy report needs no write to be addressable.
//
// A report is SETTLED when its key is in the note's `reports_settled`: written only by the archive review's cited release and the operator's
// settle. The set is pruned only together with the report it names (`pruneSettled`), so nothing settled is forgotten while its report exists,
// whatever else (the bounded `report_judgments`) is trimmed. A settled report no longer stands, warns or counts as upheld.
//
// A report the task reviewer REJECTED (a `rejected` entry in `report_judgments` or `report_rejected`) is advice only: it opens no relate gate,
// names no pair for the scrubber and is not shown to workers as "reported wrong", but it does not release the note and the archive review
// still decides. Pure, no store access.

const reportKey = (w) => (w && Number.isInteger(w.seq) && w.seq > 0 ? `s:${w.seq}` : `l:${w && w.task_id}@${w && w.at}@${w && w.by}`);

// Whether a judgment entry (`report_judgments` / `report_rejected`) is about this report: by key when it has one, else (written before keys) by the
// reporter's task and the report's time.
const sameReport = (j, w) => !!(j && w) && (j.report_key !== undefined && j.report_key !== null ? j.report_key === reportKey(w) : (j.task_id === w.task_id && j.report_at === w.at));

const isRejected = (b, w) => !!(b && w) && [b.report_judgments, b.report_rejected].some((list) => Array.isArray(list)
  && list.some((j) => j && j.verdict === 'rejected' && sameReport(j, w)));

const isSettled = (b, w) => !!(b && w) && Array.isArray(b.reports_settled) && b.reports_settled.includes(reportKey(w));

// The reports of the note's body that are not settled (a rejected one is still unsettled: a rejection is advice).
const unsettled = (b) => ((b && b.reported_wrong) || []).filter((w) => w && !isSettled(b, w));

// The reports that stand: not settled and not rejected.
const standing = (b) => unsettled(b).filter((w) => !isRejected(b, w));

// A report a reviewer upheld, and not settled since. Only this much of a report is evidence enough to open the relate gate below the match
// threshold and to say which note of a pair goes.
const isUpheld = (b, w) => !!(b && w) && !isSettled(b, w) && Array.isArray(b.report_judgments)
  && b.report_judgments.some((j) => j && j.verdict === 'upheld' && sameReport(j, w));

const upheld = (b) => standing(b).filter((w) => isUpheld(b, w));

// Drops from `reports_settled` every key whose report is no longer on the note, so it never holds more than the note's reports. Mutates and returns b.
function pruneSettled(b) {
  if (!b || !Array.isArray(b.reports_settled)) return b;
  const live = new Set((b.reported_wrong || []).map(reportKey));
  b.reports_settled = b.reports_settled.filter((k) => live.has(k));
  if (!b.reports_settled.length) delete b.reports_settled;
  return b;
}

module.exports = { reportKey, sameReport, isRejected, isSettled, isUpheld, standing, unsettled, upheld, pruneSettled };
