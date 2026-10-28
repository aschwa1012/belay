'use strict';
// note-review.cjs — the run manager's side of a note's review. Notes are judged one by one by a reviewer other than the writer,
// and belay applies the verdicts (core: memory.noteVerdicts, which checks every cited quote against the evidence the task
// recorded). One route: a task with a reviewer. The review task's brief gains the notes to judge (reviewTail); when the review
// task ends, its hand-back's `memory_verdicts` and `report_verdicts` are applied (applyHandback). The short review job that once
// judged a task's notes when it had no reviewer was removed: a report that a note is wrong holds the note for the archive review.
// A failure is a receipt, never silence: a review task whose verdicts could not be applied writes a `review_job` receipt.

const path = require('node:path');
const T = require('./note-review-text.cjs');
const { shownHash } = require('../core/note-shown.cjs');

const ENDED = new Set(['released', 'done', 'cancelled']); // cancelled: ADR 0058, task.cancel
const isJob = (id) => require('./job-prefixes.cjs').isJobId(String(id)); // any of belay's read-only jobs: no preface, no contract
const codeOf = (e) => (e && typeof e.code === 'string' && e.code.startsWith('E_') ? e.code : 'E_INTERNAL');
const fwd = (p) => String(p).replace(/\\/g, '/');
const isReview = (t) => !!(t && t.acceptance && t.acceptance.verdict === true);

const STATE = new WeakMap();
function stateOf(ctx) {
  let s = STATE.get(ctx);
  if (!s) { s = { pending: new Map(), applied: new Set() }; STATE.set(ctx, s); }
  return s;
}

// The store as the run-end sweep may use it: every call checks the run-end gate first, so a sweep that a fast close cut off sends
// nothing more (a write begun after the owner's shutdown would elect a stray one, invariant 2). A refusal is E_TIMEOUT, as in
// memory-jobs call().
function gated(J) {
  return require('./gated-core.cjs').gatedCore(J.core, J.gate, 'the run-end note jobs');
}

async function receipt(core, fields) {
  try { return await core.memory.recordEvent({ kind: 'review_job', ...fields }); } catch { return null; }
}
const fail = (core, fields, e) => receipt(core, { ok: false, code: codeOf(e), message: String((e && e.message) || e).slice(0, 300), ...fields });
const briefNotes = (notes) => notes.map((n) => ({ id: n.id, hash: shownHash(n) }));

// ---- the reviewer's brief ----------------------------------------------------------------------------------------
// Appended to a review task's opening message. '' unless the notes switch is on and there is something to say.
async function reviewTail(ctx, w) {
  const lv = ctx.memoryLevers;
  if (!lv || !lv.notes || !w || !w.taskId || isJob(w.id)) return '';
  let brief;
  try { brief = await ctx.core.memory.reviewBrief({ task_id: w.taskId }); } catch (e) { w.lastError = { where: 'memory.reviewBrief', code: codeOf(e), message: e && e.message }; return ''; }
  if (!brief.review) return '';
  // The notes the tail will list are fixed now, with the text each had, so the verdicts are checked against what was shown (the core never recomputes it).
  // A brief that lists none is a capture too (an empty one): this attempt's reviewer was shown no note, whatever an earlier attempt was shown.
  try { await ctx.core.memory.noteBriefCapture({ review_task_id: w.taskId, notes: briefNotes(T.listedNotes(brief)) }); } catch (e) { w.lastError = { where: 'memory.noteBriefCapture', code: codeOf(e), message: e && e.message }; return ''; }
  if (!brief.notes.length && !brief.refuted_shown.length && !(brief.reports || []).length) return '';
  let streams = [];
  try {
    const list = ((await ctx.core.worker.list({})).workers || []).filter((x) => x.run_id === ctx.runId && brief.reviewed_tasks.includes(x.task_id));
    streams = list.map((x) => ({ worker_id: x.id, task_id: x.task_id, stream_path: fwd(path.join(ctx.dataDir, 'workers', x.id, 'stream.jsonl')) }));
  } catch { streams = []; }
  return `\n\n${T.reviewerTail(brief, streams)}`.replace(/\n+$/, '\n');
}

// ---- applying ---------------------------------------------------------------------------------------------------
// A review task's hand-back: its verdicts, once per task per manager (the store makes a second application a no-op).
async function applyHandback(J, task) {
  const { core, s } = { core: gated(J), s: stateOf(J.ctx) };
  const once = `${task.id}@${task.handoff && task.handoff.at}`; // a reassigned review task hands back again
  if (s.applied.has(once)) return null;
  s.applied.add(once);
  try { return await core.memory.noteVerdicts({ review_task_id: task.id }); } catch (e) {
    // Past this flag the owner is going or gone: a receipt now would elect a new one in this process (invariant 2). The hand-back stays on the review
    // task's row, and the store-only sweep applies it (a failure there is its own receipt).
    if (J.ctx.shutdownFlags && J.ctx.shutdownFlags.ownerGone) return null;
    await fail(core, { key: `route:${task.id}`, task_id: task.id, message: `the verdicts of review ${task.id} were not applied: ${e && e.message}` }, e);
    return null;
  }
}

