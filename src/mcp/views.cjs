'use strict';
// views.cjs — the compact default answers of the orchestrator's task tools (ADR 0058 amendment 3). Every byte of an answer is
// read into the orchestrator's context, and a task row carries its full spec, its acceptance, its worktree record with the
// junctions, and every check's output tails: about 2.9 KB a task once evaluated, so task_list grew by that for each task, on
// every call. The default keeps what the orchestrator acts on; `view: "debug"` returns the core's rows unchanged. Pure.

const SPEC_HEAD = 80;
const head = (s) => (typeof s !== 'string' ? s : s.length <= SPEC_HEAD ? s : `${s.slice(0, SPEC_HEAD - 3)}...`);

// One line per check, as the release wake names them: `command npm test exit 1`, `files_within_owned`, `verdict`; a check that
// timed out or is marked flaky says so, so neither fact is lost from a listing.
const timedOut = (c) => c.timed_out === true || !!(c.detail && c.detail.timed_out === true);
const label = (c) => `${c.kind === 'command' ? `command ${Array.isArray(c.argv) ? c.argv.slice(0, 3).join(' ') : '?'}${c.exit_code != null ? ` exit ${c.exit_code}` : ''}` : c.kind}${timedOut(c) ? ' timed out' : ''}${c.flaky ? ' flaky' : ''}${Array.isArray(c.concurrent) && c.concurrent.length ? ' concurrent' : ''}`;

// The fields of a check's detail that are receipts rather than reasons: where it ran, what was null, the full file lists.
// `cwd` is the worktree the answer already names; a null says nothing. A passing check also loses what only a failure needs:
// the output tails (their byte counts stay) and the full file lists (changed_count and outside stay).
const DETAIL_DROP = new Set(['cwd']);
const PASSED_DROP = new Set(['stdout_tail', 'stderr_tail', 'changed', 'files_owned']);

// A verdict check's detail without its receipts: which lease and when the hand-back came, who judged, what it depended on, the scratch
// folder's cap, and the tree record while the tree did not change (the prompt reads `tree.changed_paths` only when `tree_changed` is true).
// Every fact a finding rests on stays; a false or a 0 that means something stays too.
const VERDICT_RECEIPTS = new Set(['lease_id', 'handoff_at', 'judged_by', 'depends_on']);
function verdictDetail(detail) {
  const d = {};
  for (const [k, v] of Object.entries(detail)) {
    if (VERDICT_RECEIPTS.has(k) || v === null || v === undefined) continue; // an empty findings list is a fact (the check cut them, or there were none)
    if (k === 'tree' && detail.tree_changed !== true) continue;
    if (k === 'scratch' && v && typeof v === 'object' && !Array.isArray(v)) { const { limit_bytes, ...s } = v; d[k] = s; continue; }
    d[k] = v;
  }
  return d;
}

// A check: kind, passed, executable, the command's argv and exit code, and its detail less the drops above. A failing check's
// tails and lists stay, because they say why. A verdict or hand-back check keeps its detail whole: it is small, and the prompt
// reads it.
function compactCheck(c) {
  if (!c || typeof c !== 'object') return c;
  const { detail, ...rest } = c;
  if (c.kind === 'verdict') return detail && typeof detail === 'object' ? { ...rest, detail: verdictDetail(detail) } : c;
  if (!detail || typeof detail !== 'object' || c.kind === 'handoff') return c;
  const d = {};
  for (const [k, v] of Object.entries(detail)) {
    if (DETAIL_DROP.has(k) || v === null || v === undefined || (c.passed && PASSED_DROP.has(k))) continue;
    d[k] = v;
  }
  return { ...rest, detail: d };
}

const leaseOf = (l) => (l && typeof l === 'object' ? Object.fromEntries(Object.entries({ id: l.id, holder: l.holder, holder_role: l.holder_role, expires_at: l.expires_at, expired: l.expired }).filter(([, v]) => v !== undefined)) : l);
// `inherited_from` stays: it says a fix shares the tree of the work it fixes (task.fixFromReview), so its coder can be reused.
const worktreeOf = (w) => (w && typeof w === 'object' ? { path: w.path, branch: w.branch, ...(w.inherited_from ? { inherited_from: w.inherited_from } : {}), ...(w.removed_at ? { removed_at: w.removed_at } : {}) } : w);
const handoffFields = (h) => (h && typeof h === 'object' ? { by: h.by, at: h.at, fields: h.result && typeof h.result === 'object' ? Object.keys(h.result) : [] } : h);

