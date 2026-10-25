'use strict';
// methods-integration.cjs — the explicit merge-and-evaluate step (ADR 0053 decision 5). Finished task branches are merged, in
// the order given, into an integration branch (never the default branch unless the caller names it), and the merged tasks'
// acceptance commands are re-run on the result. Conflict policy: stop and report: the merge is aborted, the tree is left
// clean, and the row names the task and the conflicting files. Every state is an appended `integration` row.

const fs = require('node:fs');
const path = require('node:path');
const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const G = require('./git.cjs');
const W = require('./methods-worktree.cjs');
const { runCommand, DEFAULT_COMMAND_TIMEOUT_MS } = require('./evaluate.cjs');
const { notMerged, stale } = require('./integration-state.cjs');
const { pidAlive } = require('./lock.cjs');
const ID = require('./proc-identity.cjs');

const MAX_TASKS = 50;

// `not_merged` is derived from the row, never stored.
const view = (r) => (r ? { ...r, created_worktree: r.created_worktree == null ? null : !!r.created_worktree, passed: r.passed == null ? null : !!r.passed, not_merged: notMerged(r), stale: stale(r) } : null);

// The process that wrote a `merging` row is gone, or is this one. A row this process wrote is not in flight, since the caller
// holds the in-process lock every merge into that branch holds. Another live pid may be an owner that was stopped without
// exiting (the adapter outlives it) whose git is still running, so only a pid that is gone, or now names a process created at
// another time than the row's `owner_boot` (a reused pid), is taken as gone. A creation time that cannot be read is not proof.
// A row from before the columns names no process, and nothing could be waited on. `owner_boot`, and the time it is compared
// with, both come from the process snapshot (createdOf), so no clock but the OS's creation times is involved.
const BOOT_SLACK_MS = 5000;
let ownCreated = null; // this process's creation time from the snapshot, cached once it has been read
async function ownBoot() {
  if (ownCreated == null) { const c = await ID.createdOf(process.pid).catch(() => null); if (c && c.created != null) ownCreated = c.created; }
  return ownCreated;
}

// -> { gone, proven, why }. `proven` (when not gone): the pid runs as the process the row names, created when it records.
async function ownerGone(r) {
  if (r.owner_pid == null) return { gone: true, why: 'the row names no process' };
  const pid = Number(r.owner_pid);
  if (pid === process.pid) return { gone: true, why: 'its pid is this process, which holds the lock, so no merge of it is running' };
  if (!pidAlive(pid)) return { gone: true, why: `pid ${pid} is not running` };
  const c = await ID.createdOf(pid).catch(() => null);
  if (c && r.owner_boot != null && Math.abs(c.created - Number(r.owner_boot)) > BOOT_SLACK_MS) return { gone: true, why: `pid ${pid} was created at ${c.created}, not at the row's ${r.owner_boot}` };
  if (c && r.owner_boot != null) return { gone: false, proven: true, why: `pid ${pid} is running, created at ${c.created} as the row records` };
  return { gone: false, proven: false, why: c ? `pid ${pid} is running and the row recorded no creation time to match it` : `pid ${pid} is running and its creation time could not be read` };
}

