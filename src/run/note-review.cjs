'use strict';
// note-review.cjs — wave 4: the run manager's side of a note's review. Notes are judged one by one by a reviewer other than
// the writer, and belay applies the verdicts (core: memory.noteVerdicts, which checks every cited quote against the evidence the
// task recorded). Two routes, one apply:
//   a task with a reviewer   the review task's brief gains the notes to judge (reviewTail); when the review task ends, its
//                            hand-back's `memory_verdicts` are applied (applyHandback)
//   a task without one       when it ends having written notes, with `memory.note_review` on, the run manager starts one short
//                            read-only job: a worker belay spawns (invariant 1) with Read, Glob and Grep, given the notes, the diff
//                            and the stream path. It only confirms or refutes, with cites. Its model and cost cap are levers.
// The job's last message is its answer; the run manager parses it and applies it. The worker's stream is the durable copy, so a
// job that finished while the run was closing is applied from its stream by the run's own store-only end (`sweep`), and a note
// that was never reviewed is left as it was with a `review_job` receipt that says why. A failure is a receipt, never silence.
// The job never gets the notes contract, the memory index or any belay tool: its adapter lists none.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const T = require('./note-review-text.cjs');
const { shownHash } = require('../core/note-shown.cjs');

const JOB_PREFIX = 'notereview-';
const JOB_WALL_MS = 180000;
const DIFF_MAX = 200 * 1024;
const BUILTINS = ['Read', 'Glob', 'Grep'];
const ENDED = new Set(['released', 'done']);
const isJob = (id) => require('./job-prefixes.cjs').isJobId(String(id)); // any of belay's read-only jobs: no preface, no contract
const jobIdFor = (taskId) => `${JOB_PREFIX}${taskId}`;
const taskOfJob = (workerId) => (String(workerId).startsWith(JOB_PREFIX) ? String(workerId).slice(JOB_PREFIX.length) : null);
const codeOf = (e) => (e && typeof e.code === 'string' && e.code.startsWith('E_') ? e.code : 'E_INTERNAL');
const fwd = (p) => String(p).replace(/\\/g, '/');
const isReview = (t) => !!(t && t.acceptance && t.acceptance.verdict === true);

const STATE = new WeakMap();
function stateOf(ctx) {
  let s = STATE.get(ctx);
  if (!s) { s = { jobs: new Map(), applied: new Set() }; STATE.set(ctx, s); }
  return s;
}

// The store as the run-end sweep may use it: every call checks the run-end gate first, so a sweep that a fast close cut off sends
// nothing more (a write begun after the owner's shutdown would elect a stray one, invariant 2). A refusal is E_TIMEOUT, as in
// memory-jobs call().
function gated(J) {
  return require('./gated-core.cjs').gatedCore(J.core, J.gate, 'the run-end memory jobs');
}

async function receipt(core, fields) {
  try { return await core.memory.recordEvent({ kind: 'review_job', ...fields }); } catch { return null; }
}
const fail = (core, fields, e) => receipt(core, { ok: false, code: codeOf(e), message: String((e && e.message) || e).slice(0, 300), ...fields });
// Past this flag the owner is going or gone and a write would elect a new one in this process (invariant 2): the run's own
// store-only sweep names what was never reviewed instead.
const ownerGone = (ctx) => !!(ctx.shutdownFlags && ctx.shutdownFlags.ownerGone);
const isClosed = (ctx) => !!(ctx.manager && ((typeof ctx.manager._closed === 'function' && ctx.manager._closed()) || (typeof ctx.manager._closing === 'function' && ctx.manager._closing())));
const shutErr = (msg) => Object.assign(new Error(msg), { code: 'E_SHUTDOWN' });
// Stop a job's worker; if the stop threw (it writes a row, and rows are refused once the run is closed) the child is killed by its
// exact handle and pid (ADR 0039), never matched by a command line.
async function stopJob(ctx, wid) {
  const m = ctx.manager;
  await Promise.resolve().then(() => m.stop({ worker_id: wid })).catch(() => {});
  if (typeof m._killSurvivor === 'function') await Promise.resolve().then(() => m._killSurvivor(wid)).catch(() => {});
}

