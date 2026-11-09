'use strict';
// handback-commit.cjs — belay commits for a Codex worker. Codex's workspace-write sandbox denies the worktree's index lock, so a
// Codex coder cannot commit and its hand-back would name the base as its head. When a Codex worker has released a task, the run
// manager commits what is in the worker's own belay worktree, on the branch the task row records, before the hand-back is
// evaluated, and writes what it did to the task's hand-back (core task.recordCommit). Claude Code workers commit for themselves
// and are not touched. Facts only: a commit that could not be made is recorded with its reason and the head stays what it was.

const G = require('../core/git.cjs');

const MSG_MAX = 72;

// The commit subject: the hand-back summary's first non-empty line, controls removed, cut; else a fixed line naming the worker.
function subjectOf(task, workerId) {
  const s = task && task.handoff && task.handoff.result && typeof task.handoff.result.summary === 'string' ? task.handoff.result.summary : '';
  const line = s.split(/\r?\n/).map((x) => x.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).find((x) => x) || '';
  return (line.length > MSG_MAX ? `${line.slice(0, MSG_MAX - 3).trimEnd()}...` : line) || `codex worker ${workerId}: hand-back`;
}

const norm = (p) => { const x = String(p || '').replace(/\\/g, '/').replace(/\/+$/, ''); return process.platform === 'win32' ? x.toLowerCase() : x; };

// -> the commit fact to record: { made, head, branch, files?, message?, error? }, or null when this hand-back is not belay's to commit
// (not a Codex worker, or the task has no belay worktree). Never throws.
async function commitFor(w, task) {
  if (!w || w.substrate !== 'codex') return null;
  const rec = task && task.worktree;
  if (!rec || !rec.path || rec.removed_at) return null;
  const branch = rec.branch || null;
  const fact = (o) => ({ made: false, branch, ...o });
  try {
    if (w.worktree && norm(w.worktree) !== norm(rec.path)) return fact({ head: null, error: `worker ${w.id} runs in ${w.worktree}, not in the task's worktree ${rec.path}; nothing was committed` });
    const cwd = rec.path;
    const sym = await G.run(cwd, ['symbolic-ref', '-q', 'HEAD']);
    const on = sym.ok ? sym.stdout.trim() : '';
    const head0 = await G.run(cwd, ['rev-parse', 'HEAD']);
    const head = head0.ok ? head0.stdout.trim() : null;
    if (!on) return fact({ head, error: 'HEAD is detached in the worktree; nothing was committed' });
    if (!branch || on !== `refs/heads/${branch}`) return fact({ head, error: `the worktree is on ${on.replace(/^refs\/heads\//, '')}, not on the task's branch ${branch}; nothing was committed` });
    const dirty = await G.dirtyPaths(cwd);
    if (!dirty.length) return fact({ head });
    const add = await G.run(cwd, ['add', '-A']);
    if (!add.ok) return fact({ head, error: `git add failed: ${add.stderr || `exit ${add.exit_code}`}` });
    const message = subjectOf(task, w.id);
    const c = await G.run(cwd, ['commit', '-m', message]);
    if (!c.ok) return fact({ head, error: `git commit failed: ${(c.stderr || `exit ${c.exit_code}`).slice(0, 300)}` });
    const h = await G.run(cwd, ['rev-parse', 'HEAD']);
    if (!h.ok || !h.stdout.trim() || h.stdout.trim() === head) return fact({ head, error: 'git commit reported success but HEAD did not move' });
    return { made: true, head: h.stdout.trim(), branch, files: dirty.length, message };
  } catch (e) {
    return fact({ head: null, error: `${(e && e.message) || e}`.slice(0, 300) });
  }
}

// Commits for the Codex worker `w` that released `taskId`, and records it. -> the recorded commit, or null. Never throws: a recording
// that fails is a worker lastError, and the evaluation goes on (it reports uncommitted work itself).
async function handBack(w, ctx, taskId) {
  if (!w || w.substrate !== 'codex' || !ctx.core || !ctx.core.task || typeof ctx.core.task.recordCommit !== 'function') return null;
  try {
    const task = await ctx.core.task.get({ task_id: taskId });
    if (!task || task.state !== 'released' || !task.handoff || task.handoff.by !== w.id) return null;
    const commit = await commitFor(w, task);
    if (!commit) return null;
    await ctx.core.task.recordCommit({ task_id: taskId, worker_id: w.id, lease_id: task.handoff.lease_id, commit });
    return commit;
  } catch (e) {
    w.lastError = { where: 'handback-commit', code: e && e.code, message: e && e.message };
    return null;
  }
}

module.exports = { commitFor, handBack, subjectOf };
