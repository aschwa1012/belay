'use strict';
// policy-rounds-run.cjs — what the round steps of policy-rounds.cjs do once their claim is written (ADR 0074 amendment 8). The same contract as
// policy-steps-run.cjs: existing core calls through the stamped view (`env.core`) and the adapter's assign over it (`env.assign`), an outcome the
// claim is finished with, no worker's words read. A hand-back that went back to its builder is the same task assigned again, so its review and
// its merge go on from that one row; a merge-side fix is a new fix task (`repairs` the work) in the conflicting task's own tree.

const RF = require('./policy-rounds.cjs');
const KM = require('../core/kill-mark.cjs');
const steps = () => require('./policy-steps-run.cjs'); // required when a step runs: policy-steps-run.cjs requires this file back
const errText = (e) => `${(e && e.code) || 'E_INTERNAL'}: ${String((e && e.message) || e).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 200)}`;

// The worker a step goes to, ready to take it: the builder of a round, or the refuter of a re_review. A worker that is already dead when its step comes due (it died
// after it handed back, so no task of it is open for policy-relaunch.cjs) is not one belay can assign to; the step is its own bound (one revival a step, and the cap
// or the review loop bounds the steps), so it is brought back here: the same worker restarted on its session, else a fresh one of the plan's spawn (`build.spawn`
// for a builder, `review.spawn` for a refuter) in the same tree. An operator's kill is the operator's and is not undone.
// -> { worker } | { res } (the step's end when it cannot be done: the exception it always was). `treeTask`: the task whose tree a fresh worker starts in.
async function readyWorker(c, env, treeTask, role = 'builder') {
  const S = steps();
  const why = await S.unavailable(env, c.worker, role);
  if (!why) return { worker: c.worker };
  const ws = ((await env.core.worker.list({})) || {}).workers || [];
  const w = ws.find((x) => x.id === c.worker);
  if (!w || w.state !== 'dead') return { res: S.exception(why) };
  if (KM.isKilled(env.dataDir, c.worker, w.pid, w.pid_created)) return { res: S.exception(`${why}; it was killed by an operator's command, and belay does not undo it`) };
  const run = env.core.run ? ((await env.core.run.get({})) || {}).run : null;
  if (run && run.paused_at != null) return { res: { outcome: 'skipped', error: 'E_PAUSED: the run is paused; the claim is reopened and the step retaken after the resume' } };
  const tried = [why];
  if (env.restart) {
    try { await env.restart(c.worker); const still = await S.unavailable(env, c.worker, role); if (!still) return { worker: c.worker }; tried.push(`restarted, but ${still}`); } catch (e) {
      if (e && e.code === 'E_PAUSED') return { res: { outcome: 'skipped', error: 'E_PAUSED: the run was paused as the builder was restarted; the claim is reopened and the step retaken after the resume' } };
      tried.push(`restart: ${errText(e)}`);
    }
  } else tried.push('this run has no restart path');
  const spec = role === 'refuter' ? c.review : c.build;
  const spawn = spec && spec.spawn ? spec.spawn : null;
  const wt = spawn && env.spawn ? ((await env.core.task.get({ task_id: treeTask })) || {}).worktree : null;
  if (!wt || !wt.path || wt.removed_at) return { res: S.exception(`${tried.join('; ')}; and ${!spawn ? `the plan has no ${role === 'refuter' ? 'review' : 'build'} spawn to start another` : !env.spawn ? 'this run has no spawn path' : `${treeTask} has no belay worktree to start a coder in`}`) };
  try {
    const id = `${role === 'refuter' ? 'rev' : 'bld'}-${require('node:crypto').randomUUID().slice(0, 8)}`;
    const row = await env.spawn({ substrate: 'claude-code', worktree: wt.path, agent_type: spawn.agent_type, worker_id: id }); // no task: the step assigns it, with its reason
    return { worker: (row && row.id) || id };
  } catch (e) {
    if (e && e.code === 'E_PAUSED') return { res: { outcome: 'skipped', error: 'E_PAUSED: the run was paused as the coder was spawned; the claim is reopened and the step retaken after the resume' } };
    return { res: S.exception(`${tried.join('; ')}; spawn: ${errText(e)}`) };
  }
}

