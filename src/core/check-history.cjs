'use strict';
// check-history.cjs — what each task was checked by, and how that changed (ADR 0069). Pure: it reads a task row and derives
// everything from the row's own `amended` column (ADR 0061: what each amend replaced, oldest first, with when and by whom), so
// nothing is stored for it and no gate follows from it. Facts only; the orchestrator and the user judge.

const COMMAND_CLIP = 160;

// One argument as a shell would need it: an argument with whitespace or a quote in it is quoted, after the `--flag=` when it has one.
function arg(a) {
  const s = String(a);
  if (s !== '' && !/[\s"']/.test(s)) return s;
  const m = /^(--?[\w-]+=)([\s\S]*)$/.exec(s);
  return m ? `${m[1]}"${m[2].replace(/"/g, '\\"')}"` : `"${s.replace(/"/g, '\\"')}"`;
}

// An acceptance as short lines, one per check: each command (its argv, with cwd and retries when set), then the file, verdict and
// hand-back checks that have no command. Sorted by nothing: the order the task gave is the order shown.
function lines(acceptance) {
  if (!acceptance || typeof acceptance !== 'object') return [];
  const out = [];
  for (const c of Array.isArray(acceptance.commands) ? acceptance.commands : []) {
    if (!c || !Array.isArray(c.argv)) continue;
    const base = c.argv.map((a, i) => (i === 0 ? String(a).split(/[\/]/).pop() : arg(a))).join(' ');
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

// -> { task_id, checks: [line], changes: [{ at, from: [line], to: [line] }] }. `changes` has one entry for each amend that changed
// the checks, in order, `at` the time of the amend (ms); an amend that left them as they were (a new spec, the same commands)
// is no change. `checks` is what the task is checked by now.
function historyOf(task) {
  const amended = Array.isArray(task && task.amended) ? task.amended : [];
  const changes = [];
  amended.forEach((was, i) => {
    const from = lines(was.acceptance);
    const to = lines(i + 1 < amended.length ? amended[i + 1].acceptance : task.acceptance);
    if (!same(from, to)) changes.push({ at: was.at, from, to });
  });
  return { task_id: task.id, checks: lines(task.acceptance), changes };
}

const list = (l) => (l.length ? l.join('; ') : 'none');

// How long into the run an amend came: `since` is the run's start (ms). A change that carries `after_ms` (a receipt) uses that.
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
// A task whose checks never changed gives its checks alone; one amended twice gives each step.
function line(h, since = null) {
  if (!h.changes.length) return `${h.task_id} checks: ${list(h.checks)}`;
  const steps = h.changes.map((c, i) => `${i === 0 ? `${list(c.from)} -> ` : 'then -> '}${list(c.to)} (amended ${when(c, since)})`);
  return `${h.task_id} checks: ${steps.join(', ')}`;
}

// A task's history for a receipt: each change also says how long into the run it came (`after_ms`), when the start is known.
const forReceipt = (task, since) => { const h = historyOf(task); return since == null ? h : { ...h, changes: h.changes.map((c) => ({ ...c, after_ms: Math.max(0, c.at - since) })) }; };

module.exports = { lines, historyOf, forReceipt, line, when };
