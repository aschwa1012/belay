'use strict';
// policy-relaunch.cjs — a plan relaunches a dead builder once, and the orchestrator is woken (E4) only when that did not work (ADR 0074).
// A worker's death releases its leases and puts the task it held back to `open` (core/lease-holder-dead.cjs), so a task the plan's build or
// fix step gave a worker, now open and unleased with that worker's row `dead`, is a builder that died mid-task. The `relaunch` step:
//   - restarts the same worker on its session (the run manager's restart: it resumes the session, or starts fresh with the bottle when none is
//     left, and grants the death-released lease back), else
//   - spawns a fresh coder with the plan's `build.spawn` agent type on the same task and tree (the spawn assigns the task, as the build step does).
// One relaunch a task: a step on the task that is not a retake (policy-close-hold.cjs) uses the bound. A relaunch that cannot be done ends
// `skipped` with belay's reason, not `exception`, so it raises no E8 and halts nothing; the death's own E4 wake then reaches the orchestrator.
// Never taken for a task the plan did not build (a lease the orchestrator gave a named worker has no `build` step) or a worker still alive.
// The wake side (`holdDeaths`, called by release-eval.cjs enrichWakes) keeps the death's wake back while the relaunch is due or in flight,
// drops it when the relaunch is done, and sends it when the relaunch did not work or took longer than HOLD_MAX_MS.

const MAX_RELAUNCHES = 1; // a relaunch step per task; the second death of the same task wakes
const HOLD_MAX_MS = 120000; // a death's wake waits this long for the relaunch step before it is sent anyway
const REOPENED = /^E_(PAUSED|NOT_NOW)/; // a claim the executor reopens is not a taken relaunch

const isReview = (t) => !!(t.acceptance && t.acceptance.verdict === true);
const taken = (s) => !(s.outcome === 'skipped' && REOPENED.test(s.error || ''));
const stepsOf = (steps, runId) => (steps || []).filter((s) => s.run_id === runId);

// The worker the plan gave this task: its latest done build step (a fix task: the done fix step that made it). null when the plan gave it none.
function builderOf(x, steps, runId, rootId) {
  const mine = stepsOf(steps, runId).filter((s) => s.outcome === 'done' && s.worker_id);
  if (x.repairs) {
    const built = mine.some((s) => s.step === 'build' && s.task_id === rootId);
    const f = mine.filter((s) => s.step === 'fix' && s.row_ref === `task:${x.id}`).pop();
    return built && f ? f.worker_id : null;
  }
  const b = mine.filter((s) => s.step === 'build' && s.task_id === x.id).pop();
  return b ? b.worker_id : null;
}
const used = (taskId, steps, runId) => stepsOf(steps, runId).filter((s) => s.step === 'relaunch' && s.task_id === taskId && taken(s)).length;

// -> the worker whose death left task `x` open, when the plan may relaunch it (before the worker's row is looked at), else null.
function builderToRelaunch(x, plan, steps, runId, rootId) {
  if (isReview(x) || !plan || !plan.build || x.state !== 'open' || x.lease) return null;
  if (used(x.id, steps, runId) >= MAX_RELAUNCHES) return null;
  return builderOf(x, steps, runId, rootId);
}

// The candidate step for due() (policy-exec.cjs): the builder's row is `dead`. `snap.workers` absent: nothing (a reader that has no worker rows).
function due(x, plan, rev, snap, rootId) {
  if (!Array.isArray(snap.workers)) return null;
  const wid = builderToRelaunch(x, plan, snap.steps, snap.runId, rootId);
  const w = wid && snap.workers.find((r) => r.id === wid);
  if (!w || w.state !== 'dead') return null;
  return { step: 'relaunch', task_id: x.id, trigger: { table: 'task', id: x.id, seq: Number(x.seq) || 0 }, policy_rev: rev, worker: wid, build: plan.build };
}
// Whether the pass need read worker rows at all: some task is open, unleased, and was given to a worker by the plan.
const mayNeed = (tasks, steps, runId, rootOf) => tasks.some((x) => x.run_id === runId && builderToRelaunch(x, { build: true }, steps, runId, x.repairs ? rootOf(x).id : x.id));

const skipped = (error) => ({ outcome: 'skipped', error });
const paused = (why) => ({ outcome: 'skipped', error: `E_PAUSED: ${why}; the claim is reopened and the step retaken after the resume` });
const errText = (e) => `${(e && e.code) || 'E_INTERNAL'}: ${String((e && e.message) || e).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 300)}`;

