'use strict';
// cross-run.cjs — ADR 0067 amendment 5: the cross_run_merge check of integration.merge.
const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const G = require('./git.cjs');
const J = require('./judged.cjs');

// ADR 0067 amendment 5: a run merges its own work into its own integrate branch. Refused unless this run's spec set cross_run_merge: a task
// another run made; a task on a branch another run's task is recorded on (a fix task carries the work it fixes, live run or ended); a branch
// `belay/integrate/<run>` of another run the store knows (run ids compared as isUserBranch does); or a branch another run's task records. Also a task whose lineage (follows_up, repairs, depends_on, transitively) reaches another run's
// task, and, as a backstop, a task whose merged commit contains another run's judged commit that `into` does not (`targets`: integration.merge's).
async function refuseCrossRun(E, caller, tasks, into, repo, fold, targets = new Map()) {
  if (caller.role === 'operator' || !caller.run_id) return;
  const me = rows.current(E.store, 'run', caller.run_id);
  if (me && Number(me.cross_run_merge) === 1) return;
  const mine = fold(caller.run_id);
  const all = rows.currentAll(E.store, 'task').filter((x) => x.run_id && fold(x.run_id) !== mine);
  const onBranch = (x, b) => x.worktree && x.worktree.branch && !x.worktree.branch_deleted && fold(x.worktree.branch) === fold(b) && x.worktree.repo && G.samePath(x.worktree.repo, repo);
  const foreign = new Map(); // task id -> run id, with why
  for (const t of tasks) {
    if (t.run_id && fold(t.run_id) !== mine) foreign.set(t.id, { run_id: t.run_id, why: 'belongs to another run' });
    else for (const x of all) if (t.worktree && t.worktree.branch && onBranch(x, t.worktree.branch)) foreign.set(t.id, { run_id: x.run_id, why: `is on ${t.worktree.branch}, which task ${x.id} of run ${x.run_id} also records` });
  }
  const byId = new Map(rows.currentAll(E.store, 'task').map((x) => [x.id, x]));
  const parents = (x) => [x.follows_up && x.follows_up.task_id, x.repairs, ...(Array.isArray(x.depends_on) ? x.depends_on : [])].filter(Boolean);
  for (const t of tasks) {
    if (foreign.has(t.id)) continue;
    const seen = new Set([t.id]);
    for (const q = parents(t); q.length;) {
      const x = byId.get(q.shift());
      if (!x || seen.has(x.id)) continue;
      seen.add(x.id);
      if (x.run_id && fold(x.run_id) !== mine) { foreign.set(t.id, { run_id: x.run_id, why: `descends from task ${x.id} of run ${x.run_id}` }); break; }
      q.push(...parents(x));
    }
  }
  const intoRef = (await G.run(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${into}^{commit}`])).ok ? `refs/heads/${into}` : 'HEAD';
  for (const t of tasks) {
    const tg = targets.get(t.id);
    if (foreign.has(t.id) || !tg || !tg.sha) continue;
    for (const x of all) {
      const j = J.judgedOf(x);
      if (!j || !j.head) continue;
      if ((await G.run(repo, ['merge-base', '--is-ancestor', j.head, tg.sha])).ok && !(await G.run(repo, ['merge-base', '--is-ancestor', j.head, intoRef])).ok) {
        foreign.set(t.id, { run_id: x.run_id, why: `contains the judged commit ${j.head.slice(0, 12)} of task ${x.id} of run ${x.run_id}, which ${into} does not` });
        break;
      }
    }
  }
  const m = /^belay\/integrate\/(.+)$/.exec(into);
  const names = m ? [m[1], m[1].split('/')[0]] : [];
  const runs = rows.currentAll(E.store, 'run');
  const other = names.length && names.map((n) => runs.find((r) => fold(r.id) === fold(n))).find((r) => r && fold(r.id) !== mine);
  const theirs = other ? other.id : null;
  const owner = !theirs && all.find((x) => onBranch(x, into));
  if (!foreign.size && !theirs && !owner) return;
  const what = [
    foreign.size ? `${foreign.size > 1 ? 'tasks' : 'task'} ${[...foreign].map(([id, f]) => `${id} (run ${f.run_id}) ${f.why}`).join('; ')}` : '',
    theirs ? `${into} is run ${theirs}'s integrate branch` : '',
    owner ? `${into} is the branch of task ${owner.id} of run ${owner.run_id}` : '',
  ].filter(Boolean).join('; and ');
  throw err('E_PRECONDITION', `this run (${caller.run_id}) does not merge across runs: ${what}. Ask the operator to relaunch the run with cross_run_merge: true, or merge only this run's tasks into belay/integrate/${caller.run_id}`,
    { run_id: caller.run_id, foreign_tasks: [...foreign].map(([id, f]) => ({ task_id: id, run_id: f.run_id })), into, into_run: theirs, into_task: owner ? owner.id : null, setting: 'cross_run_merge' });
}

module.exports = { refuseCrossRun };