// One task's detail gives a review's hand-back once, with the verdict beside its findings: the hand-back's result keeps
// {verdict, summary, findings}, and the verdict check of the same hand-back (its lease), which carries the summary and the
// findings verbatim, leaves each one that is equal out of its detail and names them in `in_handoff`. The tree record, which the
// prompt reads in the check, is left out of the hand-back and named in its `in_verdict_check`. Whatever differs (findings cut to
// the check's maximum) stays in both. Returns the hand-back and the checks as they are to be shown.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function handoffOnce(h, checks) {
  if (!h || typeof h !== 'object' || !h.result || typeof h.result !== 'object') return { handoff: h, checks };
  const at = checks.findIndex((c) => c && c.kind === 'verdict' && c.detail && c.detail.lease_id === h.lease_id);
  if (at < 0) return { handoff: h, checks };
  const v = checks[at];
  const dup = ['summary', 'findings'].filter((k) => k in h.result && same(h.result[k], v.detail[k]));
  const out = { ...h };
  const moved = [];
  // An unchanged tree is `tree_changed: false` and nothing more: the record is dropped from both (verdictDetail drops it from the check).
  for (const k of ['tree', 'scratch']) {
    if (!(k in out) || !same(out[k], v.detail[k])) continue;
    delete out[k];
    if (k !== 'tree' || v.detail.tree_changed === true) moved.push(k);
  }
  if (moved.length) out.in_verdict_check = moved;
  if (!dup.length) return { handoff: moved.length ? out : h, checks };
  const detail = { ...v.detail };
  for (const k of dup) delete detail[k];
  const shown = checks.slice();
  shown[at] = { ...v, detail: { ...detail, in_handoff: dup } };
  return { handoff: out, checks: shown };
}

// The row keys a compact answer drops or replaces. Anything else the core adds passes through, so a new field is never lost here.
const ROW_DROP = new Set(['acceptance', 'spec', 'results', 'handoff', 'lease', 'worktree']);
// A listing row also leaves out what the task's own detail carries: its files, who wrote it, the reason for a hold.
const SUMMARY_DROP = new Set(['run_id', 'written_at', 'written_by', 'files_owned', 'holds_reason']);

// A listing's results: the verdict facts (`flaky` and `timed_out` too, when the core sets them), the checks counted, the failing
// ones named, and the passing ones marked flaky named apart, since `failing` does not list them.
function summaryResults(facts, checks) {
  const out = { passed: facts.passed, executable: facts.executable };
  for (const k of ['trigger', 'flaky', 'timed_out', 'uncommitted', 'stale']) if (facts[k] !== undefined && facts[k] !== null) out[k] = facts[k];
  out.checks = checks.length;
  out.failing = checks.filter((c) => c && !c.passed).map(label);
  const flaky = checks.filter((c) => c && c.passed && c.flaky).map(label);
  if (flaky.length) out.flaky_checks = flaky;
  return out;
}

// A listing row leaves out what says nothing: a null, an empty list, and `holds_files: false`. An absent `lease`, `depends_on`,
// `repairs`, `answers`, `base`, `review` or `integration` is none; the task's own detail (task_ids) keeps every field.
const empty = (v) => v === null || v === undefined || (Array.isArray(v) && v.length === 0);
function lean(out) {
  for (const k of Object.keys(out)) if (empty(out[k]) || (k === 'holds_files' && out[k] === false)) delete out[k];
  if (out.results && typeof out.results === 'object' && empty(out.results.failing)) delete out.results.failing;
  return out;
}

// `detail`: the shape of one task the orchestrator is reading (task_evaluate's row, task_list with task_ids): the hand-back
// whole and every check. Otherwise the row of a listing: the hand-back's field names and the checks counted, failing named.
function compactTask(row, { detail = false } = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) if (!ROW_DROP.has(k) && (detail || !SUMMARY_DROP.has(k))) out[k] = v;
  // ADR 0060: `review` (where the work stands with its reviewers) is kept in both shapes; null, work no review names, is dropped.
  if (out.review === null) delete out.review;
  if (Array.isArray(row.amended)) { if (!detail) out.amended = row.amended.length; } else delete out.amended; // ADR 0061: a listing counts the revisions, detail has them; none, nothing
  out.spec_head = head(row.spec);
  if (row.lease !== undefined) out.lease = leaseOf(row.lease);
  if (detail) { if (row.worktree !== undefined) out.worktree = worktreeOf(row.worktree); } else if (row.worktree && row.worktree.branch) out.branch = row.worktree.branch;
  let allChecks = row.results && Array.isArray(row.results.checks) ? row.results.checks : [];
  if (row.handoff !== undefined) {
    if (detail) { const once = handoffOnce(row.handoff, allChecks); out.handoff = once.handoff; allChecks = once.checks; } else out.handoff = handoffFields(row.handoff);
  }
  const r = row.results;
  if (r && typeof r === 'object') {
    const checks = Array.isArray(r.checks) ? (detail ? allChecks : r.checks) : [];
    const { checks: _c, ...facts } = r;
    out.results = detail ? { ...facts, checks: checks.map(compactCheck) }
      : summaryResults(facts, checks);
  } else if (r !== undefined) out.results = r;
  if (detail) { for (const k of Object.keys(out)) if (empty(out[k])) delete out[k]; return out; } // a null or an empty list says nothing; a false or a 0 stays
  return lean(out);
}

