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
// An optional argument sent as null is taken as absent, as the MCP boundary does for most tools.
const present = (args) => Object.fromEntries(Object.entries(args || {}).filter(([, v]) => v !== null && v !== undefined));
const active = (task) => (task && task.worktree && task.worktree.path && !task.worktree.removed_at ? task.worktree : null);

const ENDED_TASK = new Set(['done', 'cancelled']);
const removing = new Map(); // tree path (lower case) -> { task_id, done }: a task.worktreeRemove in flight
// The other tasks whose recorded, not removed, tree is `dir`: a fix task and the work it fixes share one.
const sharers = (E, id, dir) => rows.currentAll(E.store, 'task').filter((t) => t.id !== id && active(t) && G.samePath(active(t).path, dir));
// The first other task that is not done or cancelled and shares `task`'s tree or its branch (a fix works on the work's branch, so
// merging or removing either one takes the other's unreviewed commits with it), or null.
function openSharer(E, task) {
  const rec = task.worktree;
  if (!rec || !rec.branch) return null;
  const tree = active(task);
  return rows.currentAll(E.store, 'task').find((t) => t.id !== task.id && !ENDED_TASK.has(t.state) && t.worktree && (
    (t.worktree.branch === rec.branch && G.samePath(t.worktree.repo, rec.repo)) || (tree && active(t) && G.samePath(active(t).path, tree.path)))) || null;
}

function requireTask(E, id, method) {
  if (!id || typeof id !== 'string') throw err('E_ARGS', `${method} needs a task_id`);
  const t = rows.current(E.store, 'task', id);
  if (!t) throw err('E_NOT_FOUND', `no task row exists for ${id}`, { task_id: id });
  return t;
}

// The repository a call acts on: the argument, else the caller's run row's project_dir (the run's config directory). The
// orchestrator is held to its run's repository: a repo whose top level is another one is refused (check finding 4), and a run
// that records no project directory gives it none to act on. The operator may name any repository.
async function repoOf(E, caller, repo, method) {
  const run = rows.current(E.store, 'run', caller.run_id);
  const own = run && run.project_dir;
  if (caller.role !== 'operator' && !own) throw err('E_ARGS', `${method}: run ${caller.run_id} records no project directory, so the orchestrator has no repository to act on; the operator starts belay run from the repository, beside its belay.config.json`, { run_id: caller.run_id });
  const dir = repo === undefined ? own : repo;
  if (!dir) throw err('E_ARGS', `${method} needs repo: run ${caller.run_id} records no project directory to default to; pass --repo <dir>`, { run_id: caller.run_id });
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw err('E_ARGS', `${method}: repo must be an absolute path`, { repo: dir });
  const top = await G.toplevel(dir);
  if (caller.role !== 'operator' && repo !== undefined) {
    const runTop = await G.toplevel(own);
    if (!G.samePath(top, runTop)) throw err('E_ROLE', `${method}: ${top} is not this run's repository (${runTop}); another repository is the operator's to name`, { repo: top, run_repo: runTop });
  }
  return top;
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

// A worker row that still works in `dir` or a directory under it: not terminal, and parked (no process, but its session will
// resume there) or alive by its pid.
const under = (p, dir) => { const a = G.fwd(p).replace(/\/+$/, ''), b = G.fwd(dir).replace(/\/+$/, ''); return G.samePath(a, b) || G.samePath(a.slice(0, b.length + 1), `${b}/`); };
function liveWorkerIn(E, dir) {
  return rows.currentAll(E.store, 'worker').find((w) => w.worktree && under(w.worktree, dir) && !TERMINAL_WORKER.has(w.state)
    && (w.state === 'paused' || (w.pid != null && pidAlive(w.pid)))) || null;
}

// Every link in the tree that belay did not record (a worker's own junction, a package manager's symlink), found by lstat and
// never followed. Each is unlinked before git removes the tree: an unlink takes the link alone and never its target, and a link
// left in place stops git removing the directory (git exits 0 and leaves it). The .git file of a linked worktree is a file.
function strayLinks(root, recorded) {
  const known = new Set((recorded || []).map((j) => G.fwd(j.path).toLowerCase()));
  const found = [], stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of entries) {
      const p = G.fwd(path.join(dir, d.name));
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) { if (!known.has(p.toLowerCase())) found.push({ path: p }); continue; }
      if (st.isDirectory() && d.name !== '.git') stack.push(p);
    }
  }
  return found;
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