const briefNotes = (notes) => notes.map((n) => ({ id: n.id, hash: shownHash(n) }));

// ---- the reviewer's brief ----------------------------------------------------------------------------------------
// Appended to a review task's opening message. '' unless the notes switch is on and there is something to say.
async function reviewTail(ctx, w) {
  const lv = ctx.memoryLevers;
  if (!lv || !lv.notes || !w || !w.taskId || String(w.id).startsWith(JOB_PREFIX)) return '';
  let brief;
  try { brief = await ctx.core.memory.reviewBrief({ task_id: w.taskId }); } catch (e) { w.lastError = { where: 'memory.reviewBrief', code: codeOf(e), message: e && e.message }; return ''; }
  if (!brief.review || (!brief.notes.length && !brief.refuted_shown.length && !(brief.reports || []).length)) return '';
  // The notes the tail will list are fixed now, with the text each had, so the verdicts are checked against what was shown (the core never recomputes it).
  if (brief.notes.length) {
    try { await ctx.core.memory.noteBriefCapture({ review_task_id: w.taskId, notes: briefNotes(T.listedNotes(brief)) }); } catch (e) { w.lastError = { where: 'memory.noteBriefCapture', code: codeOf(e), message: e && e.message }; return ''; }
  }
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
    await fail(core, { key: `route:${task.id}`, task_id: task.id, message: `the verdicts of review ${task.id} were not applied: ${e && e.message}` }, e);
    return null;
  }
}

function lastTextOf(streamFile) {
  let lines;
  try { lines = fs.readFileSync(streamFile, 'utf8').split('\n'); } catch { return ''; }
  let assistant = '', result = '';
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'result' && typeof j.result === 'string') result = j.result;
    else if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      const t = j.message.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
      if (t) assistant = t;
    }
  }
  return result || assistant;
}

// Parse and apply a job's answer. `text` is its last message. Returns the receipt row.
async function finishJob(core, { workerId, taskId, text, cost, cap }) {
  const base = { worker_id: workerId, task_id: taskId, key: `task:${taskId}` };
  if (!(typeof cost === 'number' && cost > 0)) return fail(core, base, Object.assign(new Error('the review job recorded no cost, so its cap cannot be checked; its verdicts were not used and the notes stay unreviewed'), { code: 'E_COST_CAP' }));
  if (cost > cap) return fail(core, base, Object.assign(new Error(`the review job cost $${cost.toFixed(4)}, over its cap of $${cap}; its verdicts were not used and the notes stay unreviewed`), { code: 'E_COST_CAP' }));
  const p = T.parseJobOutput(text);
  if (p.error) return fail(core, base, Object.assign(new Error(p.error), { code: 'E_ARGS' }));
  let out;
  try { out = await core.memory.noteVerdicts({ job: { worker_id: workerId, reviewed_task_id: taskId }, verdicts: p.verdicts, ...(p.report_verdicts ? { report_verdicts: p.report_verdicts } : {}) }); } catch (e) { return fail(core, base, e); }
  const ids = out.applied.map((a) => a.id);
  const rv = out.report_verdicts;
  const rids = rv ? rv.applied.map((a) => a.id) : [];
  // ok only when the job left nothing behind: a note or report it refused, or gave no verdict, is still unreviewed, and a receipt that says ok
  // would read as a review done. The notes stay as they were (a later review offers them again) and the receipt names them.
  const left = [...out.refused_open || [], ...out.unjudged || [], ...(rv ? [...rv.refused_open || [], ...rv.unjudged || []] : [])];
  const partial = left.length > 0;
  return receipt(core, { ok: !partial, ...(partial ? { code: 'E_PARTIAL' } : {}), ...base, row_ids: ids.length || rids.length ? [...ids, ...rids] : undefined, message: `${partial ? `partly reviewed; left unreviewed: ${left.slice(0, 8).join(', ') || 'none named'}${left.length > 8 ? `, and ${left.length - 8} more` : ''}; ` : ''}applied ${out.applied.length}, refused ${out.refused.length}, already ${out.already.length}, unjudged ${out.unjudged.length}, refused_open ${(out.refused_open || []).length}${rv && !rv.none ? `; reports applied ${rv.applied.length}, refused ${rv.refused.length}, unjudged ${rv.unjudged.length}, refused_open ${(rv.refused_open || []).length}` : ''}${typeof cost === 'number' ? `; cost $${cost.toFixed(4)}` : ''}` });
}