// `task_ids` narrows a listing to those tasks; an id with no task (in the states asked for) is named in `not_found`.
function narrow(answer, ids, shape) {
  const want = new Set(ids);
  const tasks = answer.tasks.filter((t) => want.has(t.id));
  const found = new Set(tasks.map((t) => t.id));
  const missing = [...want].filter((id) => !found.has(id));
  return { ...answer, tasks: tasks.map(shape), ...(missing.length ? { not_found: missing } : {}) };
}

// task_list: summary rows; `task_ids` narrows the listing to those tasks and answers each in the detail shape.
function taskList(answer, { task_ids = null } = {}) {
  if (!answer || !Array.isArray(answer.tasks)) return answer;
  if (Array.isArray(task_ids) && task_ids.length) return narrow(answer, task_ids, (t) => compactTask(t, { detail: true }));
  return { ...answer, tasks: answer.tasks.map((t) => compactTask(t)) };
}

const taskEvaluate = (row) => compactTask(row, { detail: true });

// integrate: the merge's facts and the re-run checks; the repository path, the junctions and the base are the receipt.
const INTEGRATION_DROP = new Set(['repo', 'junctions', 'created_worktree', 'base_sha', 'written_at', 'written_by', 'run_id', 'owner_pid', 'owner_boot']);
function integrate(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) if (!INTEGRATION_DROP.has(k)) out[k] = v;
  if (Array.isArray(row.checks)) {
    out.checks = row.checks.map(({ cwd, ...c }) => {
      const k = {};
      for (const [f, v] of Object.entries(c)) if (!(c.passed && (f === 'stdout_tail' || f === 'stderr_tail')) && !(v === null && f === 'spawn_error')) k[f] = v;
      return k;
    });
  }
  return out;
}

// task_assign and task_cancel answer with the task beside the leases: the task is the summary row.
const withTask = (answer) => (answer && typeof answer === 'object' && answer.task && typeof answer.task === 'object' ? { ...answer, task: compactTask(answer.task) } : answer);

// task_assign: the task as task_list shows it, and the lease taken as a lease (id, holder, expiry), not the stored row.
const assignView = (answer) => {
  const out = withTask(answer);
  return out && typeof out === 'object' && out.new_lease && typeof out.new_lease === 'object' ? { ...out, new_lease: leaseOf(out.new_lease) } : out;
};

// status: a store with no note held says so by saying nothing (notes_held is 20 keys of zero otherwise).
function statusView(answer) {
  const h = answer && typeof answer === 'object' ? answer.notes_held : null;
  if (!h || typeof h !== 'object' || h.total > 0 || h.malformed > 0) return answer;
  const { notes_held, ...rest } = answer;
  return rest;
}

// task_create: the new task's id, rev, state and spec head. The row's other columns are the caller's own arguments (spec,
// acceptance, files, dependencies) or empty on a new task, so they are left out; anything else the core adds to the answer (a
// `warning` for a task with no checks, `overlaps` for a file held by a task in another tree) stays.
const CREATED_DROP = new Set(['spec', 'acceptance', 'files_owned', 'depends_on', 'repairs', 'answers', 'results', 'handoff', 'worktree', 'run_id', 'written_at', 'written_by']);
function created(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = { id: row.id, seq: row.seq, state: row.state, spec_head: head(row.spec) };
  for (const [k, v] of Object.entries(row)) if (!(k in out) && !CREATED_DROP.has(k) && !(k === 'amended' && v == null)) out[k] = v; // an amend's answer names what it replaced
  return out;
}

// fix_from_review: the task as task_create answers it, plus what belay inferred for it (the task it repairs, what it waits for, the
// files it owns), since the orchestrator did not write those. The spec, acceptance and tree records are the findings' and the base's own.
function fixCreated(row) {
  const out = created(row);
  if (out && row && typeof row === 'object') for (const k of ['repairs', 'depends_on', 'files_owned']) if (!empty(row[k])) out[k] = row[k];
  return out;
}

// task_worktree: the task as task_create answers it, its tree (path, branch, base, any junction skipped) and a removal's receipt.
function taskWorktree(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const w = row.worktree && typeof row.worktree === 'object' ? row.worktree : null;
  const tree = w ? { ...worktreeOf(w), base_sha: w.base_sha, ...(Array.isArray(w.junctions_skipped) && w.junctions_skipped.length ? { junctions_skipped: w.junctions_skipped } : {}) } : w;
  return { ...created(row), worktree: tree, ...(row.removal !== undefined ? { removal: row.removal } : {}) };
}

