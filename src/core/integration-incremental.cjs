'use strict';
// integration-incremental.cjs — what an integration into a branch that already holds earlier tasks keeps true, and the checks
// that need no second run. Both are derived from the append-only `integration` rows and git; neither is a tool argument.
// `carriedOf` names the tasks already on the branch (a merged sha that HEAD contains), so a later call need not re-list them;
// `reuseFor` finds a check that already passed at exactly this head. Called holding the branch's integrate lock.

const rows = require('./rows.cjs');
const G = require('./git.cjs');

const keyOf = (argv, cwd) => JSON.stringify([argv, cwd]);

// -> { entries: [merged entry], forced: Map(task_id -> { id, reason }) } for each task an earlier integration into `into` merged
// whose merged commit HEAD of `tree` contains, newest row winning. `skip` (the tasks of this call) are left to this call's own merge.
async function carriedOf(E, tree, repo, into, skip) {
  const prior = rows.currentAll(E.store, 'integration')
    .filter((r) => r.into_branch === into && G.samePath(r.repo, repo) && Array.isArray(r.merged) && r.merged.length)
    .sort((a, b) => Number(a.written_at) - Number(b.written_at));
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
  for (const [task_id, { m, row }] of found) {
    let left = null;
    const tip = await G.run(tree, ['rev-parse', '--verify', `refs/heads/${m.branch}^{commit}`]);
    if (tip.ok && tip.stdout.trim() !== m.sha) {
      const n = await G.run(tree, ['rev-list', '--count', `${m.sha}..${tip.stdout.trim()}`]);
      left = { branch: m.branch, head: tip.stdout.trim(), judged: m.sha, commits: n.ok ? Number(n.stdout.trim()) : null };
    }
    entries.push({
      task_id, branch: m.branch, sha: m.sha, already: true, by_this_call: false, carried_from: row, empty: !!m.empty,
      judged_by: m.judged_by == null ? null : m.judged_by, covers: m.covers || [task_id], ...(left ? { left_out: left } : {}),
    });
  }
  return { entries, forced };
}

// -> (argv, cwd) => the earlier check that passed at exactly `head` for that command, or null. A check that failed, timed out or
// never ran is never reused, and a reuse is traced to the row that ran it. `clean` false (edits in the tree) reuses nothing.
function reuseFor(E, repo, into, head, clean) {
  const passed = new Map();
  if (clean && head) {
    const prior = rows.currentAll(E.store, 'integration')
      .filter((r) => r.into_branch === into && G.samePath(r.repo, repo) && r.head_sha === head && Array.isArray(r.checks))
      .sort((a, b) => Number(a.written_at) - Number(b.written_at));
    for (const r of prior) for (const c of r.checks) {
      if (c && c.passed === true && Array.isArray(c.argv)) passed.set(keyOf(c.argv, c.cwd), c.reused_from || r.id);
      else if (c && Array.isArray(c.argv)) passed.delete(keyOf(c.argv, c.cwd));
    }
  }
  return (argv, cwd) => passed.get(keyOf(argv, cwd)) || null;
}

// The `forced` record of a row: the not-done tasks this call let in, with those carried from earlier forced merges still on the
// branch. `failing` is recomputed from this head's checks, so an earlier forced task's failure is never hidden.
function forcedOf({ by, args, tasks, merged, checks, carried, name }) {
  const mine = new Set(args.task_ids);
  const unsettled = merged.filter((m) => mine.has(m.task_id) && tasks.find((t) => t.id === m.task_id).state !== 'done').map((m) => m.task_id);
  const ids = [...new Set([...carried.forced.keys(), ...unsettled])];
  if (!ids.length) return null;
  const reasons = [...new Set([...[...carried.forced.values()].map((f) => f.reason), ...(unsettled.length ? [args.reason.trim()] : [])])];
  const failing = (checks || []).filter((c) => !c.passed && c.task_ids.some((id) => ids.includes(id))).map(name);
  return { by, at: Date.now(), reason: reasons.join(' | '), task_ids: ids, failing };
}

module.exports = { carriedOf, reuseFor, forcedOf, keyOf };
