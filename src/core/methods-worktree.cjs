'use strict';
// methods-worktree.cjs — a worktree and branch per task, made and removed by belay (ADR 0053 decisions 1 to 4). The task row
// records { repo, path, branch, base_ref, base_sha, junctions, ... } in its `worktree` column; task.evaluate judges from that
// base. git runs with fixed argv (git.cjs). A junction is unlinked, after lstat shows it is a link, before git removes the
// tree, because a recursive delete follows a junction into the main checkout (the repository's own CLAUDE.md rule).

const fs = require('node:fs');
const path = require('node:path');
const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const { pidAlive } = require('./lock.cjs');
const G = require('./git.cjs');
const { isPathId, pathIdMessage } = require('./path-id.cjs');

const DEFAULT_JUNCTIONS = ['node_modules'];
const TERMINAL_WORKER = new Set(['stopped', 'dead', 'forgotten']);

// One create or remove per task at a time, in the owner's process (the only process that serves writes).
const inFlight = new Set();
async function exclusive(key, what, fn) {
  if (inFlight.has(key)) throw err('E_BUSY', `${what} is already in flight; nothing was done`, { key });
  inFlight.add(key);
  try { return await fn(); } finally { inFlight.delete(key); }
}

// A name that becomes a path component must pass the one id grammar (path-id.cjs); it is refused, never rewritten, so two ids
// can never be folded onto one tree.
function pathName(name, field) {
  if (!isPathId(name)) throw err('E_ARGS', `${pathIdMessage(field, name)}; it would name a worktree directory`, { [field]: name });
  return name;
}
const active = (task) => (task && task.worktree && task.worktree.path && !task.worktree.removed_at ? task.worktree : null);

function requireTask(E, id, method) {
  if (!id || typeof id !== 'string') throw err('E_ARGS', `${method} needs a task_id`);
  const t = rows.current(E.store, 'task', id);
  if (!t) throw err('E_NOT_FOUND', `no task row exists for ${id}`, { task_id: id });
  return t;
}

// The repository a call acts on: the argument, else the caller's run row's project_dir (the run's config directory).
async function repoOf(E, caller, repo, method) {
  let dir = repo;
  if (dir === undefined || dir === null) {
    const run = rows.current(E.store, 'run', caller.run_id);
    dir = run && run.project_dir;
    if (!dir) throw err('E_ARGS', `${method} needs repo: run ${caller.run_id} records no project directory to default to`, { run_id: caller.run_id });
  }
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw err('E_ARGS', `${method}: repo must be an absolute path`, { repo: dir });
  return G.toplevel(dir);
}

function junctionList(junction) {
  const list = junction === undefined || junction === null ? DEFAULT_JUNCTIONS : junction;
  if (!Array.isArray(list) || list.some((j) => typeof j !== 'string' || !j || path.isAbsolute(j) || j.split(/[\\/]/).includes('..'))) {
    throw err('E_ARGS', 'junction must be an array of repository-relative directory names without ..', { junction });
  }
  return list;
}

// Makes each junction (a directory symlink off Windows) whose source exists, keeps it only if git ignores it in the new tree.
// `made` is filled as each link is made, so a failure part way leaves the caller's rollback a full list to unlink.
async function makeJunctions(top, wtPath, list, made = [], skipped = []) {
  for (const rel of list) {
    const target = path.join(top, rel), link = path.join(wtPath, rel);
    if (!fs.existsSync(target)) { skipped.push({ path: rel, reason: 'the repository has no such directory' }); continue; }
    if (fs.existsSync(link)) { skipped.push({ path: rel, reason: 'the worktree already has this path from git' }); continue; }
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    const ignored = await G.run(wtPath, ['check-ignore', '-q', '--', rel]);
    if (!ignored.ok) {
      fs.unlinkSync(link);
      skipped.push({ path: rel, reason: 'git does not ignore it here, so git status would list its contents' });
      continue;
    }
    made.push({ path: G.fwd(link), target: G.fwd(target) });
  }
  return { made, skipped };
}

