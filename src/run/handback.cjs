'use strict';
// handback.cjs — what belay itself ends a worker's task message with: the hand-back rule (the lease id and the shape of the
// `lease_release` result) and, for a verdict task, the Review standard. The orchestrator no longer writes either into its
// prompts. One module for the spawn's first message and for `task_assign`, so the two cannot say different things.
// `assigned` is the core's `task.assign` answer: { task, new_lease }. Pure but for reading the standard once.

const fs = require('node:fs');
const path = require('node:path');

const STANDARD_FILE = path.join(__dirname, 'prompts', 'review-standard.md');
let standard = null;

// The Review standard section, from its one source file (CRLF in a checkout is read as LF).
function reviewStandard() {
  if (standard === null) standard = fs.readFileSync(STANDARD_FILE, 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return standard;
}

const isVerdict = (task) => !!(task && task.acceptance && task.acceptance.verdict === true);

// The rule for the task in this assign answer, or '' when there is no lease to name. A coder or fixer in the task's own belay
// worktree commits before it hands back (integrate merges a commit of what was judged); a reviewer never commits in the tree it
// judges, and hands back a verdict.
function rule(assigned) {
  const lease = assigned && assigned.new_lease ? assigned.new_lease.id : null;
  if (!lease) return '';
  const task = assigned.task || {};
  if (isVerdict(task)) {
    return `\n\nWhen you are finished, call lease_release with lease_id ${lease} and result: { "verdict": "holds" | "refuted", "summary": "...", "findings": [...] }.\n\n${reviewStandard()}`;
  }
  const commits = !!(task.worktree && task.worktree.path && !task.worktree.removed_at);
  return `\n\nWhen you are finished, ${commits ? 'commit your work in your worktree, then ' : ''}call lease_release with lease_id ${lease} and a result object (branch, head, tests, findings).`;
}

module.exports = { rule, reviewStandard, isVerdict, STANDARD_FILE };