// ---- the job ----------------------------------------------------------------------------------------------------
function gitDiff(worktree, base, head) {
  return new Promise((resolve) => {
    execFile('git', ['-C', worktree, 'diff', '--no-color', base, head], { maxBuffer: 16 * 1024 * 1024, timeout: 15000, windowsHide: true, encoding: 'utf8' }, (e, out) => resolve(e ? { error: e.killed ? 'git diff timed out' : 'git diff failed' } : { text: out }));
  });
}

async function writeInputs(ctx, taskId, wid, notes, workers) {
  const dir = path.join(ctx.dataDir, 'workers', wid, 'inputs');
  fs.mkdirSync(dir, { recursive: true });
  const notesFile = fwd(path.join(dir, 'notes.json'));
  fs.writeFileSync(notesFile, `${JSON.stringify(notes, null, 2)}\n`);
  const w = workers.find((x) => x.base_sha && x.head_sha && x.worktree);
  let text;
  if (!w) text = '(no worker of this task has a base and head commit recorded, so there is no diff; judge from the streams)\n';
  else {
    const d = await gitDiff(w.worktree, w.base_sha, w.head_sha);
    text = d.error ? `(${d.error} for ${w.base_sha.slice(0, 12)}..${w.head_sha.slice(0, 12)})\n` : d.text.length > DIFF_MAX ? `${d.text.slice(0, DIFF_MAX)}\n(diff cut at ${DIFF_MAX} bytes)\n` : d.text || '(the task changed no file)\n';
  }
  const diffFile = fwd(path.join(dir, 'diff.patch'));
  fs.writeFileSync(diffFile, text);
  return { notesFile, diffFile, worktree: (w && w.worktree) || null };
}

// The job's wait. One wait is capped by MCP_TOOL_TIMEOUT (the answer says so, as timeout_capped), so it is asked again until the job's own wall
// is spent, as stage-job.cjs does. `waited_ms` is the wall really used, for the receipt.
async function waitJob(manager, wid, wallMs, now = Date.now) {
  const t0 = now();
  let got, first = true;
  for (;;) {
    got = await manager.wait({ worker_ids: [wid], timeout_ms: first ? wallMs : Math.max(1, wallMs - (now() - t0)) });
    first = false;
    if (!(got.timed_out && got.timeout_capped && now() - t0 < wallMs)) break;
  }
  return { got, waited_ms: now() - t0 };
}

