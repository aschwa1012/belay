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

// One fact line per task a verdict task depends on: belay's own acceptance result from that task's latest results, at the head
// they were judged on. A result marked stale (judged under an acceptance since amended) is not stated. A fact only.
// `getTask(id)` reads a task row; a task that cannot be read, or has no results, adds nothing.
const SHOWN = 3, NAME_MAX = 60;
const nameOf = (c) => (c.kind === 'command' && Array.isArray(c.argv) ? c.argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ') : String(c.kind || '')).slice(0, NAME_MAX);
async function facts(getTask, assigned) {
  const task = assigned && assigned.task;
  if (!isVerdict(task) || !Array.isArray(task.depends_on) || typeof getTask !== 'function') return '';
  const lines = [];
  const current = assigned.new_lease && assigned.new_lease.tree && assigned.new_lease.tree.head; // the reviewed tree's head when the lease was granted
  for (const id of task.depends_on) {
    let t = null;
    try { t = await getTask(id); } catch { t = null; }
    const r = t && t.results;
    if (!r || typeof r !== 'object' || r.stale || !Array.isArray(r.checks) || !r.checks.length || !r.head_sha) continue; // no head, no fact: it cannot be said what the result was judged at
    const names = r.checks.slice(0, SHOWN).map(nameOf).join('; ') + (r.checks.length > SHOWN ? `; and ${r.checks.length - SHOWN} more` : '');
    const judged = String(r.head_sha), now = current ? String(current) : '';
    const moved = now && !now.startsWith(judged) && !judged.startsWith(now) ? `; the tree is now at ${now.slice(0, 12)}` : ''; // the reviewer judges the tree as it is now
    lines.push(`belay's acceptance checks for ${id} ${r.passed === true ? 'passed' : 'did not pass'} at ${judged.slice(0, 12)}${moved} (${names}).`);
  }
  return lines.length ? `\n\n${lines.join('\n')}` : '';
}

// The rule for the task in this assign answer, or '' when there is no lease to name. A coder or fixer in the task's own belay
// worktree commits before it hands back (integrate merges a commit of what was judged); a reviewer never commits in the tree it
// judges, and hands back a verdict.
function rule(assigned, fact = '') {
  const lease = assigned && assigned.new_lease ? assigned.new_lease.id : null;
  if (!lease) return '';
  const task = assigned.task || {};
  if (isVerdict(task)) {
    return `\n\nWhen you are finished, call lease_release with lease_id ${lease} and result: { "verdict": "holds" | "refuted", "summary": "...", "findings": [...] }.${fact}\n\n${reviewStandard()}`;
  }
  const commits = !!(task.worktree && task.worktree.path && !task.worktree.removed_at);
  return `\n\nWhen you are finished, ${commits ? 'commit your work in your worktree, then ' : ''}call lease_release with lease_id ${lease} and a result object (branch, head, tests, findings).`;
}

module.exports = { rule, facts, reviewStandard, isVerdict, STANDARD_FILE };
