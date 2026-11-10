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
const J = require('./judged.cjs');
const H = require('./git-hooks.cjs');
const { runCommand, outputTails, DEFAULT_COMMAND_TIMEOUT_MS, ACCEPTANCE_BUDGET_MS } = require('./evaluate.cjs');
const { notMerged, stale, checkName } = require('./integration-state.cjs');
const { pidAlive } = require('./lock.cjs');
const INC = require('./integration-incremental.cjs');
const ID = require('./proc-identity.cjs');
const MUG = require('./merge-user-gate.cjs');
const PS = require('./policy-stamp.cjs');
const { checkTakeOver, checkArgs, readTasks, policyGuard, standingMerge, mergedElsewhere, assertOwnBranch } = require('./integration-policy.cjs');
const { refuseCrossRun } = require('./cross-run.cjs');

// `not_merged` and `left_out` (each merged branch head past what was judged, ADR 0060 decision 4) are derived from the row, never stored.
const leftOut = (r) => { const l = (r.merged || []).filter((m) => m && m.left_out).map((m) => ({ task_id: m.task_id, ...m.left_out })); return l.length ? l : null; };
// `hook_changed_tree` (a hook changed what a merge wrote, git-hooks.cjs) is the first merged entry that carries one.
const hookChanged = (r) => { const m = (r.merged || []).find((x) => x && x.hook_changed_tree); return m ? { hook_changed_tree: m.hook_changed_tree } : {}; };
// `reused_checks` names each check that was not run because it passed at this very head (integration-incremental.cjs).
const reusedOf = (r) => { const l = (r.checks || []).filter((c) => c && c.reused_from).map((c) => ({ argv: c.argv, reused_from: c.reused_from })); return l.length ? { reused_checks: l } : {}; };
const view = (r) => (r ? { ...r, ...hookChanged(r), ...reusedOf(r), created_worktree: r.created_worktree == null ? null : !!r.created_worktree, passed: r.passed == null ? null : !!r.passed, not_merged: notMerged(r), stale: stale(r), left_out: leftOut(r) } : null);

// The process that wrote a `merging` row is gone, or is this one. A row this process wrote is not in flight, since the caller
// holds the in-process lock every merge into that branch holds. Another live pid may be an owner that was stopped without
// exiting (the adapter outlives it) whose git is still running, so only a pid that is gone, or now names a process created at
// another time than the row's `owner_boot` (a reused pid; the times are exact, ADR 0039), is taken as gone. A creation time that cannot be read is not proof.
// A row from before the columns names no process, and nothing could be waited on. `owner_boot` (methods-worktree.cjs ownBoot),
// and the time it is compared with, both come from the process snapshot, so no clock but the OS's creation times is involved.

