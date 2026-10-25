'use strict';
// views.cjs — the compact default answers of the orchestrator's task tools (ADR 0058 amendment 1). Every byte of an answer is
// read into the orchestrator's context, and a task row carries its full spec, its acceptance, its worktree record with the
// junctions, and every check's output tails: about 2.9 KB a task once evaluated, so task_list grew by that for each task, on
// every call. The default keeps what the orchestrator acts on; `view: "debug"` returns the core's rows unchanged. Pure.

const SPEC_HEAD = 80;
const head = (s) => (typeof s !== 'string' ? s : s.length <= SPEC_HEAD ? s : `${s.slice(0, SPEC_HEAD - 3)}...`);

// One line per check, as the release wake names them: `command npm test exit 1`, `files_within_owned`, `verdict`; a check that
// timed out or is marked flaky says so, so neither fact is lost from a listing.
const timedOut = (c) => c.timed_out === true || !!(c.detail && c.detail.timed_out === true);
const label = (c) => `${c.kind === 'command' ? `command ${Array.isArray(c.argv) ? c.argv.slice(0, 3).join(' ') : '?'}${c.exit_code != null ? ` exit ${c.exit_code}` : ''}` : c.kind}${timedOut(c) ? ' timed out' : ''}${c.flaky ? ' flaky' : ''}`;

// The fields of a check's detail that are receipts rather than reasons: where it ran, what was null, the full file lists.
// `cwd` is the worktree the answer already names; a null says nothing. A passing check also loses what only a failure needs:
// the output tails (their byte counts stay) and the full file lists (changed_count and outside stay).
const DETAIL_DROP = new Set(['cwd']);
const PASSED_DROP = new Set(['stdout_tail', 'stderr_tail', 'changed', 'files_owned']);

// A check: kind, passed, executable, the command's argv and exit code, and its detail less the drops above. A failing check's
// tails and lists stay, because they say why. A verdict or hand-back check keeps its detail whole: it is small, and the prompt
// reads it.
function compactCheck(c) {
  if (!c || typeof c !== 'object') return c;
  const { detail, ...rest } = c;
  if (!detail || typeof detail !== 'object' || c.kind === 'verdict' || c.kind === 'handoff') return c;
  const d = {};
  for (const [k, v] of Object.entries(detail)) {
    if (DETAIL_DROP.has(k) || v === null || v === undefined || (c.passed && PASSED_DROP.has(k))) continue;
    d[k] = v;
  }
  return { ...rest, detail: d };
}

const leaseOf = (l) => (l && typeof l === 'object' ? { id: l.id, holder: l.holder, holder_role: l.holder_role, expires_at: l.expires_at, expired: l.expired } : l);
// `inherited_from` stays: it says a fix shares the tree of the work it fixes (task.fixFromReview), so its coder can be reused.
const worktreeOf = (w) => (w && typeof w === 'object' ? { path: w.path, branch: w.branch, ...(w.inherited_from ? { inherited_from: w.inherited_from } : {}), ...(w.removed_at ? { removed_at: w.removed_at } : {}) } : w);
const handoffFields = (h) => (h && typeof h === 'object' ? { by: h.by, at: h.at, fields: h.result && typeof h.result === 'object' ? Object.keys(h.result) : [] } : h);

// The row keys a compact answer drops or replaces. Anything else the core adds passes through, so a new field is never lost here.
const ROW_DROP = new Set(['acceptance', 'spec', 'results', 'handoff', 'lease', 'worktree']);
// A listing row also leaves out what the task's own detail carries: its files, who wrote it, the reason for a hold.
const SUMMARY_DROP = new Set(['run_id', 'written_at', 'written_by', 'files_owned', 'holds_reason']);

// A listing's results: the verdict facts (`flaky` and `timed_out` too, when the core sets them), the checks counted, the failing
// ones named, and the passing ones marked flaky named apart, since `failing` does not list them.
function summaryResults(facts, checks) {
  const out = { passed: facts.passed, executable: facts.executable };
  for (const k of ['trigger', 'flaky', 'timed_out']) if (facts[k] !== undefined && facts[k] !== null) out[k] = facts[k];
  out.checks = checks.length;
  out.failing = checks.filter((c) => c && !c.passed).map(label);
  const flaky = checks.filter((c) => c && c.passed && c.flaky).map(label);
  if (flaky.length) out.flaky_checks = flaky;
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
  out.spec_head = head(row.spec);
  if (row.lease !== undefined) out.lease = leaseOf(row.lease);
  if (detail) { if (row.worktree !== undefined) out.worktree = worktreeOf(row.worktree); } else if (row.worktree && row.worktree.branch) out.branch = row.worktree.branch;
  if (row.handoff !== undefined) out.handoff = detail ? row.handoff : handoffFields(row.handoff);
  const r = row.results;
  if (r && typeof r === 'object') {
    const checks = Array.isArray(r.checks) ? r.checks : [];
    const { checks: _c, ...facts } = r;
    out.results = detail ? { ...facts, checks: checks.map(compactCheck) }
      : summaryResults(facts, checks);
  } else if (r !== undefined) out.results = r;
  return out;
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

// The tools whose default answer is a view, and how. `view` and `task_ids` are the adapter's, never the core's: they are taken
// off the arguments here, checked, and the call runs without them.
const VIEWED = { task_list: taskList, task_evaluate: taskEvaluate, integrate, task_assign: withTask, task_cancel: withTask };
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

module.exports = { compactTask, compactCheck, taskList, taskEvaluate, integrate, withTask, viewed, isViewed, VIEWED, SPEC_HEAD };