// The same task assigned to the worker that handed it back, with belay's reason as the prompt that follows the task text.
async function reassign(c, env) {
  const S = steps();
  const cur = await env.core.task.get({ task_id: c.task_id });
  if (!cur || cur.state !== 'released' || !cur.handoff) return { outcome: 'skipped', error: `${c.task_id} is no longer a released hand-back` };
  let worker = c.worker;
  if (c.step === 'reask') { const why = await S.unavailable(env, c.worker, 'reviewer'); if (why) return S.exception(why); } else {
    const b = await readyWorker(c, env, c.task_id);
    if (b.res) return b.res;
    worker = b.worker;
  }
  const r = await S.handOver(env, { task_id: c.task_id, worker_id: worker, prompt: c.prompt }, `task:${c.task_id}`, true);
  if (r.outcome === 'done') { const l = ((await env.core.task.get({ task_id: c.task_id })) || {}).lease; if (l && l.id) r.row_ref = `lease:${l.id}`; } // the row the step wrote is the lease
  return r;
}

// The evaluation run again where the worker's own was run (its worktree). A re-run that did not finish writes nothing and ends skipped: the plan
// goes on to the fix round with the reason, so a re-run is never an exception of its own.
async function rerun(c, env) {
  const S = steps();
  const cur = await env.core.task.get({ task_id: c.task_id });
  if (!cur || cur.state !== 'released' || !cur.handoff) return { outcome: 'skipped', error: `${c.task_id} is no longer a released hand-back` };
  const ws = ((await env.core.worker.list({})) || {}).workers || [];
  const w = ws.find((x) => x.id === cur.handoff.by);
  const tree = (w && w.worktree) || (cur.worktree && cur.worktree.path && !cur.worktree.removed_at ? cur.worktree.path : null);
  if (!tree) return { outcome: 'skipped', error: `${c.task_id} has no worktree to evaluate in` };
  let row;
  try { row = await env.core.task.evaluate({ task_id: c.task_id, worktree: tree, trigger: 'release' }); } catch (e) {
    // A queue refusal says nothing about the work: the claim is reopened (E_NOT_NOW) and the re-run is taken again, not a round that tells the builder to commit.
    if (e && (e.code === 'E_BUSY' || e.code === 'E_TIMEOUT')) return { outcome: 'skipped', error: `E_NOT_NOW: the evaluation could not start (${S.errText(e).slice(0, 120)}); the re-run is taken again` };
    return { outcome: 'skipped', error: `the re-run did not finish: ${S.errText(e)}` };
  }
  return { outcome: 'done', row_ref: `task:${row.id}` };
}

// A fix task for what the integrate step could not land, worked in the conflicting task's tree by the one who built it.
async function mergeFix(c, env) {
  const S = steps();
  const w = await env.core.task.get({ task_id: c.conflict_task });
  if (!w || w.state !== 'done') return { outcome: 'skipped', error: `${c.conflict_task} is no longer done` };
  const b = await readyWorker(c, env, w.id);
  if (b.res) return b.res;
  const made = await env.core.task.create({
    spec: c.spec, acceptance: w.acceptance, files_owned: w.files_owned, depends_on: [w.id], repairs: c.task_id, tree_of: w.id, ...(w.base ? { base: w.base } : {}),
  });
  const ref = `task:${made.id}`;
  if (made.fix_notice) return S.exception(`fix_notice: ${made.fix_notice}`, ref); // past max_fix_rounds since the pass read it: the fix stays unassigned
  return S.handOver(env, { task_id: made.id, worker_id: b.worker }, ref, true);
}

// A pass on a retry, recorded: the row that carries the fact.
async function noteFlaky(c, env) {
  const cur = await env.core.task.get({ task_id: c.task_id });
  if (!cur || cur.state !== 'done' || !(cur.results && cur.results.flaky)) return { outcome: 'skipped', error: `${c.task_id} no longer carries a flaky pass` };
  return { outcome: 'done', row_ref: `task:${cur.id}` };
}

const RUNNERS = { fix_eval: reassign, fix_run: reassign, reask: reassign, rerun_alone: rerun, rerun_eval: rerun, fix_conflict: mergeFix, fix_checks: mergeFix, fix_commit: mergeFix, note_flaky: noteFlaky };

module.exports = { readyWorker, RUNNERS, STEP_NAMES: RF.STEP_NAMES };
