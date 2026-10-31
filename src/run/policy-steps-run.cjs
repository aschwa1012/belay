'use strict';
// policy-steps-run.cjs — what each v1 policy step does once its claim is written (ADR 0072 decision 1): fix (to the builder), re_review
// (to the refuter) and integrate (on a hold). Each step is existing core calls, made through the stamped view the executor hands in
// (`env.core`, core.harness().policyAs(seq)) and `env.assign` (the adapter's task_assign over that same view), so the core applies its
// own checks and refusals and stamps every row the step writes. A step returns the outcome its claim is finished with and never throws a
// result away:
//   { outcome: 'done', row_ref }        the step wrote that row
//   { outcome: 'superseded', row_ref }  the orchestrator got there first; the row that stands (decision 2, 0072 Q1)
//   { outcome: 'skipped', error }       the fact the step was claimed for no longer holds; nothing was written
//   { outcome: 'exception', error, row_ref? }  a refusal, a worker that cannot take the task, a failed hand-over: not retried (decision 6)
// Nothing here reads a message. The named worker is the id the store recorded on a hand-back (`handoff.by`), checked live and idle.

const LIVE = new Set(['starting', 'running', 'idle']);
const errText = (e) => `${(e && e.code) || 'E_INTERNAL'}: ${String((e && e.message) || e).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 800)}`;
const exception = (error, row_ref) => ({ outcome: 'exception', error, ...(row_ref ? { row_ref } : {}) });

// Why the named worker cannot take a task now (null when it can): no id recorded, no live row, or a lease it holds on another task.
async function unavailable(env, id, role) {
  if (!id) return `no ${role} is recorded for this task`;
  const ws = ((await env.core.worker.list({})) || {}).workers || [];
  const w = ws.find((x) => x.id === id);
  if (!w) return `${role} ${id} has no worker row`;
  if (!LIVE.has(w.state) || (w.pid_alive === false && w.substrate !== 'codex')) return `${role} ${id} is ${w.state}${w.pid_alive === false ? ' and its pid is gone' : ''}`;
  const tasks = ((await env.core.task.list({})) || {}).tasks || [];
  const busy = tasks.find((t) => t.lease && t.lease.holder === id && !t.lease.expired && t.state !== 'done' && t.state !== 'cancelled');
  return busy ? `${role} ${id} is busy with task ${busy.id}` : null;
}

// The assignment and the worker told of it: the outcome the step ends with. A throw keeps the row the step already wrote (invariant 5).
async function handOver(env, args, ref, pausedOk = false) {
  let a;
  try { a = await env.assign(args); } catch (e) { if (pausedOk && e && e.code === 'E_PAUSED') return paused(`the run was paused as review task ${args.task_id} was assigned; it stands unassigned and the retake assigns it`); return exception(`the task could not be assigned: ${errText(e)}`, ref); }
  if (a && a.existing === true) return a.superseded === true && a.new_lease ? { outcome: 'superseded', row_ref: `lease:${a.new_lease.id}` } : { outcome: 'done', row_ref: ref };
  const d = a && a.delivered;
  if (d && d.sent !== true && d.queued !== true) return exception(`assigned, but the worker was not told: ${d.reason || d.error || 'no reason'}`, ref);
  return { outcome: 'done', row_ref: ref };
}
async function fix(c, env) {
  const cur = await env.core.task.get({ task_id: c.task_id });
  if (!cur.review || cur.review.state !== 'refuted' || cur.review.review_id !== c.review_id) return { outcome: 'skipped', error: `the review of ${c.task_id} is no longer ${c.review_id} refuted` };
  const why = await unavailable(env, c.worker, 'builder');
  if (why) return exception(why);
  const made = await env.core.task.fixFromReview({ review_id: c.review_id });
  const ref = `task:${made.id}`;
  if (made.existing === true) return { outcome: made.superseded === true ? 'superseded' : 'done', row_ref: ref }; // a fix already answers the review: it stands, and is not assigned again
  if (made.fix_notice) return exception(`fix_notice: ${made.fix_notice}`, ref); // past max_fix_rounds: the fix stays unassigned, the orchestrator decides
  return handOver(env, { task_id: made.id, worker_id: c.worker }, ref);
}

async function reReview(c, env) {
  const tasks = ((await env.core.task.list({})) || {}).tasks || [];
  const fixRow = tasks.find((t) => t.id === c.fix_id);
  const there = tasks.find((t) => t.state !== 'cancelled' && t.acceptance && t.acceptance.verdict === true && (t.depends_on || []).includes(c.fix_id));
  if (there) return { outcome: 'superseded', row_ref: `task:${there.id}` }; // the orchestrator made the review first
  if (!fixRow || fixRow.state !== 'done') return { outcome: 'skipped', error: `fix ${c.fix_id} is no longer done` };
  const why = await unavailable(env, c.worker, 'refuter');
  if (why) return exception(why);
  const refuted = tasks.find((t) => t.id === c.review_id);
  const made = await env.core.task.create({
    spec: `Re-review ${c.task_id} after fix ${c.fix_id}. You refuted it in ${c.review_id}; judge whether the fix answers your findings.${refuted && refuted.spec ? `\n\n${refuted.spec}` : ''}`,
    acceptance: { verdict: true }, depends_on: [c.fix_id],
  });
  const ref = `task:${made.id}`;
  return handOver(env, { task_id: made.id, worker_id: c.worker }, ref);
}