// -> { gone, proven, why }. `proven` (when not gone): the pid runs as the process the row names, created when it records.
async function ownerGone(r) {
  if (r.owner_pid == null) return { gone: true, why: 'the row names no process' };
  const pid = Number(r.owner_pid);
  if (pid === process.pid) return { gone: true, why: 'its pid is this process, which holds the lock, so no merge of it is running' };
  if (!pidAlive(pid)) return { gone: true, why: `pid ${pid} is not running` };
  const c = await ID.createdOf(pid).catch(() => null);
  if (c && r.owner_boot != null && c.created !== Number(r.owner_boot)) return { gone: true, why: `pid ${pid} was created at ${c.created}, not at the row's ${r.owner_boot}` };
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
      const hookLeft = rows.currentAll(E.store, 'integration').find((r) => r.into_branch === into && G.samePath(r.worktree, found.path) && r.error && r.error.hook_left_uncommitted);
      const why = hookLeft ? `; a hook left them after integration ${hookLeft.id} (${hookLeft.error.hook_left_uncommitted.slice(0, 5).join(', ')})` : '';
      const out = abandoned.length ? `; integration ${abandoned.join(', ')} was abandoned mid-merge here: run git merge --abort in ${found.path}, or remove the tree (belay worktree remove --integration <id> --force)` : '';
      throw err('E_PRECONDITION', `${into} is checked out at ${found.path} with ${d.length} uncommitted path(s); belay merges only into a clean tree${why}${out}`, { path: found.path, dirty: d.slice(0, 50), abandoned });
    }
    return { path: found.path, created: false, junctions: [] };
  }
  const wtPath = G.fwd(path.join(path.dirname(repo), `${path.basename(repo)}.worktrees`, W.pathName(`integrate-${into.replace(/\//g, '-')}`, 'into')));
  if (fs.existsSync(wtPath) && fs.readdirSync(wtPath).length) throw err('E_EXISTS', `${wtPath} exists and is not empty`, { path: wtPath });
  const existed = await G.branchExists(repo, into);
  if (existed) {
    await H.mustAdd(repo, ['worktree', 'add', '--', wtPath, into], `a worktree for ${into} could not be added`, () => W.rollback(repo, { path: wtPath, branch: into, junctions: [] }, { keepBranch: true }));
  } else {
    let base;
    if (args.base !== undefined) base = await G.commitOf(repo, args.base);
    else {
      const bases = [...new Set(tasks.map((t) => t.worktree.base_sha))];
      if (bases.length !== 1) throw err('E_ARGS', `the tasks were cut from ${bases.length} different bases, so ${into} needs a base: pass base (for example the default branch)`, { bases });
      base = bases[0];
    }
    await H.mustAdd(repo, ['worktree', 'add', '-b', into, '--', wtPath, base], `the integration worktree for ${into} could not be added`, () => W.rollback(repo, { path: wtPath, branch: into, junctions: [] }));
  }
  const made = [];
  try { await W.makeJunctions(repo, wtPath, W.junctionList(undefined), made); } catch (e) {
    e.detail = { ...(e.detail || {}), rollback: await W.rollback(repo, { path: wtPath, branch: into, junctions: made }, { keepBranch: existed }) };
    throw e;
  }
  return { path: wtPath, created: true, junctions: made };
}

