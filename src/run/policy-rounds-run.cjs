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
// for a builder, `review.spawn` for a refuter) in the same tree. An operator's kill is the operator's and is not undone, a Codex worker is never replaced by a Claude
// Code one, and a restart still in flight is waited for (the claim is reopened), never answered with a second worker in the same tree.
// -> { worker } (ready) | { fresh: { tree, agent_type, id } } (to be started WITH the task: giveTask) | { res } (the step's end).
// `treeTask`: the task whose tree a fresh worker starts in.
async function readyWorker(c, env, treeTask, role = 'builder') {
  const S = steps();
  const why = await S.unavailable(env, c.worker, role);
  if (!why) return { worker: c.worker };
  const ws = ((await env.core.worker.list({})) || {}).workers || [];
  const w = ws.find((x) => x.id === c.worker);
  // dead: its row says so, or it claims to run and its process is gone (a Codex row between turns is not that: policy-steps-run.cjs unavailable)
  const dead = !!w && (w.state === 'dead' || (w.pid_alive === false && w.substrate !== 'codex' && ['starting', 'running', 'idle'].includes(w.state)));
  if (!dead) return { res: S.exception(why) };
  if (KM.isKilled(env.dataDir, c.worker, w.pid, w.pid_created)) return { res: S.exception(`${why}; it was killed by an operator's command, and belay does not undo it`) };
  const run = env.core.run ? ((await env.core.run.get({})) || {}).run : null;
  if (run && run.paused_at != null) return { res: { outcome: 'skipped', error: 'E_PAUSED: the run is paused; the claim is reopened and the step retaken after the resume' } };
  const tried = [why];
  // One restart per step across reopened claims (a slow launch returns relaunch_in_flight and the step is taken again): the attempt is a claim of its own
  // (policy-exec.cjs restartOnce), so a second pass does not start another while an outage keeps the first from coming up. After it: a fresh worker, or the exception.
  const again = env.restart && env.restartOnce ? !(await env.restartOnce(c)) : false;
  if (again) tried.push(`${c.worker} was already restarted once for this step`);
  if (env.restart && !again) {
    try {
      const rec = await env.restart(c.worker);
      if (rec && rec.relaunch_in_flight === true) return { res: { outcome: 'skipped', error: `E_NOT_NOW: ${c.worker} is being restarted and is not up yet; the step is taken again once it is` } };
      const still = await S.unavailable(env, c.worker, role);
      if (!still) return { worker: c.worker };
      tried.push(`restarted, but ${still}`);
    } catch (e) {
      if (e && e.code === 'E_PAUSED') return { res: { outcome: 'skipped', error: 'E_PAUSED: the run was paused as the builder was restarted; the claim is reopened and the step retaken after the resume' } };
      tried.push(`restart: ${errText(e)}`);
    }
  } else if (!env.restart) tried.push('this run has no restart path');
  const spec = role === 'refuter' ? c.review : c.build;
  const spawn = spec && spec.spawn ? spec.spawn : null;
  const wt = spawn && env.spawn && w.substrate !== 'codex' ? ((await env.core.task.get({ task_id: treeTask })) || {}).worktree : null;
  if (!wt || !wt.path || wt.removed_at) return { res: S.exception(`${tried.join('; ')}; and ${w.substrate === 'codex' ? 'a Codex worker is not replaced by a Claude Code one' : !spawn ? `the plan has no ${role === 'refuter' ? 'review' : 'build'} spawn to start another` : !env.spawn ? 'this run has no spawn path' : `${treeTask} has no belay worktree to start a coder in`}`) };
  return { fresh: { tree: wt.path, agent_type: spawn.agent_type, id: `${role === 'refuter' ? 'rev' : 'bld'}-${require('node:crypto').randomUUID().slice(0, 8)}` } };
}

// Gives `taskId` to the worker readyWorker chose. A live or restarted one is assigned it with the prompt. A fresh one is started WITH the task (the spawn assigns it
// under the step's claim, and its first message is the task's text and the prompt: a spawn with neither is refused), and is stopped, gracefully, if it did not end up
// holding the task. -> the step's end; `worker_id` names the worker that took it when it was not the one the claim was made for, `spawned` a fresh one (retired like any
// worker a step spawns). `written`: the step already wrote a row (a fix task), so a pause is an exception that names it, not a skip that would write it twice.
async function giveTask(c, env, b, { taskId, ref, prompt = null, pausedOk = false, written = false }) {
  const S = steps();
  const lease = async () => { const l = ((await env.core.task.get({ task_id: taskId })) || {}).lease; return l && l.id ? l : null; };
  if (!b.fresh) {
    const r = await S.handOver(env, { task_id: taskId, worker_id: b.worker, ...(prompt ? { prompt } : {}) }, ref, pausedOk);
    if (r.outcome === 'done' && !written) { const l = await lease(); if (l) r.row_ref = `lease:${l.id}`; } // the row the step wrote is the lease
    return b.worker !== c.worker ? { ...r, worker_id: b.worker } : r;
  }
  let row;
  try {
    row = await env.spawn({ substrate: 'claude-code', worktree: b.fresh.tree, task_id: taskId, agent_type: b.fresh.agent_type, worker_id: b.fresh.id, ...(prompt ? { prompt } : {}) });
  } catch (e) {
    if (e && e.code === 'E_PAUSED') return written ? S.exception(`the run was paused as the replacement was started; ${taskId} stands unassigned`, ref) : { outcome: 'skipped', error: 'E_PAUSED: the run was paused as the replacement was started; the claim is reopened and the step retaken after the resume' };
    return S.exception(`the replacement could not be started: ${errText(e)}`, ref);
  }
  const id = (row && row.id) || b.fresh.id;
  const l = await lease();
  if (!l || l.holder !== id) {
    if (env.stop) { try { await env.stop(id); } catch { /* the exception below stands */ } } // a worker that holds nothing is not left running in the tree
    return S.exception(`started ${id}, but it holds no lease on ${taskId}; it was stopped`, ref);
  }
  return { outcome: 'done', row_ref: written ? ref : `lease:${l.id}`, worker_id: id, spawned: id };
}