// Called holding the one lock for `integrate:<repo>:<into>`, which every merge into that branch holds while it runs in this, the
// only process that serves writes. A `merging` row for that branch whose process is gone (ownerGone) is closed `abandoned`
// (what it merged before it ended is unknown, and unchecked), and the ids are returned. One whose process is proven still to
// run refuses the call E_BUSY, since its git may still be merging. One whose pid runs but is not proven to be that process
// refuses too, unless the operator passes `take_over`: the pid may now belong to any process, so belay never suggests ending
// it, and only a person who knows no merge is running may say so.
async function abandonStale(E, caller, repo, into, takeOver = false) {
  const left = rows.currentAll(E.store, 'integration').filter((r) => r.state === 'merging' && r.into_branch === into && G.samePath(r.repo, repo));
  if (!left.length) return [];
  const taken = new Map();
  for (const r of left) {
    const o = await ownerGone(r);
    if (o.gone) continue;
    const detail = { id: r.id, owner_pid: r.owner_pid, owner_boot: r.owner_boot, why: o.why, proven: o.proven };
    if (o.proven) throw err('E_BUSY', `integration ${r.id} into ${into} is merging in pid ${r.owner_pid}, which is still running (${o.why}); wait for it to finish, or stop that belay owner`, detail);
    if (!takeOver) throw err('E_BUSY', `integration ${r.id} into ${into} was merging in pid ${r.owner_pid}; that pid is running but is not proven to be the merge (${o.why}), so belay will not take the branch over on its own. If no merge into ${into} is running, the operator can pass --take-over`, detail);
    taken.set(r.id, o.why);
  }
  E.store.tx(() => {
    for (const r of left) {
      const message = taken.has(r.id)
        ? `abandoned by the operator's take-over: pid ${r.owner_pid} was not proven to be the merge (${taken.get(r.id)}); what it merged into ${into} is unrecorded and unchecked`
        : `abandoned: the process that ran this integration (pid ${r.owner_pid}) ended mid-merge; what it merged into ${into} is unrecorded and unchecked`;
      rows.append(E.store, 'integration', { ...r, state: 'abandoned', error: { message, taken_over: taken.has(r.id) } }, E.writtenBy(caller), Date.now());
    }
  });
  E.noteWrite();
  return left.map((r) => r.id);
}

// `take_over` closes a `merging` row whose pid runs but is not proven to be the merge. It is the operator's alone: the
// orchestrator's tool does not list it, and core refuses it from any other role.
function checkTakeOver(caller, args, method) {
  if (args.take_over === undefined) return false;
  if (typeof args.take_over !== 'boolean') throw err('E_ARGS', `${method}: take_over must be a boolean`, { field: 'take_over' });
  if (args.take_over && caller.role !== 'operator') throw err('E_ROLE', `${method}: take_over is the operator's, never the ${caller.role}'s`, { field: 'take_over', role: caller.role });
  return args.take_over;
}

function checkArgs(args) {
  const ids = args.task_ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_TASKS || ids.some((x) => typeof x !== 'string' || !x)) {
    throw err('E_ARGS', `integration.merge needs task_ids: 1 to ${MAX_TASKS} task ids, in merge order`, { task_ids: ids });
  }
  if (new Set(ids).size !== ids.length) throw err('E_ARGS', 'integration.merge: task_ids names a task twice', { task_ids: ids });
  if (args.evaluate !== undefined && typeof args.evaluate !== 'boolean') throw err('E_ARGS', 'integration.merge: evaluate must be a boolean', { field: 'evaluate' });
  for (const k of ['into', 'base']) if (args[k] !== undefined && (typeof args[k] !== 'string' || !args[k])) throw err('E_ARGS', `integration.merge: ${k} must be a non-empty string`, { field: k });
}

// Every task done, with a recorded branch, in one repository, and its tree (if still there) clean.
async function readTasks(E, ids) {
  const tasks = ids.map((id) => {
    const t = rows.current(E.store, 'task', id);
    if (!t) throw err('E_NOT_FOUND', `no task row exists for ${id}`, { task_id: id });
    return t;
  });
  const notDone = tasks.filter((t) => t.state !== 'done').map((t) => ({ task_id: t.id, state: t.state }));
  if (notDone.length) throw err('E_PRECONDITION', `only done tasks are merged; not done: ${notDone.map((x) => `${x.task_id} (${x.state})`).join(', ')}`, { not_done: notDone });
  const noBranch = tasks.filter((t) => !t.worktree || !t.worktree.branch).map((t) => t.id);
  if (noBranch.length) throw err('E_PRECONDITION', `these tasks have no belay branch to merge: ${noBranch.join(', ')}`, { no_branch: noBranch });
  const repo = tasks[0].worktree.repo;
  const other = tasks.find((t) => !G.samePath(t.worktree.repo, repo));
  if (other) throw err('E_PRECONDITION', `task ${other.id}'s branch is in ${other.worktree.repo}, not ${repo}`, { task_id: other.id, repo: other.worktree.repo, expected: repo });
  const dirty = [];
  for (const t of tasks) {
    const a = W.active(t);
    if (a && fs.existsSync(a.path)) { const d = await G.dirtyPaths(a.path); if (d.length) dirty.push({ task_id: t.id, path: a.path, dirty: d.slice(0, 20) }); }
  }
  if (dirty.length) throw err('E_PRECONDITION', `a merge would leave uncommitted work behind in ${dirty.map((d) => d.task_id).join(', ')}; commit it first`, { dirty });
  return { tasks, repo };
}