// A task has ended. Only a review task has anything to do: its hand-back's verdicts are applied. Not awaited by the caller.
// The returned promise is registered in s.pending SYNCHRONOUSLY, before any await, so the adapter's shutdown drain sees an
// application that has been decided on but has not yet read the task list.
function onTaskEnded(J, task) {
  const { ctx, lv } = J;
  if (!lv.notes || !task || !ENDED.has(task.state) || !isReview(task)) return Promise.resolve();
  // Once the close has begun (the second drain is done or under way), no new application starts from a turn: it would never be drained. Nothing is marked
  // applied, so the hand-back stays eligible for the store-only sweep (the adapter's run-end sweep, then belay run's).
  if (ctx.shutdownFlags && (ctx.shutdownFlags.closing || ctx.shutdownFlags.closed)) return Promise.resolve();
  const s = stateOf(ctx);
  const key = `apply:${task.id}`;
  if (s.pending.has(key)) return Promise.resolve();
  const p = applyHandback(J, task).then(() => {}, () => {});
  s.pending.set(key, p);
  p.then(() => { (s.done = s.done || new Set()).add(key); });
  return p;
}

// The adapter's shutdown waits for verdict applications it started, up to `ms` in all: the wait takes `ms` less a reserve, and the receipt that names
// a cut-off takes the reserve, so the shared deadline holds even when the store is slow. Returns { pending, receipt }: the review task ids whose application
// had not finished (never swallowed: the shutdown result carries them) and what became of the receipt ('written', or { error }); never throws.
async function drainVerdicts(ctx, ms) {
  const out = { pending: [], receipt: null };
  const s = STATE.get(ctx);
  if (!s || !s.pending.size) return out;
  const reserve = Math.min(2000, Math.floor(ms / 4));
  let timer;
  const deadline = new Promise((r) => { timer = setTimeout(() => r(false), Math.max(0, ms - reserve)); });
  // An application registered while the others finish (a review that ended during the close) is waited for too, until none is new.
  for (;;) {
    const known = s.pending.size;
    const all = await Promise.race([Promise.allSettled([...s.pending.values()]).then(() => true), deadline]);
    if (!all || s.pending.size === known) break;
  }
  clearTimeout(timer);
  // A cut-off is never silent: the applications still running when the deadline passed are named on a receipt. They are not lost: the hand-back is
  // on the review task's row, and the store-only sweep (the adapter's run-end sweep, then `belay run`'s reviewSweep) applies it.
  const left = [...s.pending.keys()].filter((k) => !(s.done && s.done.has(k)));
  out.pending = left.map((k) => k.replace(/^apply:/, ''));
  if (left.length) {
    if (!(ctx.core && ctx.core.memory && typeof ctx.core.memory.recordEvent === 'function')) { out.receipt = { error: 'no way to write the receipt' }; return out; }
    let rt;
    const bound = new Promise((r) => { rt = setTimeout(() => r({ error: `the receipt was not written within ${reserve} ms` }), Math.max(1, reserve)); });
    const write = Promise.resolve().then(() => ctx.core.memory.recordEvent({ kind: 'review_job', ok: false, code: 'E_TIMEOUT', run_id: ctx.runId, key: `drain:${ctx.runId}`, message: `the verdict drain gave up after ${ms} ms with ${left.length} application(s) still running (${out.pending.slice(0, 8).join(', ')}); the review sweep applies them from the review tasks' hand-backs` })).then(() => 'written', (e) => ({ error: String((e && e.message) || e).slice(0, 200) }));
    out.receipt = await Promise.race([write, bound]);
    clearTimeout(rt);
  }
  return out;
}

// The run's end, store-only (also runs in `belay run`, which holds no manager): apply the hand-back of every ended review task.
// Idempotent: the store makes a second application a no-op.
async function sweep(J, tasks) {
  const { lv } = J;
  if (!lv.notes) return;
  for (const t of tasks) if (isReview(t) && ENDED.has(t.state)) await applyHandback(J, t);
}

// The sweep alone, store-only, before the run-close stages (`belay run` hands it to them). A report that a review upheld is applied before
// the scrub can archive its note; applied after, it is refused ("not live in this run's project"). The run-end sweep runs again after
// run.end and does the rest. Returns null with notes off.
async function reviewSweep({ core, runId, levers, gate = null }) {
  const lv = levers;
  if (!lv || !lv.notes) return null;
  const J = { ctx: { core, runId, memoryLevers: lv }, core, lv, w: null, gate: gate || { aborted: false }, s: {}, turnPath: false };
  const g = gated(J);
  const tasks = ((await g.task.list({})) || {}).tasks || [];
  await sweep(J, tasks);
  return { swept: true, tasks: tasks.length };
}

module.exports = { reviewTail, onTaskEnded, applyHandback, sweep, reviewSweep, drainVerdicts, isJob, ENDED };