// One job for one ended task. Never throws; every outcome is a receipt.
async function runJob(J, task) {
  const { ctx, core, lv } = J;
  const taskId = task.id, wid = jobIdFor(taskId);
  const base = { worker_id: wid, task_id: taskId, key: `task:${taskId}` };
  try {
    const prior = await core.memory.events({ run_id: ctx.runId || undefined, task_id: taskId, kinds: ['review_job'] });
    if (((prior && prior.events) || []).some((e) => (e.ok === 1 || e.ok === true) && e.key === base.key)) return;
    const brief = await core.memory.reviewBrief({ reviewed_task_id: taskId });
    if (!brief.notes.length && !(brief.reports || []).length) return; // nothing unreviewed and no report to judge: nothing to spend on
    if (isClosed(ctx)) throw shutErr('the run manager is shutting down, so no review job was started');
    if (!ctx.manager || typeof ctx.manager.spawn !== 'function') throw Object.assign(new Error('the run manager has no way to spawn the review job here'), { code: 'E_INTERNAL' });
    const workers = ((await core.worker.list({})).workers || []).filter((x) => x.run_id === ctx.runId && x.task_id === taskId);
    // The job reads its notes from a file, so it is shown every field of every note (no cap): the core allows `confirmed` for what a reviewer saw whole.
    const inputs = await writeInputs(ctx, taskId, wid, brief.reports && brief.reports.length ? { notes: brief.notes, reports: brief.reports } : brief.notes, workers);
    const streams = workers.map((x) => ({ worker_id: x.id, stream_path: fwd(path.join(ctx.dataDir, 'workers', x.id, 'stream.jsonl')) }));
    await core.memory.noteBriefCapture({ job: { worker_id: wid, reviewed_task_id: taskId }, notes: briefNotes(brief.notes) }); // what the job's notes file holds, fixed before it starts
    const prompt = T.jobPrompt(T.jobTemplate(), { notesFile: inputs.notesFile, diffFile: inputs.diffFile, streams, taskId, reports: brief.reports || [] });
    const worktree = inputs.worktree || ctx.worktree || (workers.find((x) => x.worktree) || {}).worktree;
    if (!worktree) throw Object.assign(new Error('no worktree is known for the task, so the review job has nowhere to run'), { code: 'E_ARGS' });
    const cap = lv.note_review_cost_cap_usd;
    if (isClosed(ctx)) throw shutErr('the run manager is shutting down, so no review job was started'); // after the git diff and the worker list, immediately before the launch
    await ctx.manager.spawn({ substrate: 'claude-code', worktree, worker_id: wid, model: lv.note_review_model, allowed_tools: BUILTINS, tools: BUILTINS, max_budget_usd: cap, prompt });
    if (isClosed(ctx)) { // the run closed while the child was starting: the shutdown loop never saw it, so it is stopped here
      await stopJob(ctx, wid);
      throw shutErr('the run manager shut down while the review job was starting; the job was stopped and its notes stay unreviewed');
    }
    let text = '', cost = null, settled = null;
    try {
      const { got, waited_ms } = await waitJob(ctx.manager, wid, JOB_WALL_MS);
      const rec = ctx.manager._worker(wid);
      if (got.timed_out) settled = Object.assign(new Error(`the review job did not finish: it waited ${waited_ms} ms of a ${JOB_WALL_MS} ms wall`), { code: 'E_TIMEOUT' });
      else if (got.event !== 'turn_end' || got.is_error) settled = Object.assign(new Error(`the review job ${got.event === 'turn_end' ? 'ended its turn in error' : `is ${got.event}`}`), { code: 'E_WORKER_NOT_LIVE' });
      text = rec && typeof rec.lastAssistantText === 'string' ? rec.lastAssistantText : '';
      cost = rec && typeof rec.costUsd === 'number' ? rec.costUsd : null;
    } finally { await stopJob(ctx, wid); }
    if (ownerGone(ctx)) return; // the owner is going: a write now would elect another; the run's sweep names the task
    if (settled) await fail(core, base, settled); else await finishJob(core, { workerId: wid, taskId, text, cost, cap });
  } catch (e) { if (!ownerGone(ctx)) await fail(core, base, e); }
}

// A task has ended. Reviewer route for a review task, the job for any other task that wrote notes. Not awaited by the caller.
// The returned promise is registered in s.jobs SYNCHRONOUSLY, before any await, so the adapter's shutdown drain sees a job that has
// been decided on but has not yet listed tasks or spawned. Every refusal that leaves notes unreviewed is a receipt.
function onTaskEnded(J, task) {
  const { ctx, lv } = J;
  if (!lv.notes || !task || !ENDED.has(task.state)) return Promise.resolve();
  const review = isReview(task);
  if (!review && !lv.note_review) return Promise.resolve();
  const s = stateOf(ctx);
  const key = review ? `apply:${task.id}` : task.id;
  if (s.jobs.has(key)) return Promise.resolve();
  const base = { worker_id: jobIdFor(task.id), task_id: task.id, key: `task:${task.id}` };
  const p = (async () => {
    try {
      if (review) { await applyHandback(J, task); return; }
      if (isClosed(ctx)) throw shutErr('the run manager is shutting down, so no review was started');
      const all = ((await J.core.task.list({})).tasks) || [];
      if (all.some((t) => isReview(t) && Array.isArray(t.depends_on) && t.depends_on.includes(task.id))) return; // it has a reviewer
      await runJob(J, task);
    } catch (e) { if (!review && !ownerGone(ctx)) await fail(J.core, base, e); }
  })();
  s.jobs.set(key, p);
  return p;
}