// The tree the merge happens in: where `into` is checked out (it must be clean), else a new integration worktree.
async function integrationTree(E, repo, into, args, tasks, abandoned = []) {
  const found = (await G.worktrees(repo)).find((w) => w.branch === into);
  if (found) {
    // A worker working in that tree (or under it) would have the merge land under its edits (check finding 3).
    const w = W.liveWorkerIn(E, found.path);
    if (w) throw err('E_WORKER_LIVE', `worker ${w.id} (${w.state}) works in ${found.path}, where ${into} is checked out; belay does not merge under a live worker`, { worker_id: w.id, state: w.state, path: found.path });
    const d = await G.dirtyPaths(found.path);
    if (d.length) {
      // A tree an abandoned integration left mid-merge says how to get out, since nothing else will clear it.
      const out = abandoned.length ? `; integration ${abandoned.join(', ')} was abandoned mid-merge here: run git merge --abort in ${found.path}, or remove the tree (belay worktree remove --integration <id> --force)` : '';
      throw err('E_PRECONDITION', `${into} is checked out at ${found.path} with ${d.length} uncommitted path(s); belay merges only into a clean tree${out}`, { path: found.path, dirty: d.slice(0, 50), abandoned });
    }
    return { path: found.path, created: false, junctions: [] };
  }
  const wtPath = G.fwd(path.join(path.dirname(repo), `${path.basename(repo)}.worktrees`, W.pathName(`integrate-${into.replace(/\//g, '-')}`, 'into')));
  if (fs.existsSync(wtPath) && fs.readdirSync(wtPath).length) throw err('E_EXISTS', `${wtPath} exists and is not empty`, { path: wtPath });
  const existed = await G.branchExists(repo, into);
  if (existed) {
    await G.must(repo, ['worktree', 'add', '--', wtPath, into], `a worktree for ${into} could not be added`);
  } else {
    let base;
    if (args.base !== undefined) base = await G.commitOf(repo, args.base);
    else {
      const bases = [...new Set(tasks.map((t) => t.worktree.base_sha))];
      if (bases.length !== 1) throw err('E_ARGS', `the tasks were cut from ${bases.length} different bases, so ${into} needs a base`, { bases });
      base = bases[0];
    }
    await G.must(repo, ['worktree', 'add', '-b', into, '--', wtPath, base], `the integration worktree for ${into} could not be added`);
  }
  const made = [];
  try { await W.makeJunctions(repo, wtPath, W.junctionList(undefined), made); } catch (e) {
    e.detail = { ...(e.detail || {}), rollback: await W.rollback(repo, { path: wtPath, branch: into, junctions: made }, { keepBranch: existed }) };
    throw e;
  }
  return { path: wtPath, created: true, junctions: made };
}