// Each recorded junction must be a link or gone; a real directory there is refused before anything is removed.
function checkJunctions(junctions) {
  for (const j of junctions || []) {
    let st;
    try { st = fs.lstatSync(j.path); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (!st.isSymbolicLink()) throw err('E_PRECONDITION', `${j.path} is recorded as a junction but is not a link now; belay removes nothing under it`, { path: j.path });
  }
}

function unlinkJunctions(junctions) {
  const unlinked = [];
  for (const j of junctions || []) {
    let st;
    try { st = fs.lstatSync(j.path); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (!st.isSymbolicLink()) throw err('E_PRECONDITION', `${j.path} is not a link; belay removes nothing under it`, { path: j.path });
    fs.unlinkSync(j.path);
    if (fs.existsSync(j.path)) throw err('E_INTERNAL', `${j.path} is still there after its unlink`, { path: j.path });
    unlinked.push(j.path);
  }
  return unlinked;
}

// A worker row that still works in `dir`: not terminal, and parked or alive by its pid.
function liveWorkerIn(E, dir) {
  return rows.currentAll(E.store, 'worker').find((w) => w.worktree && G.samePath(w.worktree, dir) && !TERMINAL_WORKER.has(w.state)
    && (w.state === 'paused' || (w.pid != null && pidAlive(w.pid)))) || null;
}

// Unlinks the junctions, removes the tree and (unless `keepBranch`, for a branch belay did not make) the branch; never throws,
// returns what happened.
async function rollback(top, rec, { keepBranch = false } = {}) {
  const out = { junctions: [], worktree_removed: false, branch_deleted: false };
  try { out.junctions = unlinkJunctions(rec.junctions); } catch (e) { out.junction_error = e.message; return out; }
  const r = await G.run(top, ['worktree', 'remove', '--force', '--', rec.path]);
  out.worktree_removed = r.ok;
  if (!r.ok) out.worktree_error = r.stderr;
  else if (!keepBranch) out.branch_deleted = (await G.run(top, ['branch', '-D', '--', rec.branch])).ok;
  return out;
}

async function worktreeCreate(E, caller, args) {
  requireTask(E, args.task_id, 'task.worktreeCreate');
  if (args.path !== undefined && caller.role !== 'operator') throw err('E_ROLE', 'task.worktreeCreate: an explicit path is the operator\'s; the orchestrator takes the default', { field: 'path' });
  const junctions = junctionList(args.junction);
  return exclusive(`task:${args.task_id}`, `a worktree call for task ${args.task_id}`, async () => {
    const task = requireTask(E, args.task_id, 'task.worktreeCreate');
    if (task.state === 'done') throw err('E_TASK_DONE', `task ${task.id} is done, so it gets no new worktree`, { task_id: task.id, state: 'done' });
    const had = active(task);
    if (had) throw err('E_EXISTS', `task ${task.id} already has worktree ${had.path} on branch ${had.branch}`, { task_id: task.id, worktree: had });
    const top = await repoOf(E, caller, args.repo, 'task.worktreeCreate');
    const baseRef = args.base === undefined ? 'HEAD' : args.base;
    const baseSha = await G.commitOf(top, baseRef);
    const dirName = args.path === undefined ? pathName(task.id, 'task_id') : null;
    const branch = await G.validBranch(top, args.branch === undefined ? `belay/${task.id}` : args.branch);
    if (await G.branchExists(top, branch)) throw err('E_EXISTS', `branch ${branch} already exists; name another or remove it`, { branch });
    const wtPath = G.fwd(args.path !== undefined ? path.resolve(args.path) : path.join(path.dirname(top), `${path.basename(top)}.worktrees`, dirName));
    if (fs.existsSync(wtPath) && fs.readdirSync(wtPath).length) throw err('E_EXISTS', `${wtPath} exists and is not empty`, { path: wtPath });
    await G.must(top, ['worktree', 'add', '-b', branch, '--', wtPath, baseSha], `the worktree for task ${task.id} could not be added`);
    const rec = { repo: top, path: wtPath, branch, base_ref: baseRef, base_sha: baseSha, junctions: [], junctions_skipped: [], created_at: Date.now(), created_by: E.writtenBy(caller), removed_at: null };
    try {
      await makeJunctions(top, wtPath, junctions, rec.junctions, rec.junctions_skipped);
      const row = E.store.tx(() => {
        E.assertRunOpen(caller, 'task.worktreeCreate');
        const fresh = rows.current(E.store, 'task', task.id);
        if (fresh.state === 'done' || active(fresh)) throw err('E_EXISTS', `task ${task.id} changed while its worktree was made`, { task_id: task.id, state: fresh.state });
        return rows.append(E.store, 'task', { ...fresh, worktree: rec }, E.writtenBy(caller), Date.now());
      });
      E.noteWrite();
      return row;
    } catch (e) {
      const undone = await rollback(top, rec);
      e.detail = { ...(e.detail || {}), rollback: undone };
      throw e;
    }
  });
}

async function worktreeRemove(E, caller, args) {
  requireTask(E, args.task_id, 'task.worktreeRemove');
  for (const k of ['force', 'delete_branch']) if (args[k] !== undefined && typeof args[k] !== 'boolean') throw err('E_ARGS', `task.worktreeRemove: ${k} must be a boolean`, { field: k });
  return exclusive(`task:${args.task_id}`, `a worktree call for task ${args.task_id}`, async () => {
    const task = requireTask(E, args.task_id, 'task.worktreeRemove');
    const rec = active(task);
    if (!rec) throw err('E_NOT_FOUND', `task ${task.id} has no belay worktree to remove`, { task_id: task.id, worktree: task.worktree || null });
    const out = await removeTree(E, rec, args, `task ${task.id}`);
    // No second run-open check here: the tree is already gone, and a row that still named it would be the false one.
    const row = E.store.tx(() => {
      const fresh = rows.current(E.store, 'task', task.id);
      const done = { ...rec, removed_at: Date.now(), removed_by: E.writtenBy(caller), forced: out.forced, already_gone: out.already_gone, branch_deleted: out.branch_deleted };
      return rows.append(E.store, 'task', { ...fresh, worktree: done }, E.writtenBy(caller), Date.now());
    });
    E.noteWrite();
    return { ...row, removal: out };
  });
}

// The shared removal (a task's tree, or an integration's): refuses a live worker in it and a dirty tree unless force,
// unlinks the junctions, removes the tree, and with delete_branch deletes the branch the safe way.
async function removeTree(E, rec, args, what) {
  const w = liveWorkerIn(E, rec.path);
  if (w) throw err('E_WORKER_LIVE', `worker ${w.id} (${w.state}) works in ${rec.path}; stop it before removing ${what}'s worktree`, { worker_id: w.id, state: w.state, path: rec.path });
  checkJunctions(rec.junctions);
  const out = { junctions_unlinked: [], forced: args.force === true, already_gone: false, branch_deleted: false };
  if (!fs.existsSync(rec.path)) {
    out.already_gone = true;
  } else {
    const dirty = await G.dirtyPaths(rec.path);
    if (dirty.length && args.force !== true) throw err('E_PRECONDITION', `${what}'s worktree has ${dirty.length} uncommitted path(s); commit them, or pass force to discard them`, { path: rec.path, dirty: dirty.slice(0, 50) });
    out.junctions_unlinked = unlinkJunctions(rec.junctions);
    await G.must(rec.repo, ['worktree', 'remove', ...(args.force === true ? ['--force'] : []), '--', rec.path], `${what}'s worktree could not be removed`);
    if (fs.existsSync(rec.path)) throw err('E_INTERNAL', `${rec.path} is still there after git removed the worktree`, { path: rec.path });
  }
  if (args.delete_branch === true && rec.branch) {
    const r = await G.run(rec.repo, ['branch', '-d', '--', rec.branch]);
    out.branch_deleted = r.ok;
    if (!r.ok) out.branch_kept = `git branch -d refused: ${r.stderr.split('\n')[0]}`;
  }
  return out;
}

// task.evaluate's worktree and base (ADR 0053 decision 4): the arguments when given, else the task's recorded worktree and base.
function evaluateTarget(task, args) {
  const rec = task.worktree && task.worktree.base_sha ? task.worktree : null;
  const worktree = args.worktree !== undefined ? args.worktree : (active(task) || {}).path;
  if (!worktree || typeof worktree !== 'string') throw err('E_ARGS', `task.evaluate needs the worktree the acceptance criteria run in; task ${task.id} has no belay worktree to default to`, { task_id: task.id });
  if (args.base !== undefined) return { worktree, base: args.base, baseSource: 'arg' };
  return rec ? { worktree, base: rec.base_sha, baseSource: 'recorded' } : { worktree, base: undefined, baseSource: undefined };
}

module.exports = { worktreeCreate, worktreeRemove, removeTree, rollback, makeJunctions, junctionList, repoOf, evaluateTarget, exclusive, active, pathName, liveWorkerIn };
