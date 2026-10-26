'use strict';
// integration-incremental.cjs — what an integration into a branch that already holds earlier tasks keeps true, and the checks
// that need no second run. Both are derived from the append-only `integration` rows and git; neither is a tool argument.
// `carriedOf` names the tasks already on the branch (a merged sha that HEAD contains), so a later call need not re-list them;
// `reuseFor` finds a check that already passed at exactly this head. Called holding the branch's integrate lock.

const rows = require('./rows.cjs');
const G = require('./git.cjs');
const J = require('./judged.cjs');
const { newestFirst } = require('./integration-state.cjs');

// A check is the same command when its argv, cwd and time limit are. Rows are read oldest first by their first row, as
// integration-state.cjs newestFirst orders them, so a later removal (a new version of an old row) moves none of them.
const keyOf = (argv, cwd, timeout) => JSON.stringify([argv, cwd, timeout == null ? null : timeout]);
const oldestFirst = (E) => newestFirst(E.store).reverse();

// -> { entries: [merged entry], forced: Map(task_id -> { id, reason }), notCarried: [{ task_id, reason }] } for each task an earlier integration into `into` merged
// whose merged commit HEAD of `tree` contains, newest row winning. `skip` (the tasks of this call) are left to this call's own merge.
async function carriedOf(E, tree, repo, into, skip) {
  const prior = oldestFirst(E).filter((r) => r.into_branch === into && G.samePath(r.repo, repo) && Array.isArray(r.merged) && r.merged.length);
  const found = new Map();
  const forced = new Map();
  const contained = new Map();
  for (const r of prior) {
    for (const m of r.merged) {
      if (!m || !m.task_id || !m.sha || skip.has(m.task_id)) continue;
      if (!contained.has(m.sha)) contained.set(m.sha, (await G.run(tree, ['merge-base', '--is-ancestor', m.sha, 'HEAD'])).ok);
      if (!contained.get(m.sha)) continue;
      found.set(m.task_id, { m, row: r.id });
      if (r.forced && Array.isArray(r.forced.task_ids) && r.forced.task_ids.includes(m.task_id)) forced.set(m.task_id, { id: r.id, reason: r.forced.reason });
      else forced.delete(m.task_id);
    }
  }
  const entries = [];
  const notCarried = [];
  for (const [task_id, { m, row }] of found) {
    let left = null;
    const tip = await G.run(tree, ['rev-parse', '--verify', `refs/heads/${m.branch}^{commit}`]);
    // The commit integrate would merge for the task now is the newest judgement among the done tasks on its branch (a fix task
    // judged since counts); when that is not the commit merged, the branch has moved on and the old one is not vouched for.
    const t = rows.current(E.store, 'task', task_id);
    if (t && t.worktree && tip.ok) {
      const own = t.state !== 'done' && J.judgedOf(t) ? [t] : [];
      const on = [...J.onBranch(E, t), ...own].sort((x, y) => Number(x.results.evaluated_at) - Number(y.results.evaluated_at));
      const by = on[on.length - 1];
      const now = by ? await J.commitOf(tree, by, tip.stdout.trim()) : m.sha;
      if (now !== m.sha) { notCarried.push({ task_id, reason: now ? `judged again at ${now} (task ${by.id}); the branch holds ${m.sha}` : `its last judgement is no commit on ${m.branch}; the branch holds ${m.sha}` }); forced.delete(task_id); continue; }
    }
    if (tip.ok && tip.stdout.trim() !== m.sha) {
      const n = await G.run(tree, ['rev-list', '--count', `${m.sha}..${tip.stdout.trim()}`]);
      left = { branch: m.branch, head: tip.stdout.trim(), judged: m.sha, commits: n.ok ? Number(n.stdout.trim()) : null };
    }
    entries.push({
      task_id, branch: m.branch, sha: m.sha, already: true, by_this_call: false, carried_from: row, empty: !!m.empty,
      judged_by: m.judged_by == null ? null : m.judged_by, covers: m.covers || [task_id], ...(left ? { left_out: left } : {}),
    });
  }
  return { entries, forced, notCarried };
}

// -> (argv, cwd) => the earlier check that passed at exactly `head` for that command, or null. A check that failed, timed out or
// never ran is never reused, and a reuse is traced to the row that ran it. `clean` false (edits in the tree) reuses nothing.
function reuseFor(E, repo, into, head, clean) {
  const passed = new Map();
  if (clean && head) {
    const prior = oldestFirst(E).filter((r) => r.into_branch === into && G.samePath(r.repo, repo) && r.head_sha === head && Array.isArray(r.checks));
    for (const r of prior) for (const c of r.checks) {
      if (c && c.passed === true && Array.isArray(c.argv)) passed.set(keyOf(c.argv, c.cwd, c.timeout_ms), c.reused_from || r.id);
      else if (c && Array.isArray(c.argv)) passed.delete(keyOf(c.argv, c.cwd, c.timeout_ms));
    }
  }
  return (argv, cwd, timeout) => passed.get(keyOf(argv, cwd, timeout)) || null;
}

// The `forced` record of a row: the not-done tasks this call let in, with those carried from earlier forced merges still on the
// branch. `failing` is recomputed from this head's checks, so an earlier forced task's failure is never hidden.
function forcedOf({ by, args, tasks, merged, checks, carried, name }) {
  const mine = new Set(args.task_ids);
  const unsettled = merged.filter((m) => mine.has(m.task_id) && tasks.find((t) => t.id === m.task_id).state !== 'done').map((m) => m.task_id);
  const ids = [...new Set([...carried.forced.keys(), ...unsettled])];
  if (!ids.length) return null;
  const reasons = {};
  for (const [id, f] of carried.forced) reasons[id] = f.reason;
  for (const id of unsettled) reasons[id] = args.reason.trim();
  const failing = (checks || []).filter((c) => !c.passed && c.task_ids.some((id) => ids.includes(id))).map(name);
  return { by, at: Date.now(), reason: unsettled.length ? args.reason.trim() : reasons[ids[ids.length - 1]], reasons, task_ids: ids, failing };
}

module.exports = { carriedOf, reuseFor, forcedOf, keyOf };