// git_read: belay's fixed argv is a receipt, not an answer; the output and its facts stay.
const gitRead = (r) => {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return r;
  const { argv, ...rest } = r;
  return rest;
};

// The tools whose default answer is a view, and how. `view` and `task_ids` are the adapter's, never the core's: they are taken
// off the arguments here, checked, and the call runs without them.
// memory_report: the hold it made or joined, the hold's state, and what happened to the note (withheld or not, and why). The core's answer also
// carries the hold row and the note row whole, about 4 KB; view debug returns it unchanged.
function memoryReport(a) {
  if (!a || typeof a !== 'object') return a;
  const h = a.held && typeof a.held === 'object' ? a.held : null;
  const holdState = h && h.body && typeof h.body === 'object' ? h.body.state : undefined;
  return {
    id: a.id, state: a.state, ...(a.reason ? { reason: a.reason } : {}),
    ...(a.hold ? { hold: { ...a.hold, ...(holdState ? { state: holdState } : {}) } } : {}),
    withheld: a.withheld, withheld_why: a.withheld_why, report: a.report ? { seq: a.report.seq } : undefined, reports: a.reports,
    ...(a.breaker ? { breaker: a.breaker } : {}), ...(a.redacted ? { redacted: a.redacted } : {}),
  };
}

// lease_release (the worker's answer): the worker has just sent its own hand-back, so the row repeats what it wrote, with the spec,
// the tree and scratch records and the reason a memory id was or was not recorded. What it acts on: the task's state, the lease
// it released, the notes written, any pending note it must settle (whole, with its matches and the `next` line), what the core
// recorded of its memory ids, and any warning. A second call that only adds notes answers the same way.
function leaseRelease(row, args) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const notes = Array.isArray(row.notes) ? row.notes : null;
  const out = { id: row.id, state: row.state, lease_id: (args && args.lease_id) || (row.handoff && row.handoff.lease_id) || null };
  if (notes) {
    out.notes_written = notes.filter((n) => n && n.state === 'stored').length;
    const pending = notes.filter((n) => n && n.state === 'pending');
    if (pending.length) { out.pending = row.pending !== undefined ? row.pending : pending.length; out.pending_notes = pending; }
    if (row.next !== undefined) out.next = row.next;
  }
  if (row.memory_ids && typeof row.memory_ids === 'object') out.memory_ids = { recorded: row.memory_ids.recorded };
  if (row.handoff && Array.isArray(row.handoff.memory_ids_missing) && row.handoff.memory_ids_missing.length) out.memory_ids_missing = row.handoff.memory_ids_missing;
  for (const k of ['warning', 'notes_dropped', 'lease_released_by', 'note']) if (row[k] !== undefined && row[k] !== null) out[k] = row[k];
  return out;
}

const VIEWED = { task_list: taskList, task_evaluate: taskEvaluate, integrate, task_assign: assignView, task_cancel: withTask, task_create: created, fix_from_review: fixCreated, status: statusView, task_worktree: taskWorktree, git_read: gitRead, memory_report: memoryReport };
const isViewed = (name) => typeof name === 'string' && Object.prototype.hasOwnProperty.call(VIEWED, name);
const bad = (message, detail) => Object.assign(new Error(message), { code: 'E_ARGS', detail });

async function viewed(name, args, run) {
  const shape = isViewed(name) ? VIEWED[name] : null;
  if (!shape || !args || typeof args !== 'object' || Array.isArray(args)) return run(args);
  const { view, ...rest } = args;
  if (view !== undefined && view !== null && view !== 'debug') throw bad(`${name}: view must be debug, or absent for the compact answer`, { tool: name, field: 'view', expected: ['debug'] });
  let ids = null;
  if (name === 'task_list') {
    ids = rest.task_ids;
    delete rest.task_ids;
    if (ids !== undefined && ids !== null && (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string'))) throw bad('task_list: task_ids must be an array of task ids', { tool: name, field: 'task_ids', expected: 'array' });
  }
  const answer = await run(rest);
  if (view === 'debug') {
    if (!Array.isArray(ids) || !ids.length || !answer || !Array.isArray(answer.tasks)) return answer;
    return narrow(answer, ids, (t) => t);
  }
  return name === 'task_list' ? taskList(answer, { task_ids: ids }) : shape(answer);
}

module.exports = { compactTask, compactCheck, taskList, taskEvaluate, integrate, withTask, memoryReport, leaseRelease, viewed, isViewed, VIEWED, SPEC_HEAD };
