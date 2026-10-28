'use strict';
// integration-state.cjs — what integrations did to each task they named, derived from the append-only `integration` rows and
// never stored on the task (ADR 0053 amendment 2). A task's work state stays `done` (its own checks passed); whether that work
// landed is this separate fact. No git and no write: task.list and task.get call it on whatever store they read.

const path = require('node:path');
const rows = require('./rows.cjs');
const { pidAlive } = require('./lock.cjs');

// Each named task that did not land, and why: the conflict, a merge that failed, or not tried because the step stopped before
// it. Null while the row is still `merging`, or `abandoned` (what it merged is unknown).
function notMerged(r) {
  if (r.state === 'merging' || r.state === 'abandoned') return null;
  const landed = new Set((r.merged || []).map((m) => m.task_id));
  const stop = (r.conflict && r.conflict.task_id) || (r.error && r.error.task_id) || null;
  return (r.task_ids || []).filter((id) => !landed.has(id))
    .map((task_id) => ({ task_id, reason: task_id !== stop ? 'not_tried' : r.conflict ? 'conflict' : 'failed' }));
}

// A `merging` row whose recorded process is gone. A read cannot tell a reused pid from the owner, so a live pid reads not stale;
// the owner itself decides exactly, since it serves every merge under one lock per branch (methods-integration.cjs). Null when
// the row records no process, or is not merging.
function stale(r) {
  if (r.state !== 'merging' || r.owner_pid == null) return null;
  return !pidAlive(Number(r.owner_pid));
}

// One row per integration: its outcome (the last row before any removal, so a later `integration.remove` neither reorders it
// nor changes its time), newest by when it began (its first row). A store from before the table existed has had none.
function newestFirst(store) {
  const sql = `SELECT t.* FROM integration t JOIN (SELECT id, MIN(seq) AS first, MAX(CASE WHEN removed_at IS NULL THEN seq END) AS outcome
               FROM integration GROUP BY id) x ON t.seq = x.outcome ORDER BY x.first DESC`;
  try { return store.p(sql).all().map((r) => rows.parseRow('integration', r)); } catch (e) {
    if (/no such table/i.test(String(e && e.message))) return [];
    throw e;
  }
}

const checkName = (c) => [path.basename(String(c.argv[0])), ...c.argv.slice(1, 4)].join(' ').slice(0, 80);

// The checks that bear on one task: its own (those naming it), judged apart from the integrate-level `checks` of the call, which
// get their own pair. `passed` is null when none of the task's own checks ran on that head (`evaluate: false`).
function checksOf(r, id) {
  const all = Array.isArray(r.checks) ? r.checks.filter((c) => c && Array.isArray(c.argv)) : [];
  const own = all.filter((c) => Array.isArray(c.task_ids) && c.task_ids.includes(id));
  const top = all.filter((c) => c.source === 'integrate');
  const failing = top.filter((c) => !c.passed).map(checkName);
  return { passed: own.length ? own.every((c) => c.passed) : null, ...(top.length ? { checks_passed: failing.length === 0, ...(failing.length ? { checks_failing: failing } : {}) } : {}) };
}

// What one integration says about one task, or null when it says nothing (the task was named but not tried).
function factOf(r, id) {
  const base = { id: r.id, into: r.into_branch, at: r.written_at };
  const f = r.forced && Array.isArray(r.forced.task_ids) && r.forced.task_ids.includes(id) ? { forced: (r.forced.reasons && r.forced.reasons[id]) || r.forced.reason, failing: r.forced.failing } : {}; // merged past checks that failed or never passed
  if ((r.merged || []).some((m) => m.task_id === id)) return { state: 'merged', ...base, head: r.head_sha, ...checksOf(r, id), ...f };
  if (r.state === 'merging') return { state: 'merging', ...base, stale: stale(r) };
  if (r.state === 'abandoned') return { state: 'abandoned', ...base };
  const miss = (notMerged(r) || []).find((m) => m.task_id === id);
  return miss && miss.reason !== 'not_tried' ? { state: miss.reason, ...base } : null;
}

// One fact per branch merged into: a merge into a branch stays true (the newest such merge gives head and passed), else the
// newest conflict, failure, abandoned or in-flight merge. The task's `integration` is its newest merge anywhere, else its
// newest other fact, and `elsewhere` lists the other branches' states when there are any. A done task with a branch that no
// integration has merged, stopped on or is merging is `not_merged` with `into: null`; a task with no belay branch, or not
// done and never named, has none (null).
//
// A branch is one unit (ADR 0060 decision 3): a fix task works on the branch of the work it fixes, so a peer's merge (`peers`, the
// other tasks on the same branch) lands this task too, marked `via` the peer, when this task was done before that merge was
// written and the merged commit contains the head this task was judged at (the merge's `covers`, decision 4; a row from before
// `covers` goes by the time alone). A task done after it (a later fix round) is not landed by it. Only a merge carries over; a
// peer's conflict or failure says nothing about this task.
const landedBy = (task, r) => task.state === 'done' && task.results && Number(task.results.evaluated_at) <= Number(r.written_at);
// The merge names what its commit contains (`covers`, ADR 0060 decision 4); a row from before it falls back to the time.
const contains = (r, mergedId, task) => { const m = (r.merged || []).find((x) => x.task_id === mergedId); return m && Array.isArray(m.covers) ? m.covers.includes(task.id) : true; };
function factFor(r, task, peers) {
  let own = Array.isArray(r.task_ids) && r.task_ids.includes(task.id) ? factOf(r, task.id) : null;
  // Its own entry counts as merged only when the merged commit contains what it was judged on: an `empty` or older commit did not
  // land its change, whatever the entry says.
  if (own && own.state === 'merged' && !contains(r, task.id, task)) own = null;
  if ((own && own.state === 'merged') || !landedBy(task, r)) return own;
  for (const p of peers) {
    if (!Array.isArray(r.task_ids) || !r.task_ids.includes(p.id)) continue;
    const f = factOf(r, p.id);
    if (!f || f.state !== 'merged') continue;
    if (contains(r, p.id, task)) return { ...f, via: p.id };
  }
  return own;
}

function ofTask(task, newest, peers = []) {
  if (!task.worktree || !task.worktree.branch) return null;
  const perInto = new Map();
  for (const r of newest) {
    const f = factFor(r, task, peers);
    if (!f) continue;
    const cur = perInto.get(f.into);
    if (!cur || (cur.state !== 'merged' && f.state === 'merged')) perInto.set(f.into, f);
  }
  const facts = [...perInto.values()];
  const main = facts.find((f) => f.state === 'merged') || facts[0];
  if (!main) return task.state === 'done' ? { state: 'not_merged', into: null } : null;
  const others = facts.filter((f) => f !== main).map((f) => ({ into: f.into, state: f.state }));
  return others.length ? { ...main, elsewhere: others } : main;
}

module.exports = { checkName, notMerged, stale, newestFirst, ofTask };
