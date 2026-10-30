'use strict';
// check-history.cjs — what each task was checked by, and how that changed (ADR 0069). Pure: it reads a task row and derives
// everything from the row's own `amended` column (ADR 0061: what each amend replaced, oldest first, with when and by whom) and,
// for a fix task, from the task it repairs, so nothing is stored for it and no gate follows from it. Facts only; the
// orchestrator and the user judge.

const COMMAND_CLIP = 160;
const SLASHES = new RegExp(`[/${String.fromCharCode(92, 92)}]`); // both path separators (an escaped backslash), built without a backslash in the source

// One argument as a shell would need it: an argument with whitespace or a quote in it is quoted, after the `--flag=` when it has one.
function arg(a) {
  const s = String(a);
  if (s !== '' && !/[\s"']/.test(s)) return s;
  const m = /^(--?[\w-]+=)([\s\S]*)$/.exec(s);
  return m ? `${m[1]}"${m[2].replace(/"/g, '\\"')}"` : `"${s.replace(/"/g, '\\"')}"`;
}

// An acceptance as short lines, one per check: each command (its argv, with cwd and retries when set; a timeout is not shown), then
// the file, verdict and hand-back checks that have no command. The order the task gave is the order shown.
function lines(acceptance) {
  if (!acceptance || typeof acceptance !== 'object') return [];
  const out = [];
  for (const c of Array.isArray(acceptance.commands) ? acceptance.commands : []) {
    if (!c || !Array.isArray(c.argv)) continue;
    const base = c.argv.map((a, i) => (i === 0 ? String(a).split(SLASHES).pop() : arg(a))).join(' ');
    const extra = [c.cwd ? `cwd ${c.cwd}` : '', c.retries_on_fail ? `retries_on_fail ${c.retries_on_fail}` : ''].filter(Boolean).join(', ');
    const s = extra ? `${base} (${extra})` : base;
    out.push(s.length > COMMAND_CLIP ? `${s.slice(0, COMMAND_CLIP - 3)}...` : s);
  }
  if (acceptance.files_within_owned === true) out.push('files_within_owned');
  if (acceptance.verdict === true) out.push('verdict');
  const req = acceptance.handoff && Array.isArray(acceptance.handoff.required) ? acceptance.handoff.required : null;
  if (acceptance.handoff) out.push(req && req.length ? `handoff: ${req.join(', ')}` : 'handoff');
  return out;
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// -> { task_id, repairs?, checks: [line], changes: [{ at, from: [line], to: [line] }] }. `changes` has one entry for each amend that
// changed the checks, in order, `at` the time of the amend (ms); an amend that left them as they were (a new spec, the same
// commands, a different timeout) is no change. A fix task (`repairs`) whose first checks differ from those of the task it repairs
// (`repaired`, that task's row) starts with a change `{ repairs, from, to }` with no time: it was made so. `checks` is what the
// task is checked by now.
function historyOf(task, repaired = null) {
  const amended = Array.isArray(task && task.amended) ? task.amended : [];
  const changes = [];
  if (task.repairs && repaired && repaired.id === task.repairs) {
    const from = lines(repaired.acceptance), to = lines(amended.length ? amended[0].acceptance : task.acceptance);
    if (!same(from, to)) changes.push({ repairs: repaired.id, from, to });
  }
  amended.forEach((was, i) => {
    const from = lines(was.acceptance);
    const to = lines(i + 1 < amended.length ? amended[i + 1].acceptance : task.acceptance);
    if (!same(from, to)) changes.push({ at: was.at, from, to });
  });
  return { task_id: task.id, ...(task.repairs ? { repairs: task.repairs } : {}), checks: lines(task.acceptance), changes };
}

const list = (l) => (l.length ? l.join('; ') : 'none');

// How long into the run an amend came, by the wall clock from `since`, the run's start (ms), paused time included. A change that
// carries `after_ms` (a receipt) uses that. An amend before the start, or with no start or time known, is named by its instant.
function offset(ms) {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'under a minute in' : m < 120 ? `${m} min in` : `${(m / 60).toFixed(1)} h in`;
}
function when(c, since) {
  if (c.after_ms != null) return offset(c.after_ms);
  if (c.at == null) return 'at an unrecorded time';
  if (since == null || c.at < since) return `at ${new Date(Number(c.at)).toISOString()}`;
  return offset(c.at - since);
}

// One line for a task: "T28 checks: node --test -> node --test --test-skip-pattern="parallel writers" (amended 30 min in)".
// A task whose checks never changed gives its checks alone; one amended twice gives each step. A fix task whose checks differ from
// those of the task it repairs reads "T28-fix checks (repairs T28): <from> -> <to>".
function line(h, since = null) {
  const head = `${h.task_id} checks${h.repairs && h.changes.some((c) => c.repairs) ? ` (repairs ${h.repairs})` : ''}:`;
  if (!h.changes.length) return `${head} ${list(h.checks)}`;
  const steps = h.changes.map((c, i) => `${i === 0 ? `${list(c.from)} -> ` : 'then -> '}${list(c.to)}${c.repairs ? '' : ` (amended ${when(c, since)})`}`);
  return `${head} ${steps.join(', ')}`;
}

// A task's history for a receipt: each timed change also says how long into the run it came (`after_ms`), when it came after the start.
const forReceipt = (task, since, repaired = null) => {
  const h = historyOf(task, repaired);
  if (since == null) return h;
  return { ...h, changes: h.changes.map((c) => (c.at != null && c.at >= since ? { ...c, after_ms: c.at - since } : c)) };
};

module.exports = { lines, historyOf, forReceipt, line, when };