// True when this run's levers can start a review job: the close then awaits the turns' memory queues before the job drain.
const expectsJobs = (ctx) => !!(ctx.memoryLevers && ctx.memoryLevers.notes && ctx.memoryLevers.note_review);

// The adapter's shutdown waits for jobs it started, up to `ms`.
async function drain(ctx, ms) {
  const s = STATE.get(ctx);
  if (!s || !s.jobs.size) return;
  let timer;
  const deadline = new Promise((r) => { timer = setTimeout(() => r(false), ms); });
  // A job registered while the others finish (a turn that ended during the close) is waited for too, until none is new.
  for (;;) {
    const known = s.jobs.size;
    const all = await Promise.race([Promise.allSettled([...s.jobs.values()]).then(() => true), deadline]);
    if (!all || s.jobs.size === known) break;
  }
  clearTimeout(timer);
}

// A job row whose process no longer answers a pid check. A reused pid only makes a closed job look alive, which leaves it to the run-end sweep.
const processClosed = (w) => Number.isInteger(w.pid) && !require('../core/lock.cjs').pidAlive(w.pid);

// The run's end, store-only (also runs in `belay run`, which holds no manager): apply the hand-back of every ended review task,
// apply the answer of every review job that finished but was not applied, and name what was never reviewed. Idempotent.
// `opts.preClose` is the sweep that runs before the run-close stages, while a killed job's row can still read idle or running: it applies
// what is finished (a review task's hand-back, a job whose worker is stopped or dead, or whose process has closed with a whole answer in its stream) and writes no receipt of any kind, because a receipt
// would stop the run-end sweep, which runs after run.end has settled the rows, from applying that job's answer.
async function sweep(J, tasks, workers, opts = {}) {
  const { lv, ctx } = J;
  const core = gated(J);
  if (!lv.notes) return;
  for (const t of tasks) if (isReview(t) && ENDED.has(t.state)) await applyHandback(J, t);
  const jobWorkers = workers.filter((w) => String(w.id).startsWith(JOB_PREFIX) && w.run_id === ctx.runId);
  const events = ((await core.memory.events({ run_id: ctx.runId || undefined, kinds: ['review_job'] })) || {}).events || [];
  const done = (taskId) => events.some((e) => e.key === `task:${taskId}`); // a receipt of any kind: a job the live path refused is not applied here from its last draft
  for (const w of jobWorkers) {
    const taskId = taskOfJob(w.id);
    if (!taskId || done(taskId)) continue;
    if (!['stopped', 'dead'].includes(w.state)) { // still starting or running: it has no answer to apply, and a missing cost is not a cost-cap failure
      // A job whose process has closed but whose row still reads idle (run.end settles the row, after the scrub and archive stages have run)
      // is finished all the same. Its answer is applied now when the stream holds a whole one and the row a cost, so an upheld report is not
      // left unapplied for a note the scrub archives; anything less stays for the run-end sweep, with no receipt.
      if (opts.preClose && processClosed(w) && typeof w.cost_usd === 'number') {
        const got0 = await core.worker.get({ worker_id: w.id }).catch(() => null);
        const text0 = got0 && got0.stream_path ? lastTextOf(got0.stream_path) : '';
        if (!T.parseJobOutput(text0).error) await finishJob(core, { workerId: w.id, taskId, text: text0, cost: w.cost_usd, cap: lv.note_review_cost_cap_usd });
      }
      if (!opts.preClose) await fail(core, { worker_id: w.id, task_id: taskId, key: `task:${taskId}` }, shutErr(`the run ended while the review job was ${w.state}; its notes stay unreviewed`));
      continue;
    }
    const got = await core.worker.get({ worker_id: w.id }).catch(() => null);
    const text = got && got.stream_path ? lastTextOf(got.stream_path) : '';
    await finishJob(core, { workerId: w.id, taskId, text, cost: typeof w.cost_usd === 'number' ? w.cost_usd : null, cap: lv.note_review_cost_cap_usd });
  }
  if (opts.preClose || !lv.note_review) return;
  const started = new Set(jobWorkers.map((w) => taskOfJob(w.id)));
  for (const t of tasks) {
    if (isReview(t) || !ENDED.has(t.state) || started.has(t.id) || events.some((e) => e.key === `task:${t.id}`)) continue; // a receipt of any kind is the record
    if (tasks.some((r) => isReview(r) && Array.isArray(r.depends_on) && r.depends_on.includes(t.id))) continue;
    let brief;
    try { brief = await core.memory.reviewBrief({ reviewed_task_id: t.id }); } catch { continue; }
    if (!brief.notes.length && !(brief.reports || []).length) continue;
    await fail(core, { worker_id: undefined, task_id: t.id, key: `task:${t.id}`, row_ids: brief.notes.map((n) => n.id), message: `task ${t.id} wrote ${brief.notes.length} note(s) and the run ended before a review job ran; they stay unreviewed` }, Object.assign(new Error('owed'), { code: 'E_TIMEOUT' }));
  }
  // A job decides once per task, when the task first ends. A note written after a clean job (the reflection turn, a second attempt) is still
  // unreviewed, and the job's receipt does not say so, so such a task is named once here. A job that failed is not named again: its own receipt
  // (its code says why) is the record. A partial job's receipt names the notes it left, so only a note it does not name is added.
  for (const t of tasks) {
    const own = events.filter((e) => e.key === `task:${t.id}`);
    if (isReview(t) || !ENDED.has(t.state) || !own.length || events.some((e) => e.key === `left:${t.id}`)) continue;
    const clean = own.some((e) => e.ok === 1 || e.ok === true);
    const partial = own.filter((e) => e.code === 'E_PARTIAL');
    if (!clean && !partial.length) continue;
    if (tasks.some((r) => isReview(r) && Array.isArray(r.depends_on) && r.depends_on.includes(t.id))) continue;
    let brief;
    try { brief = await core.memory.reviewBrief({ reviewed_task_id: t.id }); } catch { continue; }
    const named = partial.map((e) => String(e.message || '')).join(' ');
    const ids = brief.notes.map((n) => n.id).filter((id) => clean || !named.includes(id));
    if (!ids.length) continue;
    const why = clean ? 'written after its review job' : 'not named by its review job\'s partial receipt';
    await fail(core, { worker_id: undefined, task_id: t.id, key: `left:${t.id}`, row_ids: ids, message: `task ${t.id} has ${ids.length} note(s) no review judged (${why}); they stay unreviewed: ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? `, and ${ids.length - 8} more` : ''}` }, Object.assign(new Error('left'), { code: 'E_PARTIAL' }));
  }
}

// The sweep alone, store-only, before the run-close stages (`belay run` hands it to them). A report that a finished job upheld is applied before the
// scrub can archive its note; an upheld report applied after is refused ("not live in this run's project"). It is the pre-close sweep (see `sweep`):
// the run-end sweep runs again after run.end and does the rest, and the store makes a second application a no-op. Returns null with notes off.
async function reviewSweep({ core, runId, levers, gate = null }) {
  const lv = levers;
  if (!lv || !lv.notes) return null;
  const J = { ctx: { core, runId, memoryLevers: lv }, core, lv, w: null, gate: gate || { aborted: false }, s: {}, turnPath: false };
  const g = gated(J);
  const tasks = ((await g.task.list({})) || {}).tasks || [];
  const workers = ((await g.worker.list({})) || {}).workers || [];
  await sweep(J, tasks, workers, { preClose: true });
  return { swept: true, tasks: tasks.length };
}

module.exports = { waitJob, reviewTail, onTaskEnded, applyHandback, sweep, reviewSweep, drain, expectsJobs, runJob, lastTextOf, jobIdFor, taskOfJob, isJob, JOB_PREFIX, JOB_WALL_MS };
