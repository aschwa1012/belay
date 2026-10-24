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

const MAX_TASKS = 50;

const view = (r) => (r ? { ...r, created_worktree: r.created_worktree == null ? null : !!r.created_worktree, passed: r.passed == null ? null : !!r.passed } : null);

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
async function integrationTree(E, repo, into, args, tasks) {
  const found = (await G.worktrees(repo)).find((w) => w.branch === into);
  if (found) {
    const d = await G.dirtyPaths(found.path);
    if (d.length) throw err('E_PRECONDITION', `${into} is checked out at ${found.path} with ${d.length} uncommitted path(s); belay merges only into a clean tree`, { path: found.path, dirty: d.slice(0, 50) });
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
  if ((await G.run(tree, ['merge-base', '--is-ancestor', sha, 'HEAD'])).ok) return { ok: true, task_id: task.id, branch: b, sha, already: true };
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

// A command's cwd inside the task's own worktree is moved to the same place in the integration tree.
function cwdFor(c, task, tree) {
  if (!c.cwd) return tree;
  if (!path.isAbsolute(c.cwd)) return G.fwd(path.resolve(tree, c.cwd));
  const own = task.worktree && task.worktree.path;
  const rel = own ? path.relative(own, c.cwd) : null;
  if (rel !== null && !rel.startsWith('..') && !path.isAbsolute(rel)) return G.fwd(path.join(tree, rel));
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
  checkArgs(args);
  const { tasks, repo } = await readTasks(E, args.task_ids);
  const into = await G.validBranch(repo, args.into === undefined ? `belay/integrate/${caller.run_id}` : args.into);
  return W.exclusive(`integrate:${repo}:${into}`, `an integration into ${into}`, async () => {
    const tree = await integrationTree(E, repo, into, args, tasks);
    const by = E.writtenBy(caller);
    const baseSha = (await G.must(tree.path, ['rev-parse', 'HEAD'], 'HEAD of the integration tree')).trim();
    const base = {
      id: rows.newId(), run_id: caller.run_id, repo, into_branch: into, worktree: tree.path, created_worktree: tree.created,
      base_sha: baseSha, head_sha: baseSha, task_ids: args.task_ids, merged: [], conflict: null, error: null, checks: null, passed: null, junctions: tree.junctions, removed_at: null,
    };
    E.store.tx(() => { E.assertRunOpen(caller, 'integration.merge'); rows.append(E.store, 'integration', { ...base, state: 'merging' }, by, Date.now()); });
    E.noteWrite();
    const out = { ...base, state: 'merged' };
    try {
      for (const t of tasks) {
        const m = await mergeOne(tree.path, t);
        if (!m.ok) {
          const { ok, conflict, stderr, ...rest } = m;
          if (conflict) { out.state = 'conflict'; out.conflict = rest; } else { out.state = 'failed'; out.error = { ...rest, message: `the merge of ${t.id} failed without a conflict: ${String(stderr).split('\n')[0]}`, stderr }; }
          break;
        }
        out.merged.push({ task_id: m.task_id, branch: m.branch, sha: m.sha, already: m.already });
      }
      out.head_sha = (await G.must(tree.path, ['rev-parse', 'HEAD'], 'HEAD of the integration tree')).trim();
      if (out.state === 'merged' && args.evaluate !== false) {
        out.checks = await rerun(tasks, tree.path);
        out.passed = out.checks.length > 0 ? out.checks.every((c) => c.passed) : null;
        if (!out.checks.length) out.error = { message: 'the merged tasks declare no acceptance commands, so nothing was re-run and nothing is proven' };
        out.state = 'evaluated';
      }
    } catch (e) {
      out.state = 'failed';
      out.error = { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail || null };
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
  const cur = await get(E, caller, args);
  if (args.force !== undefined && typeof args.force !== 'boolean') throw err('E_ARGS', 'integration.remove: force must be a boolean', { field: 'force' });
  if (!cur.created_worktree) throw err('E_PRECONDITION', `integration ${cur.id} merged in ${cur.worktree}, a tree belay did not make, so belay does not remove it`, { id: cur.id, worktree: cur.worktree });
  if (cur.removed_at) throw err('E_NOT_FOUND', `integration ${cur.id}'s worktree was removed at ${cur.removed_at}`, { id: cur.id });
  if (cur.state === 'merging') throw err('E_BUSY', `integration ${cur.id} is still merging`, { id: cur.id });
  return W.exclusive(`integrate:${cur.repo}:${cur.into_branch}`, `an integration call for ${cur.into_branch}`, async () => {
    const removal = await W.removeTree(E, { repo: cur.repo, path: cur.worktree, junctions: cur.junctions, branch: cur.into_branch }, { force: args.force }, `integration ${cur.id}`);
    const row = E.store.tx(() => rows.append(E.store, 'integration', { ...rows.current(E.store, 'integration', cur.id), removed_at: Date.now() }, E.writtenBy(caller), Date.now()));
    E.noteWrite();
    return { ...view(row), removal };
  });
}

module.exports = { merge, list, get, remove };