// review: a done work with nothing reviewing it gets the verdict task, handed to the plan's worker (`review.worker`, live and idle) or to a
// worker belay spawns with the plan's agent_type (`review.spawn`) through the run manager's own spawn (invariant 1). The spawn takes the task in its
// first message, so no second message follows, and it assigns through the step's stamped view, so the lease carries the claim's stamp. The tree the
// reviewer starts in is the work's own belay worktree, found before anything is written: a work without one writes nothing and is an exception.
async function reviewTree(env, c) {
  const w = (await env.core.task.get({ task_id: c.task_id })).worktree;
  return w && w.path && !w.removed_at ? w.path : null;
}
// A pause is not a failure: the step is skipped with E_PAUSED, which policy.claim reopens at the resume (nothing is assigned or launched).
const paused = (why) => ({ outcome: 'skipped', error: `E_PAUSED: ${why}; the claim is reopened and the step retaken after the resume` });
// A review "left over" by a paused try of this step: a policy-made review task that never got a lease, was never evaluated and handed nothing back. A
// review that was refuted or held (results), handed back (handoff) or done is a verdict that stands, never a task to hand over again.
const leftOver = (t) => !!t && t.policy_made === true && !t.lease && t.results == null && t.handoff == null && t.state !== 'done' && t.state !== 'cancelled';
async function review(c, env) {
  const tasks = ((await env.core.task.list({})) || {}).tasks || [];
  const reviews = tasks.filter((t) => t.state !== 'cancelled' && t.acceptance && t.acceptance.verdict === true && (t.depends_on || []).includes(c.task_id));
  const left = reviews.find((t) => leftOver(t)); // a review an earlier try of this step made and a pause kept from being handed over
  const there = left ? null : reviews[0];
  if (there) return { outcome: 'superseded', row_ref: `task:${there.id}` }; // the orchestrator made the review first
  const work = tasks.find((t) => t.id === c.task_id);
  if (!work || work.state !== 'done') return { outcome: 'skipped', error: `${c.task_id} is no longer done` };
  const spawn = c.review && c.review.spawn ? c.review.spawn : null;
  let tree = null;
  if (spawn) {
    if (!env.spawn) return exception('the plan spawns its reviewer and this run has no spawn path');
    tree = await reviewTree(env, c);
    if (!tree) return exception(`the work ${c.task_id} has no belay worktree to start a reviewer in, so nothing was spawned`);
  } else {
    const why = await unavailable(env, c.worker, 'reviewer');
    if (why) return exception(why);
  }
  // The pause gate comes before the first write: a refusal writes nothing, and the claim is reopened at the resume.
  const run = env.core.run ? ((await env.core.run.get({})) || {}).run : null;
  if (run && run.paused_at != null) return paused('the run is paused');
  const made = left || await env.core.task.create({
    spec: `Review ${c.task_id}: judge whether its work meets its acceptance.${work.spec ? `

${work.spec}` : ''}`,
    acceptance: { verdict: true }, depends_on: [c.task_id],
  });
  const ref = `task:${made.id}`;
  if (!spawn) return handOver(env, { task_id: made.id, worker_id: c.worker }, ref, true); // a pause between the gate above and this assignment is a retake, as it is for a spawn
  let row;
  try { row = await env.spawn({ substrate: 'claude-code', worktree: tree, task_id: made.id, agent_type: spawn.agent_type, worker_id: c.worker }); } catch (e) { if (e && e.code === 'E_PAUSED') return paused(`the run was paused as the reviewer was spawned; review task ${made.id} stands unassigned and the retake assigns it`); return exception(`the reviewer could not be spawned: ${errText(e)}${c.review.spawn.worker_id ? `; the plan names spawn.worker_id ${c.review.spawn.worker_id}, and a reviewer shared by several works is review: { worker: <id> }, not a spawn` : ''}`, ref); }
  const held = ((await env.core.task.get({ task_id: made.id })) || {}).lease;
  if (!held || held.holder !== (row && row.id)) return exception(`spawned ${row && row.id}, but it holds no lease on ${made.id}`, ref);
  return { outcome: 'done', row_ref: ref };
}

// The run manager's spawn made over a step's stamped view: the task the spawn assigns is assigned under the claim.
const spawnFor = (manager) => (stepCore) => (args) => manager.spawn({ ...args, assignCore: stepCore });

// A policy merge names the work unit and nothing else: it goes to the run's own integration branch, never forced or approved.
async function integrate(c, env) {
  const cur = await env.core.task.get({ task_id: c.task_id });
  if (cur.state !== 'done' || !cur.review || cur.review.state !== 'holds' || (cur.integration && cur.integration.state === 'merged')) return { outcome: 'skipped', error: `${c.task_id} is no longer a done, held, unmerged task` };
  const row = await env.core.integration.merge({ task_ids: c.task_ids });
  const ref = `integration:${row.id}`;
  if (row.existing === true) return { outcome: row.superseded === true ? 'superseded' : 'done', row_ref: ref };
  if (row.state === 'failed') return exception(`integration ${row.id} failed${row.error ? `: ${String(row.error.message || row.error).slice(0, 200)}` : ''}`, ref);
  if (row.state === 'conflict') return { outcome: 'done', row_ref: ref }; // a conflict is a finished step: the row carries passed:false too, but only E3 wakes for it
  if (row.passed === false) return exception(`integration ${row.id} checks failed`, ref);
  return { outcome: 'done', row_ref: ref }; // a conflict is a finished step too: the integration row says so and the exception wake carries it
}

const RUNNERS = { review, fix, re_review: reReview, integrate };

async function run(c, env) {
  const f = RUNNERS[c.step];
  if (!f) return { outcome: 'skipped', error: `step ${c.step} is not one 0.4.0 takes` };
  try { return await f(c, env); } catch (e) { return exception(errText(e)); }
}

module.exports = { run, unavailable, spawnFor, leftOver, RUNNERS };