// One merge, of the commit that is the newest judgement on the task's branch (targetsOf). Returns { ok, ... } and on failure leaves
// the tree as it was before this merge. `covers` is every done task on the branch whose judged commit the merged commit contains,
// and `left_out` the branch head and the commits past the merged one, when there are any.
async function mergeOne(tree, task, target) {
  const b = task.worktree.branch;
  const tip = (await G.must(tree, ['rev-parse', '--verify', `refs/heads/${b}^{commit}`], `branch ${b} of task ${task.id} does not resolve`)).trim();
  if (!target) throw err('E_PRECONDITION', `task ${task.id} has no judged commit on ${b}; evaluate it on its branch first`, { task_id: task.id, branch: b });
  const { by, sha } = target;
  let leftOut = null;
  if (tip !== sha) {
    const n = await G.run(tree, ['rev-list', '--count', `${sha}..${tip}`]);
    leftOut = { branch: b, head: tip, judged: sha, commits: n.ok ? Number(n.stdout.trim()) : null };
  }
  const covers = [];
  for (const t of target.on) {
    const c = await J.commitOf(tree, t, tip);
    if (c && (await G.run(tree, ['merge-base', '--is-ancestor', c, sha])).ok) covers.push(t.id);
  }
  if (target.unjudged) covers.push(task.id);
  const facts = { judged_by: by ? by.id : null, covers, ...(leftOut ? { left_out: leftOut } : {}) };
  // A branch still at its recorded base holds no commit: it is contained already, and `empty` says why, so it is not read as merged work.
  const empty = sha === task.worktree.base_sha;
  if ((await G.run(tree, ['merge-base', '--is-ancestor', sha, 'HEAD'])).ok) return { ok: true, task_id: task.id, branch: b, sha, already: true, empty, ...facts };
  const judgedTree = await H.expectedTree(tree, sha); // what the merge writes with no hook; a hook that differs is reported
  const r = await H.runTraced(tree, ['merge', '--no-ff', '--no-edit', '-m', `belay: merge task ${task.id} (${b})`, sha]);
  if (r.ok) {
    const changed = await H.changedTree(tree, task.id, judgedTree, r.hooks || []);
    return { ok: true, task_id: task.id, branch: b, sha, already: false, ...facts, ...(changed ? { hook_changed_tree: changed } : {}), head_sha: (await G.must(tree, ['rev-parse', 'HEAD'], 'HEAD')).trim() };
  }
  const u = await G.run(tree, ['diff', '--name-only', '--diff-filter=U', '-z']);
  const files = u.ok ? u.stdout.split('\0').filter(Boolean) : [];
  const merging = (await G.run(tree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).ok;
  const abort = merging ? await G.run(tree, ['merge', '--abort']) : null;
  const left = await G.dirtyPaths(tree).catch(() => null);
  const rej = files.length ? null : await H.rejection(tree, r); // a real conflict is a conflict, whatever hooks exist
  return {
    ok: false, conflict: files.length > 0, task_id: task.id, branch: b, sha, files,
    aborted: abort ? abort.ok : false, tree_clean: Array.isArray(left) && left.length === 0, stderr: r.stderr,
    ...(rej ? { hook_rejected: { ...rej, stderr_tail: r.stderr_tail } } : {}),
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

// `extra` (the call's `checks`, integration-checks.cjs) run first, so a check the call asked for is not starved by long task suites,
// then the tasks' own commands, on this head only. A command a task also declares runs once and is marked `source: 'integrate'`
// as well. All commands share the call's budget, ending at `until`.
const keyCwd = (cwd) => G.fwd(path.resolve(cwd)); // `.`, an omitted cwd and the tree itself are one place
async function rerun(tasks, tree, reuse, head, beside = null, extra = [], until = Infinity, store = null) {
  const byKey = new Map();
  for (const e of extra) {
    const cwd = e.cwd ? G.fwd(path.resolve(tree, e.cwd)) : tree;
    const key = JSON.stringify([e.argv, keyCwd(cwd)]);
    const timeout_ms = Number(e.timeout_ms) > 0 ? Number(e.timeout_ms) : DEFAULT_COMMAND_TIMEOUT_MS;
    if (!byKey.has(key)) byKey.set(key, { argv: e.argv, cwd, timeout_ms, integrate_timeout_ms: timeout_ms, task_ids: [], source: 'integrate' });
  }
  for (const t of tasks) {
    for (const c of (t.acceptance && Array.isArray(t.acceptance.commands) ? t.acceptance.commands : [])) {
      if (!c || !Array.isArray(c.argv) || !c.argv.length || c.argv.some((x) => typeof x !== 'string')) continue;
      const cwd = cwdFor(c, t, tree);
      const key = JSON.stringify([c.argv, keyCwd(cwd)]);
      const timeout_ms = Number(c.timeout_ms) > 0 ? Number(c.timeout_ms) : DEFAULT_COMMAND_TIMEOUT_MS;
      const have = byKey.get(key);
      if (!have) byKey.set(key, { argv: c.argv, cwd, timeout_ms, task_timeout_ms: timeout_ms, task_ids: [t.id] });
      else {
        have.task_timeout_ms = Math.max(have.task_timeout_ms || 0, timeout_ms);
        have.timeout_ms = Math.max(have.timeout_ms, timeout_ms);
        have.task_ids.push(t.id);
      }
    }
  }
  const checks = [];
  for (const c of byKey.values()) {
    const declared = c.source && c.task_timeout_ms && c.task_timeout_ms !== c.integrate_timeout_ms ? { declared_timeout_ms: { task: c.task_timeout_ms, integrate: c.integrate_timeout_ms } } : {}; // each source's own limit, whichever ran
    const mark = { ...(c.source ? { source: c.source } : {}), ...declared };
    const from = reuse(c.argv, c.cwd, c.timeout_ms);
    if (from) { checks.push({ argv: c.argv, cwd: c.cwd, timeout_ms: c.timeout_ms, task_ids: c.task_ids, ...mark, reused_from: from, head_sha: head, passed: true }); continue; }
    const CE = require('./check-env.cjs'), env = store && until - Date.now() > 0 ? await CE.forCommands(store, [{ argv: c.argv, cwd: c.cwd }]) : null; // ADR 0080: recorded, never read; taken before the budget is measured, so it is charged to it
    const t0 = Date.now();
    if (until - t0 <= 0) { checks.push({ argv: c.argv, cwd: c.cwd, timeout_ms: c.timeout_ms, task_ids: c.task_ids, ...mark, executable: false, exit_code: null, ms: 0, timed_out: false, passed: false, not_run: `the call's commands share a budget of ${ACCEPTANCE_BUDGET_MS} ms and it was spent` }); continue; }
    const allowed = Math.min(c.timeout_ms, until - t0);
    const r = await runCommand(c.argv, c.cwd, allowed, { keep: 'ends', register: 'check' }); // the ends and the failure section, as task.evaluate keeps
    const concurrent = beside ? beside(t0, Date.now()) : [];
    checks.push({
      argv: c.argv, cwd: c.cwd, timeout_ms: c.timeout_ms, task_ids: c.task_ids, ...mark, executable: r.executable, exit_code: r.exit_code, ms: r.ms, timed_out: r.timed_out,
      passed: r.executable && r.exit_code === 0 && !r.timed_out, spawn_error: r.spawn_error || null, ...CE.brief(env), ...(allowed < c.timeout_ms ? { budget_capped_ms: allowed } : {}), ...(concurrent.length ? { concurrent } : {}), ...outputTails(r),
    });
  }
  return checks;
}

async function merge(E, caller, args) {
  W.ownBootProbe(E);
  args = W.present(args);
  const claim = policyGuard(E, caller, args); // ADR 0072 decision 5
  checkArgs(args);
  const takeOver = checkTakeOver(caller, args, 'integration.merge');
  const force = args.force === true;
  const { tasks, repo, targets } = await readTasks(E, args.task_ids, force);
  const into = await G.validBranch(repo, args.into === undefined ? `belay/integrate/${caller.run_id}` : args.into);
  // A branch the user owns (ADR 0067): approval first (read-only, and before any slot or tree), then belay merges on a detached HEAD.
  const fold = await MUG.folder(repo);
  refuseCrossRun(E, caller, tasks, into, repo, fold);
  await MUG.refuseVariant(repo, into, fold); // another spelling of an existing branch is that branch, on a host with case-insensitive refs
  const userBranch = await MUG.isUserBranch(E, repo, into, caller.run_id, fold);
  if (claim) await assertOwnBranch(E, caller, repo, into, claim); // ADR 0067: a branch this run did not make is not a step's to write
  if (claim && userBranch) throw err('E_PRECONDITION', `${into} is a branch the user owns; a policy step merges into belay/integrate/${caller.run_id} only`, { into, policy_step: claim.seq });
  if (userBranch) {
    if (force) throw err('E_PRECONDITION', `force is not accepted for ${into}, a branch the user owns: work that is not done does not go onto it through belay`, { into });
    const g = MUG.authorize(E, caller, args, MUG.requestOf(repo, into, args.task_ids, targets, await MUG.placement(E, repo, into, args, tasks, fold), args, tasks));
    if (g.response) return g.response;
  }
  // The re-run counts toward the run's max_parallel_evaluations, and its slot is taken here, before the branch lock and before any merge: a call
  // that waits too long is refused E_BUSY { queued: true } with the branch untouched, and the lock is never held while waiting (evaluate-cancel.cjs WAIT).
  await PS.pause('merge.beforeLock', { task_ids: args.task_ids, policy_step: PS.stepOf(caller) }); // fault-injection point (tests only)
  const EC = require('./evaluate-cancel.cjs');
  const t0call = Date.now();
  const extra = args.checks || []; // shape checked in checkArgs
  const slot = args.evaluate === false && !extra.length ? null : await EC.acquire(EC.limitFor(E, caller.run_id), { op: 'integrate' });
  try {
  return await W.exclusive(`integrate:${repo}:${fold(into)}`, `an integration into ${into}`, async () => {
    if (userBranch) { // approved above; the branch may have moved since, and an approval is for one head
      const place = await MUG.placement(E, repo, into, args, tasks, fold);
      const g = MUG.authorize(E, caller, args, MUG.requestOf(repo, into, args.task_ids, targets, place, args, tasks));
      if (g.response) return g.response;
      return require('./merge-user.cjs').mergeIntoUser(E, caller, args, { repo, into, tasks, targets, place, approver: g.approver, takeOver, fold, view, mergeOne, rerun, abandonStale, extra, until: t0call + ACCEPTANCE_BUDGET_MS });
    }
    const elsewhere = mergedElsewhere(E, caller, args, view, targets); // the orchestrator already merged these tasks, on any branch
    if (elsewhere) return elsewhere;
    const abandoned = await abandonStale(E, caller, repo, into, takeOver);
    const tree = await integrationTree(E, repo, into, args, tasks, abandoned);
    const by = E.writtenBy(caller);
    const standing = await standingMerge(E, caller, args, { tree: tree.path, repo, into }, view); // ADR 0072 decision 2
    if (standing) return standing;
    const baseSha = (await G.must(tree.path, ['rev-parse', 'HEAD'], 'HEAD of the integration tree')).trim();
    const carried = await INC.carriedOf(E, tree.path, repo, into, new Set(args.task_ids)); // tasks an earlier call left on the branch
    const base = {
      id: rows.newId(), run_id: caller.run_id, repo, into_branch: into, worktree: tree.path, created_worktree: tree.created,
      base_sha: baseSha, head_sha: baseSha, task_ids: [...carried.entries.map((c) => c.task_id), ...args.task_ids], merged: [], conflict: null, error: null, checks: null, passed: null, junctions: tree.junctions, removed_at: null,
      owner_pid: process.pid, owner_boot: await W.ownBoot(E), // who runs it, so a row a crash leaves `merging` reads stale
    };
    E.store.tx(() => { E.assertRunOpen(caller, 'integration.merge'); rows.append(E.store, 'integration', { ...base, state: 'merging' }, by, Date.now()); });
    E.noteWrite();
    const out = { ...base, state: 'merged', merged: [...carried.entries] };
    let trying = null; // the task whose merge is under way, so a throw (a branch deleted meanwhile) is blamed on it
    try {
      for (const t of tasks) {
        trying = t;
        const m = await mergeOne(tree.path, t, targets.get(t.id));
        if (!m.ok) {
          const { ok, conflict, stderr, ...rest } = m;
          if (conflict) { out.state = 'conflict'; out.conflict = rest; } else {
            const h = m.hook_rejected;
            const message = h ? `${H.phrase(h, `the merge of task ${t.id}`)}${h.stderr_tail ? `: ${h.stderr_tail}` : ''}` : `the merge of ${t.id} failed without a conflict: ${String(stderr).split('\n')[0]}`;
            out.state = 'failed'; out.error = { ...rest, message, stderr };
          }
          break;
        }
        out.merged.push({ task_id: m.task_id, branch: m.branch, sha: m.sha, already: m.already, by_this_call: !m.already, empty: !!m.empty, judged_by: m.judged_by, covers: m.covers, ...(m.left_out ? { left_out: m.left_out } : {}), ...(m.hook_changed_tree ? { hook_changed_tree: m.hook_changed_tree } : {}) });
        trying = null;
        const left = m.hook_changed_tree && m.hook_changed_tree.uncommitted_files;
        if (left) { // the merge went in, but its tree holds edits the commit does not: nothing more is merged or checked on it
          out.state = 'failed';
          out.error = { task_id: t.id, hook_left_uncommitted: left, message: `your ${m.hook_changed_tree.hooks.join(', ')} hook left uncommitted edits in ${tree.path} after merging task ${t.id} (${left.slice(0, 10).join(', ')}); the checks were not run on that tree, and it needs those edits committed or discarded`, tree_clean: false };
          break;
        }
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
    if ((args.evaluate !== false || extra.length) && out.merged.length && (!stop || stop.tree_clean === true)) {
      const landed = new Set(out.merged.map((m) => m.task_id));
      try {
        const older = carried.entries.map((c) => rows.current(E.store, 'task', c.task_id)).filter(Boolean);
        const reuse = INC.reuseFor(E, repo, into, out.head_sha, (await G.dirtyPaths(tree.path)).length === 0);
        const endSpan = EC.beginSpan(`integration ${base.id}`); // ADR 0061 section 4 (b): it ran beside the evaluations that overlapped it, and they beside it
        try { out.checks = await rerun(args.evaluate === false ? [] : [...tasks, ...older].filter((t) => landed.has(t.id)), tree.path, reuse, out.head_sha, (a, b) => EC.during(`integration ${base.id}`, a, b), extra, t0call + ACCEPTANCE_BUDGET_MS, E.store); } finally { endSpan(); }
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
    // A step that stopped did not integrate what was asked, so it is never passed, whether or not any check ran: the checks on what landed stay on the row, each with its own result.
    if (out.state === 'conflict' || out.state === 'failed') out.passed = false;
    // The merges have happened whatever the run did meanwhile, so the row that records them is written without a second run check.
    // A forced merge says so on its row, and only for what force let in: the tasks merged that were not done, with the failing
    // checks among theirs. A done task is never marked, and with none merged that were not done the row is as without force.
    const name = checkName;
    const forced = INC.forcedOf({ by, args, tasks, merged: out.merged, checks: out.checks, carried, name });
    if (forced) out.forced = forced;
    await PS.pause('merge.beforeRecord', { policy_step: PS.stepOf(caller) }); // fault-injection point (tests only): the merges have happened
    const row = E.store.tx(() => rows.append(E.store, 'integration', out, by, Date.now()));
    E.noteWrite();
    return { ...require('./integration-task-checks.cjs').withTaskChecks(E, view(row)), ...(carried.notCarried.length ? { not_carried: carried.notCarried } : {}) }; // answered, not stored: a task left out is on no row
  });
  } finally { if (slot) slot.release(); }
}

async function list(E, caller, args) {
  const all = rows.currentAll(E.store, 'integration').map(view);
  return { integrations: args && args.run_id ? all.filter((r) => r.run_id === args.run_id) : all };
}

async function get(E, caller, args) {
  if (!args.id) throw err('E_ARGS', 'integration.get needs an id');
  const r = rows.current(E.store, 'integration', args.id);
  if (!r) throw err('E_NOT_FOUND', `no integration row exists for ${args.id}`, { id: args.id });
  return require('./integration-task-checks.cjs').withTaskChecks(E, view(r));
}

// Removes an integration worktree belay made (the branch stays: it is the integrated result).
async function remove(E, caller, args) {
  W.ownBootProbe(E);
  args = W.present(args);
  const cur = await get(E, caller, args);
  if (args.force !== undefined && typeof args.force !== 'boolean') throw err('E_ARGS', 'integration.remove: force must be a boolean', { field: 'force' });
  const takeOver = checkTakeOver(caller, args, 'integration.remove');
  // A merge prepared for the user (ADR 0067): removing the integration deletes the ref that keeps its commit.
  if (cur.prepared && cur.prepared.ref && !cur.prepared.deleted_at) {
    const d = await G.run(cur.repo, ['update-ref', '-d', cur.prepared.ref]);
    if (!d.ok) throw err('E_GIT', `the prepared ref ${cur.prepared.ref} could not be deleted: ${d.stderr}`, { ref: cur.prepared.ref });
    const row = E.store.tx(() => rows.append(E.store, 'integration', { ...rows.current(E.store, 'integration', cur.id), prepared: { ...cur.prepared, deleted_at: Date.now(), deleted_why: 'removed' } }, E.writtenBy(caller), Date.now()));
    E.noteWrite();
    if (cur.removed_at) return { ...view(row), prepared_ref_deleted: true };
  }
  if (!cur.created_worktree) throw err('E_PRECONDITION', `integration ${cur.id} merged in ${cur.worktree}, a tree belay did not make, so belay does not remove it`, { id: cur.id, worktree: cur.worktree });
  if (cur.removed_at) throw err('E_NOT_FOUND', `integration ${cur.id}'s worktree was removed at ${cur.removed_at}`, { id: cur.id });
  // A merge in flight holds this lock, so the call is refused E_BUSY; a `merging` row met inside it was left by a process that
  // ended, and is closed `abandoned` before its tree is removed.
  const fold = await MUG.folder(cur.repo); // the key a merge into this branch holds: the name as refs compare it on this host
  return W.exclusive(`integrate:${cur.repo}:${fold(cur.into_branch)}`, `an integration call for ${cur.into_branch}`, async () => {
    if (cur.state === 'merging') await abandonStale(E, caller, cur.repo, cur.into_branch, takeOver);
    const removal = await W.removeTree(E, { repo: cur.repo, path: cur.worktree, junctions: cur.junctions, branch: cur.into_branch }, { force: args.force, owner: `integration-${cur.id}` }, `integration ${cur.id}`);
    const row = E.store.tx(() => rows.append(E.store, 'integration', { ...rows.current(E.store, 'integration', cur.id), removed_at: Date.now() }, E.writtenBy(caller), Date.now()));
    E.noteWrite();
    return { ...view(row), removal };
  });
}

module.exports = { merge, list, get, remove, rerun };