// A task that is leased or released has a worker already working, or its work handed back, in the worker's directory; a tree made
// now would be one the work is not in, and its evaluation would judge it there (ADR 0058 amendment 1). Refused, naming the holder.
function assertNotLeased(E, task) {
  const l = rows.currentLeaseForTask(E.store, task.id);
  const live = l && !l.released_at ? l : null;
  if (!live && task.state !== 'assigned' && task.state !== 'released') return;
  const who = live ? `${live.holder_role} ${live.holder} holds lease ${live.id} on it` : `it is ${task.state}${l && l.holder ? `, last held by ${l.holder_role} ${l.holder}` : ''}`;
  throw err('E_PRECONDITION', `task ${task.id} gets no worktree once it is leased or released: ${who}, and that work is in the holder's directory; create a new task for work in a new tree`,
    { task_id: task.id, state: task.state, holder: l ? l.holder : null, holder_role: l ? l.holder_role : null, lease_id: l ? l.id : null, lease_released: l ? !!l.released_at : null });
}

// This process's creation time from the process snapshot, for an integration row's `owner_boot` (ADR 0053 amendment 2). The
// probe never waits (ADR 0048 decision 3): the first worktree or integration call this owner serves starts it, so it has
// normally settled before the first merge, which needs a task worktree first; a merge before then records null, as a
// snapshot that cannot be read does. An owner told its own creation time at start uses that instead. Only a long-lived
// owner (`ownerOpts.longLived`: the run's, or an orchestrator adapter's) starts the probe: its snapshot child holds the
// event loop, so a CLI write's owner would wait for it before exiting (up to the snapshot timeout). Any other owner records
// null, which a later check reads as not proven.
const NO_BOOT = async () => null;
let ownProbe = null;
function ownBootProbe(E) {
  const o = E && E.owner && E.owner.opts ? E.owner.opts : null;
  if (o && Number.isFinite(o.created)) return async () => o.created;
  if (!o || o.longLived !== true) return NO_BOOT;
  if (!ownProbe) ownProbe = require('./proc-identity.cjs').ownCreatedProbe(process.pid);
  return ownProbe;
}
const ownBoot = (E) => ownBootProbe(E)();

