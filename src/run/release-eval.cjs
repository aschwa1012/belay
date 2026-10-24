'use strict';
// release-eval.cjs — ADR 0058 decision 5: a worker that released its task with a hand-back has the task evaluated by the run
// manager as its turn ends, before the turn's row is written, so the wake that row causes can carry the result and the
// orchestrator need not remember to call task_evaluate. The evaluation is the core's task.evaluate, unchanged, in the
// worker's own worktree with the default base, and marked `trigger: 'release'` in its results. It never refuses or delays
// anything but the turn's own row: a failure is recorded on the worker and reported as an error entry.
//
// `enrichWakes` is the wake side: for each turn_end wake it reads the tasks once and attaches what the release evaluation
// found, as facts (task, state, which checks failed), never the worker's words (ADR 0015 section 2). The rendered clause
// is cut so the whole wake stays under the 400-byte hook budget (invariant 9).

const CLAUSE_MAX = 160; // bytes of the evaluation clause a wake carries

const failedKinds = (row) => ((row.results && row.results.checks) || []).filter((c) => !c.passed)
  .map((c) => (c.kind === 'command' ? `command ${Array.isArray(c.argv) ? c.argv.slice(0, 3).join(' ') : '?'}${c.exit_code != null ? ` exit ${c.exit_code}` : ''}` : c.kind));

function summaryOf(row) {
  const r = row.results || {};
  return { task_id: row.id, state: row.state, passed: !!r.passed, executable: !!r.executable, checks: ((r.checks) || []).length, failing: failedKinds(row) };
}

// The tasks this worker released with a hand-back in this run that no evaluation has read since. Returns the summaries, or null.
async function afterRelease(w, ctx) {
  w.turnEvaluated = null;
  const core = ctx.core;
  if ((ctx.shutdownFlags && ctx.shutdownFlags.closed) || !core || !core.task || typeof core.task.evaluate !== 'function' || typeof core.task.list !== 'function') return null;
  let tasks;
  try { tasks = ((await core.task.list({ states: ['released'] })) || {}).tasks || []; } catch (e) {
    w.lastError = { where: 'release-eval.list', code: e && e.code, message: e && e.message };
    return null;
  }
  const mine = tasks.filter((t) => t.run_id === ctx.runId && t.handoff && t.handoff.by === w.id
    && !(t.results && Number(t.results.evaluated_at) >= Number(t.handoff.at)));
  if (!mine.length) return null;
  const out = [];
  for (const t of mine) {
    try { out.push(summaryOf(await core.task.evaluate({ task_id: t.id, worktree: w.worktree, trigger: 'release' }))); } catch (e) {
      out.push({ task_id: t.id, error: (e && e.code) || 'E_INTERNAL', message: String((e && e.message) || e).slice(0, 200) });
    }
  }
  w.turnEvaluated = out;
  return out;
}

const cut = (s, max) => (Buffer.byteLength(s, 'utf8') <= max ? s : `${Buffer.from(s, 'utf8').subarray(0, max - 3).toString('utf8').replace(/�$/, '')}...`);

// One clause for a wake: "Task T evaluated at release: passed, done." or "...: not done; failing: command npm test exit 1."
function clause(evs) {
  const parts = evs.map((e) => (e.error ? `task ${e.task_id} could not be evaluated at release (${e.error})`
    : `task ${e.task_id} evaluated at release: ${e.state === 'done' ? 'passed, done' : `not done; failing: ${e.failing.join(', ') || 'no executable check'}`}`));
  return cut(` ${parts.join('; ')}.`, CLAUSE_MAX);
}

// For each turn_end wake, the release evaluations of that worker's tasks that are newer than any reported before.
// `seen` (a Map task_id -> evaluated_at) is the caller's, carried across polls. Reads the tasks only when there is a turn_end.
async function enrichWakes(core, runId, events, seen) {
  if (!events.some((e) => e.event === 'turn_end')) return events;
  let tasks;
  try { tasks = ((await core.task.list({})) || {}).tasks || []; } catch { return events; }
  for (const ev of events) {
    if (ev.event !== 'turn_end') continue;
    const evs = tasks.filter((t) => t.run_id === runId && t.handoff && t.handoff.by === ev.worker_id && t.results && t.results.trigger === 'release'
      && seen.get(t.id) !== t.results.evaluated_at).map((t) => { seen.set(t.id, t.results.evaluated_at); return summaryOf(t); });
    if (evs.length) ev.evaluated = evs;
  }
  return events;
}

module.exports = { afterRelease, enrichWakes, clause, summaryOf, CLAUSE_MAX };