// A Codex worker cannot commit (belay commits its worktree when it hands back), so a round's text to it does not ask for a commit.
const CODEX_WORDS = [
  [', commit, and release the task again.', ', and release the task again.'],
  ['Make sure your work is committed, and release', 'Make sure your changes are in your worktree, and release'],
  ['commit your work in your worktree (git add, git commit), run your checks, and release', 'make sure your changes are in your worktree, run your checks, and release'],
  [', run your checks, commit, and release.', ', run your checks, and release.'],
  [', make those checks pass, commit, and release.', ', make those checks pass, and release.'],
];
async function wording(env, workerId, text) {
  if (typeof text !== 'string' || !workerId) return text;
  const w = (((await env.core.worker.list({})) || {}).workers || []).find((x) => x.id === workerId);
  return w && w.substrate === 'codex' ? CODEX_WORDS.reduce((t, [a, b]) => t.split(a).join(b), text) : text;
}

// The same task assigned to the worker that handed it back, with belay's reason as the prompt that follows the task text.
async function reassign(c, env) {
  const S = steps();
  const cur = await env.core.task.get({ task_id: c.task_id });
  if (!cur || cur.state !== 'released' || !cur.handoff) return { outcome: 'skipped', error: `${c.task_id} is no longer a released hand-back` };
  if (c.step === 'reask') {
    const why = await S.unavailable(env, c.worker, 'reviewer');
    if (why) return S.exception(why);
    return giveTask(c, env, { worker: c.worker }, { taskId: c.task_id, ref: `task:${c.task_id}`, prompt: c.prompt, pausedOk: true });
  }
  const b = await readyWorker(c, env, c.task_id);
  if (b.res) return b.res;
  return giveTask(c, env, b, { taskId: c.task_id, ref: `task:${c.task_id}`, prompt: await wording(env, b.worker, c.prompt), pausedOk: true });
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

// A merge or rebase needs git writes a Codex sandbox denies, so a conflict or checks fix whose builder is Codex goes to a fresh Claude Code coder in the
// same tree (the step ends with worker_id naming it). With no way to start one, the step is an exception that says so: Codex is not sent what it cannot do.
const NEEDS_GIT = new Set(['fix_conflict', 'fix_checks']);
async function claudeInstead(c, env, w) {
  if (!NEEDS_GIT.has(c.step)) return null;
  const cw = (((await env.core.worker.list({})) || {}).workers || []).find((x) => x.id === c.worker);
  if (!cw || cw.substrate !== 'codex') return null;
  const tree = w.worktree && w.worktree.path && !w.worktree.removed_at ? w.worktree.path : null;
  if (!env.spawn || !tree) return { res: steps().exception(`${c.worker} is a Codex worker, whose sandbox cannot merge or rebase, and ${!env.spawn ? 'this run has no spawn path' : `task ${w.id} has no worktree`} to start a Claude Code coder in; the fix was not sent`) };
  return { fresh: { tree, agent_type: 'coder', id: `bld-${require('node:crypto').randomUUID().slice(0, 8)}` } };
}

// A fix task for what the integrate step could not land, worked in the conflicting task's tree by the one who built it.
async function mergeFix(c, env) {
  const S = steps();
  const w = await env.core.task.get({ task_id: c.conflict_task });
  if (!w || w.state !== 'done') return { outcome: 'skipped', error: `${c.conflict_task} is no longer done` };
  const b = (await claudeInstead(c, env, w)) || await readyWorker(c, env, w.id);
  if (b.res) return b.res;
  const made = await env.core.task.create({
    spec: await wording(env, b.worker, c.spec), acceptance: w.acceptance, files_owned: w.files_owned, depends_on: [w.id], repairs: c.task_id, tree_of: w.id, ...(w.base ? { base: w.base } : {}),
  });
  const ref = `task:${made.id}`;
  if (made.fix_notice) return S.exception(`fix_notice: ${made.fix_notice}`, ref); // past max_fix_rounds since the pass read it: the fix stays unassigned
  return giveTask(c, env, b, { taskId: made.id, ref, written: true });
}

// A pass on a retry, recorded: the row that carries the fact.
async function noteFlaky(c, env) {
  const cur = await env.core.task.get({ task_id: c.task_id });
  if (!cur || cur.state !== 'done' || !(cur.results && cur.results.flaky)) return { outcome: 'skipped', error: `${c.task_id} no longer carries a flaky pass` };
  return { outcome: 'done', row_ref: `task:${cur.id}` };
}

const RUNNERS = { fix_eval: reassign, fix_run: reassign, reask: reassign, rerun_alone: rerun, rerun_eval: rerun, fix_conflict: mergeFix, fix_checks: mergeFix, fix_commit: mergeFix, note_flaky: noteFlaky };

module.exports = { readyWorker, giveTask, RUNNERS, STEP_NAMES: RF.STEP_NAMES };