async function worktreeCreate(E, caller, args) {
  ownBootProbe(E);
  requireTask(E, args.task_id, 'task.worktreeCreate');
  args = present(args);
  if (args.path !== undefined && caller.role !== 'operator') throw err('E_ROLE', 'task.worktreeCreate: an explicit path is the operator\'s; the orchestrator takes the default', { field: 'path' });
  // A junction is a link out of the tree; only the operator names one (check finding 4). The orchestrator gets node_modules.
  if (args.junction !== undefined && caller.role !== 'operator') throw err('E_ROLE', 'task.worktreeCreate: junction is the operator\'s; the orchestrator takes the default node_modules', { field: 'junction' });
  const junctions = junctionList(args.junction);
  return exclusive(`task:${args.task_id}`, `a worktree call for task ${args.task_id}`, async () => {
    const task = requireTask(E, args.task_id, 'task.worktreeCreate');
    if (task.state === 'done') throw err('E_TASK_DONE', `task ${task.id} is done, so it gets no new worktree`, { task_id: task.id, state: 'done' });
    assertNotLeased(E, task);
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
        assertNotLeased(E, fresh); // an assign that landed while the tree was made
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
  ownBootProbe(E);
  args = present(args);
  requireTask(E, args.task_id, 'task.worktreeRemove');
  for (const k of ['force', 'delete_branch']) if (args[k] !== undefined && typeof args[k] !== 'boolean') throw err('E_ARGS', `task.worktreeRemove: ${k} must be a boolean`, { field: k });
  return exclusive(`task:${args.task_id}`, `a worktree call for task ${args.task_id}`, async () => {
    let task = requireTask(E, args.task_id, 'task.worktreeRemove');
    const key = G.fwd(task.worktree && task.worktree.path ? task.worktree.path : '').toLowerCase();
    // A sharer's removal of this same tree in flight is waited for: this call then reports it already removed, never a second git.
    if (active(task) && removing.has(key)) {
      const by = removing.get(key).task_id;
      await removing.get(key).done.catch(() => {});
      task = requireTask(E, args.task_id, 'task.worktreeRemove');
      if (!active(task)) return { ...task, removal: { already: true, removed_through: by } };
    }
    // Removed already, through a task that shares the tree: the same answer, whichever call came first.
    if (!active(task) && task.worktree && task.worktree.removed_through) return { ...task, removal: { already: true, removed_through: task.worktree.removed_through } };
    const rec = active(task);
    if (!rec) throw err('E_NOT_FOUND', `task ${task.id} has no belay worktree to remove`, { task_id: task.id, worktree: task.worktree || null });
    // A fix task shares the tree and branch of the work it fixes (task.fixFromReview): one still being worked keeps the tree.
    const open = openSharer(E, task);
    if (open) throw err('E_PRECONDITION', `task ${open.id} (${open.state}) is worked in the same tree or branch ${rec.path}; finish or cancel it first`, { task_id: open.id, state: open.state, path: rec.path });
    let finish;
    removing.set(key, { task_id: task.id, done: new Promise((r) => { finish = r; }) });
    try { return await removeShared(E, caller, args, task, rec); } finally { removing.delete(key); finish(); }
  });
}

// Removes the tree and records the removal on the task and on every task that shares the tree.
async function removeShared(E, caller, args, task, rec) {
  const out = await removeTree(E, rec, args, `task ${task.id}`);
  // No second run-open check here: the tree is already gone, and a row that still named it would be the false one.
  const row = E.store.tx(() => {
    const done = { ...rec, removed_at: Date.now(), removed_by: E.writtenBy(caller), forced: out.forced, already_gone: out.already_gone, branch_deleted: out.branch_deleted, leftover: out.leftover };
    for (const s of sharers(E, task.id, rec.path)) rows.append(E.store, 'task', { ...s, worktree: { ...s.worktree, ...done, inherited_from: s.worktree.inherited_from, removed_through: task.id } }, E.writtenBy(caller), Date.now());
    const fresh = rows.current(E.store, 'task', task.id);
    return rows.append(E.store, 'task', { ...fresh, worktree: done }, E.writtenBy(caller), Date.now());
  });
  E.noteWrite();
  return { ...row, removal: out };
}

// The shared removal (a task's tree, or an integration's): refuses a live worker in it and a dirty tree unless force,
// unlinks the junctions, removes the tree, and with delete_branch deletes the branch the safe way.
async function removeTree(E, rec, args, what) {
  const w = liveWorkerIn(E, rec.path);
  if (w) throw err('E_WORKER_LIVE', `worker ${w.id} (${w.state}) works in ${rec.path}; stop it before removing ${what}'s worktree`, { worker_id: w.id, state: w.state, path: rec.path });
  checkJunctions(rec.junctions);
  const out = { junctions_unlinked: [], links_unlinked: [], forced: args.force === true, already_gone: false, leftover: false, branch_deleted: false };
  const listed = async () => (await G.worktrees(rec.repo)).some((x) => G.samePath(x.path, rec.path));
  if (!fs.existsSync(rec.path)) {
    out.already_gone = true;
  } else if (!(await listed())) {
    // git no longer knows this tree (an earlier remove it could not finish): nothing git could do is left, so it is recorded.
    out.leftover = true;
    out.leftover_note = `git no longer lists ${rec.path} as a worktree; the directory is left on disk and belay deleted nothing`;
  } else {
    const dirty = await G.dirtyPaths(rec.path);
    if (dirty.length && args.force !== true) throw err('E_PRECONDITION', `${what}'s worktree has ${dirty.length} uncommitted path(s); commit them, or pass force to discard them`, { path: rec.path, dirty: dirty.slice(0, 50) });
    out.junctions_unlinked = unlinkJunctions(rec.junctions);
    out.links_unlinked = unlinkJunctions(strayLinks(rec.path, rec.junctions));
    const r = await G.run(rec.repo, ['worktree', 'remove', ...(args.force === true ? ['--force'] : []), '--', rec.path]);
    // A failed remove that git still lists can be retried, so it is refused. One git has dropped (it deleted part of the tree,
    // then a file it could not delete stopped it) can never be retried: the removal is recorded, and what was left is named.
    if (!r.ok && (await listed())) throw G.failure(r, `${what}'s worktree could not be removed`);
    if (fs.existsSync(rec.path)) {
      out.leftover = true;
      out.leftover_note = `git dropped the worktree but left ${rec.path} on disk${r.ok ? '' : ` (${r.stderr.split('\n')[0]})`}; belay deleted nothing more`;
    }
  }
  if (args.delete_branch === true && rec.branch) {
    const r = await G.run(rec.repo, ['branch', '-d', '--', rec.branch]);
    out.branch_deleted = r.ok;
    if (!r.ok) out.branch_kept = `git branch -d refused: ${r.stderr.split('\n')[0]}`;
  }
  return out;
}

// A task with a belay worktree is worked and judged there and nowhere else (ADR 0058 amendment 1): a directory that is not that tree
// is refused, naming both, because a worker writes where it runs and its directory cannot change once it is running.
function assertTaskTree(task, dir, what, remedy) {
  const tree = active(task);
  if (!tree || !dir || G.samePath(path.resolve(dir), path.resolve(tree.path))) return;
  throw err('E_PRECONDITION', `task ${task.id} has its own worktree ${tree.path}, but ${what} is ${G.fwd(dir)}; ${remedy}`,
    { task_id: task.id, task_worktree: tree.path, worktree: G.fwd(dir) });
}

// task.evaluate's worktree and base (ADR 0053 decision 4): the arguments when given, else the task's recorded worktree and base.
// A worktree argument that is not the task's recorded tree is refused (assertTaskTree), whoever passes it.
function evaluateTarget(task, args) {
  const rec = task.worktree && task.worktree.base_sha ? task.worktree : null;
  if (args.worktree !== undefined) assertTaskTree(task, args.worktree, 'the worktree to evaluate in', 'leave worktree out to evaluate it in its own');
  const worktree = args.worktree !== undefined ? args.worktree : (active(task) || {}).path;
  if (!worktree || typeof worktree !== 'string') throw err('E_ARGS', `task.evaluate needs the worktree the acceptance criteria run in; task ${task.id} has no belay worktree to default to: pass worktree, or give the task its own with task_worktree`, { task_id: task.id });
  if (args.base !== undefined) return { worktree, base: args.base, baseSource: 'arg' };
  return rec ? { worktree, base: rec.base_sha, baseSource: 'recorded' } : { worktree, base: undefined, baseSource: undefined };
}

module.exports = { ownBoot, ownBootProbe, worktreeCreate, worktreeRemove, removeTree, rollback, makeJunctions, junctionList, repoOf, evaluateTarget, assertTaskTree, openSharer, exclusive, active, present, pathName, liveWorkerIn, strayLinks, under };
