'use strict';
// methods-task-commit.cjs — what the run manager did for a Codex worker's hand-back: belay committed its worktree (Codex's sandbox
// cannot), or could not and why. Written onto the hand-back as `commit`, with `committed_by: 'belay'` only when a commit was made.
// The hand-back's own words (`result`) are not touched; the derived stale check reads the commit's head when belay made one.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');

const SHA = /^[0-9a-f]{7,64}$/;
const PATHS_MAX = 200; // every committed path up to this many; the rest are counted
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

async function recordCommit(E, caller, args) {
  const c = args.commit;
  if (!args.task_id || !args.worker_id) throw err('E_ARGS', 'task.recordCommit needs a task_id and a worker_id');
  if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.made !== 'boolean') throw err('E_ARGS', 'task.recordCommit: commit must be { made, head, branch, files?, message?, error? }');
  if (c.made && !SHA.test(String(c.head))) throw err('E_ARGS', 'task.recordCommit: a made commit names its head (a hex sha)');
  const fact = { made: c.made, head: typeof c.head === 'string' && SHA.test(c.head) ? c.head : null, branch: str(c.branch, 200),
    ...(c.made ? { files: Number.isInteger(c.files) ? c.files : null, paths: Array.isArray(c.paths) ? c.paths.slice(0, PATHS_MAX).map((p) => str(String(p), 300)) : [], ...(Array.isArray(c.paths) && c.paths.length > PATHS_MAX ? { paths_more: c.paths.length - PATHS_MAX } : {}), message: str(c.message, 200) } : {}), ...(c.error ? { error: str(c.error, 400) } : {}) };
  const out = E.store.tx(() => {
    const task = rows.current(E.store, 'task', args.task_id);
    if (!task) throw err('E_NOT_FOUND', `no task row exists for ${args.task_id}`, { task_id: args.task_id });
    require('./worker-run-guard.cjs').refuseOtherRunTask(E, caller, task);
    const h = task.handoff;
    if (task.state !== 'released' || !h || h.by !== args.worker_id || (args.lease_id && h.lease_id !== args.lease_id)) {
      throw err('E_PRECONDITION', `task ${task.id} is not a released hand-back of worker ${args.worker_id}${args.lease_id ? ` under lease ${args.lease_id}` : ''}, so no commit is recorded on it`, { task_id: task.id, state: task.state });
    }
    return rows.append(E.store, 'task', { ...task, handoff: { ...h, commit: { ...fact, at: Date.now() }, ...(c.made ? { committed_by: 'belay' } : {}) } }, E.writtenBy(caller), Date.now());
  });
  E.noteWrite();
  return out;
}

module.exports = { recordCommit };