// One merge. Returns { ok, ... } and on failure leaves the tree as it was before this merge.
async function mergeOne(tree, task) {
  const b = task.worktree.branch;
  const sha = (await G.must(tree, ['rev-parse', '--verify', `refs/heads/${b}^{commit}`], `branch ${b} of task ${task.id} does not resolve`)).trim();
  // A branch still at its recorded base holds no commit: it is contained already, and `empty` says why, so it is not read as merged work.
  const empty = sha === task.worktree.base_sha;
  if ((await G.run(tree, ['merge-base', '--is-ancestor', sha, 'HEAD'])).ok) return { ok: true, task_id: task.id, branch: b, sha, already: true, empty };
  const r = await G.run(tree, ['merge', '--no-ff', '--no-edit', '-m', `belay: merge task ${task.id} (${b})`, sha]);
  if (r.ok) return { ok: true, task_id: task.id, branch: b, sha, already: false, head_sha: (await G.must(tree, ['rev-parse', 'HEAD'], 'HEAD')).trim() };
  const u = await G.run(tree, ['diff', '--name-only', '--diff-filter=U', '-z']);
  const files = u.ok ? u.stdout.split('\0').filter(Boolean) : [];
  const merging = (await G.run(tree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).ok;
  const abort = merging ? await G.run(tree, ['merge', '--abort']) : null;
  const left = await G.dirtyPaths(tree).catch(() => null);
  return {
    ok: false, conflict: files.length > 0, task_id: task.id, branch: b, sha, files,
    aborted: abort ? abort.ok : false, tree_clean: Array.isArray(left) && left.length === 0, stderr: r.stderr,
  };
}

// A command's cwd inside the task's own worktree, or inside the repository's main checkout, is moved to the same place in the
// integration tree; any other absolute cwd is kept as written.
function cwdFor(c, task, tree) {
  if (!c.cwd) return tree;
  if (!path.isAbsolute(c.cwd)) return G.fwd(path.resolve(tree, c.cwd));
  for (const root of [task.worktree && task.worktree.path, task.worktree && task.worktree.repo]) {
    const rel = root ? path.relative(root, c.cwd) : null;
    if (rel !== null && !rel.startsWith('..') && !path.isAbsolute(rel)) return G.fwd(path.join(tree, rel));
  }
  return G.fwd(c.cwd);
}

async function rerun(tasks, tree) {
  const byKey = new Map();
  for (const t of tasks) {
    for (const c of (t.acceptance && Array.isArray(t.acceptance.commands) ? t.acceptance.commands : [])) {
      if (!c || !Array.isArray(c.argv) || !c.argv.length || c.argv.some((x) => typeof x !== 'string')) continue;
      const cwd = cwdFor(c, t, tree);
      const key = JSON.stringify([c.argv, cwd]);
      if (!byKey.has(key)) byKey.set(key, { argv: c.argv, cwd, timeout_ms: Number(c.timeout_ms) > 0 ? Number(c.timeout_ms) : DEFAULT_COMMAND_TIMEOUT_MS, task_ids: [] });
      byKey.get(key).task_ids.push(t.id);
    }
  }
  const checks = [];
  for (const c of byKey.values()) {
    const r = await runCommand(c.argv, c.cwd, c.timeout_ms);
    checks.push({
      argv: c.argv, cwd: c.cwd, task_ids: c.task_ids, executable: r.executable, exit_code: r.exit_code, ms: r.ms, timed_out: r.timed_out,
      passed: r.executable && r.exit_code === 0 && !r.timed_out, spawn_error: r.spawn_error || null, stdout_tail: r.stdout.slice(-400), stderr_tail: r.stderr.slice(-400),
    });
  }
  return checks;
}

async function merge(E, caller, args) {
  args = W.present(args);
  checkArgs(args);
  const takeOver = checkTakeOver(caller, args, 'integration.merge');
  const { tasks, repo } = await readTasks(E, args.task_ids);
  const into = await G.validBranch(repo, args.into === undefined ? `belay/integrate/${caller.run_id}` : args.into);
  return W.exclusive(`integrate:${repo}:${into}`, `an integration into ${into}`, async () => {
    const abandoned = await abandonStale(E, caller, repo, into, takeOver);
    const tree = await integrationTree(E, repo, into, args, tasks, abandoned);
    const by = E.writtenBy(caller);
    const baseSha = (await G.must(tree.path, ['rev-parse', 'HEAD'], 'HEAD of the integration tree')).trim();
    const base = {
      id: rows.newId(), run_id: caller.run_id, repo, into_branch: into, worktree: tree.path, created_worktree: tree.created,
      base_sha: baseSha, head_sha: baseSha, task_ids: args.task_ids, merged: [], conflict: null, error: null, checks: null, passed: null, junctions: tree.junctions, removed_at: null,
      owner_pid: process.pid, owner_boot: await ownBoot(), // who runs it, so a row a crash leaves `merging` reads stale
    };
    E.store.tx(() => { E.assertRunOpen(caller, 'integration.merge'); rows.append(E.store, 'integration', { ...base, state: 'merging' }, by, Date.now()); });
    E.noteWrite();
    const out = { ...base, state: 'merged' };
    let trying = null; // the task whose merge is under way, so a throw (a branch deleted meanwhile) is blamed on it
    try {
      for (const t of tasks) {
        trying = t;
        const m = await mergeOne(tree.path, t);
        if (!m.ok) {
          const { ok, conflict, stderr, ...rest } = m;
          if (conflict) { out.state = 'conflict'; out.conflict = rest; } else { out.state = 'failed'; out.error = { ...rest, message: `the merge of ${t.id} failed without a conflict: ${String(stderr).split('\n')[0]}`, stderr }; }
          break;
        }
        out.merged.push({ task_id: m.task_id, branch: m.branch, sha: m.sha, already: m.already, empty: !!m.empty });
        trying = null;
      }
    } catch (e) {
      const left = await G.dirtyPaths(tree.path).catch(() => null);
      out.state = 'failed';
      out.error = { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail || null, task_id: trying ? trying.id : null, tree_clean: Array.isArray(left) && left.length === 0 };
    }
    const head = await G.run(tree.path, ['rev-parse', 'HEAD']);
    if (head.ok) out.head_sha = head.stdout.trim();
    // What landed is checked even when the step stopped: a conflict, a failed merge or a throw keeps the merges before it on
    // `into`, so their checks run on that tree (when it is clean) and the row keeps its stopped state. Only `evaluate: false` or
    // a tree that is not clean leaves merged work unchecked, with checks null.
    const stop = out.conflict || out.error;
    if (args.evaluate !== false && out.merged.length && (!stop || stop.tree_clean === true)) {
      const landed = new Set(out.merged.map((m) => m.task_id));
      try {
        out.checks = await rerun(tasks.filter((t) => landed.has(t.id)), tree.path);
        out.passed = out.checks.length > 0 ? out.checks.every((c) => c.passed) : null;
        if (!stop) {
          if (!out.checks.length) out.error = { message: 'the merged tasks declare no acceptance commands, so nothing was re-run and nothing is proven' };
          out.state = 'evaluated';
        }
      } catch (e) {
        out.checks = null; out.passed = null;
        if (!stop) { out.state = 'failed'; out.error = { code: e.code || 'E_INTERNAL', message: `the checks could not be run: ${e.message}`, detail: e.detail || null }; }
      }
    }
    // The merges have happened whatever the run did meanwhile, so the row that records them is written without a second run check.
    const row = E.store.tx(() => rows.append(E.store, 'integration', out, by, Date.now()));
    E.noteWrite();
    return view(row);
  });
}

async function list(E, caller, args) {
  const all = rows.currentAll(E.store, 'integration').map(view);
  return { integrations: args && args.run_id ? all.filter((r) => r.run_id === args.run_id) : all };
}

async function get(E, caller, args) {
  if (!args.id) throw err('E_ARGS', 'integration.get needs an id');
  const r = rows.current(E.store, 'integration', args.id);
  if (!r) throw err('E_NOT_FOUND', `no integration row exists for ${args.id}`, { id: args.id });
  return view(r);
}

// Removes an integration worktree belay made (the branch stays: it is the integrated result).
async function remove(E, caller, args) {
  args = W.present(args);
  const cur = await get(E, caller, args);
  if (args.force !== undefined && typeof args.force !== 'boolean') throw err('E_ARGS', 'integration.remove: force must be a boolean', { field: 'force' });
  const takeOver = checkTakeOver(caller, args, 'integration.remove');
  if (!cur.created_worktree) throw err('E_PRECONDITION', `integration ${cur.id} merged in ${cur.worktree}, a tree belay did not make, so belay does not remove it`, { id: cur.id, worktree: cur.worktree });
  if (cur.removed_at) throw err('E_NOT_FOUND', `integration ${cur.id}'s worktree was removed at ${cur.removed_at}`, { id: cur.id });
  // A merge in flight holds this lock, so the call is refused E_BUSY; a `merging` row met inside it was left by a process that
  // ended, and is closed `abandoned` before its tree is removed.
  return W.exclusive(`integrate:${cur.repo}:${cur.into_branch}`, `an integration call for ${cur.into_branch}`, async () => {
    if (cur.state === 'merging') await abandonStale(E, caller, cur.repo, cur.into_branch, takeOver);
    const removal = await W.removeTree(E, { repo: cur.repo, path: cur.worktree, junctions: cur.junctions, branch: cur.into_branch }, { force: args.force }, `integration ${cur.id}`);
    const row = E.store.tx(() => rows.append(E.store, 'integration', { ...rows.current(E.store, 'integration', cur.id), removed_at: Date.now() }, E.writtenBy(caller), Date.now()));
    E.noteWrite();
    return { ...view(row), removal };
  });
}

module.exports = { merge, list, get, remove };
