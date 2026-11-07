'use strict';
// policy-rounds-run.cjs — what the round steps of policy-rounds.cjs do once their claim is written (ADR 0074 amendment 5). The same contract as
// policy-steps-run.cjs: existing core calls through the stamped view (`env.core`) and the adapter's assign over it (`env.assign`), an outcome the
// claim is finished with, no worker's words read. A hand-back that went back to its builder is the same task assigned again, so its review and
// its merge go on from that one row; a merge-side fix is a new fix task (`repairs` the work) in the conflicting task's own tree.

const RF = require('./policy-rounds.cjs');
const steps = () => require('./policy-steps-run.cjs'); // required when a step runs: policy-steps-run.cjs requires this file back

// The same task assigned to the worker that handed it back, with belay's reason as the prompt that follows the task text.
async function reassign(c, env) {
  const S = steps();
  const cur = await env.core.task.get({ task_id: c.task_id });
  if (!cur || cur.state !== 'released' || !cur.handoff) return { outcome: 'skipped', error: `${c.task_id} is no longer a released hand-back` };
  const why = await S.unavailable(env, c.worker, c.step === 'reask' ? 'reviewer' : 'builder');
  if (why) return S.exception(why);
  const r = await S.handOver(env, { task_id: c.task_id, worker_id: c.worker, prompt: c.prompt }, `task:${c.task_id}`, true);
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
  try { row = await env.core.task.evaluate({ task_id: c.task_id, worktree: tree, trigger: 'release' }); } catch (e) { return { outcome: 'skipped', error: `the re-run did not finish: ${S.errText(e)}` }; }
  return { outcome: 'done', row_ref: `task:${row.id}` };
}

// A fix task for what the integrate step could not land, worked in the conflicting task's tree by the one who built it.
async function mergeFix(c, env) {
  const S = steps();
  const w = await env.core.task.get({ task_id: c.conflict_task });
  if (!w || w.state !== 'done') return { outcome: 'skipped', error: `${c.conflict_task} is no longer done` };
  const why = await S.unavailable(env, c.worker, 'builder');
  if (why) return S.exception(why);
  const made = await env.core.task.create({
    spec: c.spec, acceptance: w.acceptance, files_owned: w.files_owned, depends_on: [w.id], repairs: c.task_id, tree_of: w.id, ...(w.base ? { base: w.base } : {}),
  });
  const ref = `task:${made.id}`;
  if (made.fix_notice) return S.exception(`fix_notice: ${made.fix_notice}`, ref); // past max_fix_rounds since the pass read it: the fix stays unassigned
  return S.handOver(env, { task_id: made.id, worker_id: c.worker }, ref, true);
}

// A pass on a retry, recorded: the row that carries the fact.
async function noteFlaky(c, env) {
  const cur = await env.core.task.get({ task_id: c.task_id });
  if (!cur || cur.state !== 'done' || !(cur.results && cur.results.flaky)) return { outcome: 'skipped', error: `${c.task_id} no longer carries a flaky pass` };
  return { outcome: 'done', row_ref: `task:${cur.id}` };
}

const RUNNERS = { fix_eval: reassign, fix_run: reassign, reask: reassign, rerun_alone: rerun, rerun_eval: rerun, fix_conflict: mergeFix, fix_checks: mergeFix, fix_commit: mergeFix, note_flaky: noteFlaky };

module.exports = { RUNNERS, STEP_NAMES: RF.STEP_NAMES };