// The step. `env`: { core (the step's stamped view), assign, spawn, restart } as policy-steps-run.cjs hands them.
async function run(c, env) {
  const t = await env.core.task.get({ task_id: c.task_id });
  if (!t || t.state !== 'open' || t.lease) return skipped(`${c.task_id} is no longer open and unassigned`);
  const ws = ((await env.core.worker.list({})) || {}).workers || [];
  const w = ws.find((x) => x.id === c.worker);
  if (!w || w.state !== 'dead') return skipped(`builder ${c.worker} is ${w ? w.state : 'gone'}, not dead`);
  const runRow = env.core.run ? ((await env.core.run.get({})) || {}).run : null;
  if (runRow && runRow.paused_at != null) return paused('the run is paused');
  const holder = async () => ((await env.core.task.get({ task_id: c.task_id })) || {}).lease || null;
  const why = [];
  if (env.restart) {
    try {
      await env.restart(c.worker);
      let l = await holder();
      if (!l) { try { await env.assign({ task_id: c.task_id, worker_id: c.worker }); } catch (e) { why.push(`restarted, but ${c.task_id} could not be given back: ${errText(e)}`); } l = await holder(); }
      if (l && l.holder === c.worker) return { outcome: 'done', row_ref: `lease:${l.id}` };
      if (!why.length) why.push(`restarted, but it holds no lease on ${c.task_id}`);
      return skipped(`relaunch refused: ${why.join('; ')}`);
    } catch (e) {
      if (e && e.code === 'E_PAUSED') return paused('the run was paused as the builder was restarted');
      why.push(`restart: ${errText(e)}`);
    }
  } else why.push('this run has no restart path');
  const spawn = c.build && c.build.spawn ? c.build.spawn : null;
  if (spawn && env.spawn) {
    const wt = (await env.core.task.get({ task_id: c.task_id })).worktree;
    if (!wt || !wt.path || wt.removed_at) return skipped(`relaunch refused: ${why.join('; ')}; and ${c.task_id} has no belay worktree to start a coder in`);
    try {
      const row = await env.spawn({ substrate: 'claude-code', worktree: wt.path, task_id: c.task_id, agent_type: spawn.agent_type, worker_id: `bld-${require('node:crypto').randomUUID().slice(0, 8)}` });
      const l = await holder();
      if (l && l.holder === (row && row.id)) return { outcome: 'done', row_ref: `lease:${l.id}` };
      why.push(`spawned ${row && row.id}, but it holds no lease on ${c.task_id}`);
    } catch (e) {
      if (e && e.code === 'E_PAUSED') return paused('the run was paused as the coder was spawned');
      why.push(`spawn: ${errText(e)}`);
    }
  }
  return skipped(`relaunch refused: ${why.join('; ')}`);
}

// The wake side. Called with a poll's events and the task rows (release-eval.cjs enrichWakes). A `death` of a worker the plan may relaunch is kept
// in seen.deathHeld, with the task seqs it left open, and is judged each poll against the relaunch steps: done (dropped, counted in
// seen.relaunched), not done or too slow (sent). -> the events to carry on with. One policy.list read, only while a death is held or new.
async function holdDeaths({ core, runId, events, seen, tasks, byId, polOf, rootOf, now = Date.now }) {
  const held = seen.deathHeld || (seen.deathHeld = new Map());
  const fresh = events.filter((e) => e.event === 'death' && seen.policyArmed);
  if (!fresh.length && !held.size) return events;
  let steps = null;
  try { steps = await require('./run-digest.cjs').listSteps(core, runId); } catch { steps = null; }
  const out = events.filter((e) => !fresh.includes(e));
  if (!steps) { const all = out.concat(fresh, [...held.values()].map((h) => h.ev)); held.clear(); return all; } // unreadable: nothing is kept back
  const openOf = (wid) => tasks.filter((x) => x.run_id === runId && builderToRelaunch(x, polOf(x), steps, runId, x.repairs ? rootOf(x).id : x.id) === wid);
  for (const ev of fresh) {
    const open = openOf(ev.worker_id);
    if (open.length) held.set(`${ev.worker_id}:${ev.life || ev.seq}`, { ev, since: now(), seqs: new Map(open.map((x) => [x.id, Number(x.seq) || 0])) });
    else out.push(ev);
  }
  for (const [k, h] of [...held]) {
    const rows = stepsOf(steps, runId).filter((s) => s.step === 'relaunch');
    const verdicts = [...h.seqs].map(([id, seq]) => { const s = rows.find((r) => r.task_id === id && Number(r.trigger_seq) === seq); return !s || s.outcome === 'started' ? 'wait' : (s.outcome === 'done' || s.outcome === 'superseded') ? 'ok' : 'no'; });
    if (verdicts.every((v) => v === 'ok')) { held.delete(k); (seen.relaunched || (seen.relaunched = [])).push({ worker_id: h.ev.worker_id, task_ids: [...h.seqs.keys()] }); continue; }
    if (verdicts.includes('no') || now() - h.since >= HOLD_MAX_MS) { held.delete(k); out.unshift(h.ev); }
  }
  return out;
}

module.exports = { due, run, mayNeed, holdDeaths, builderOf, builderToRelaunch, MAX_RELAUNCHES, HOLD_MAX_MS };
