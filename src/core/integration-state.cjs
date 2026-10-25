'use strict';
// integration-state.cjs — what an integration did to each task it named, derived from the append-only `integration` rows and
// never stored on the task (ADR 0053 amendment 2). A task's work state stays `done` (its own checks passed); whether that work
// landed is this separate fact. No git and no write: task.list and task.get call it on whatever store they read.

const rows = require('./rows.cjs');

// Each named task that did not land, and why: the conflict, a merge that failed, or not tried because the step stopped before
// it. Null while the row is still `merging`.
function notMerged(r) {
  if (r.state === 'merging') return null;
  const landed = new Set((r.merged || []).map((m) => m.task_id));
  const stop = (r.conflict && r.conflict.task_id) || (r.error && r.error.task_id) || null;
  return (r.task_ids || []).filter((id) => !landed.has(id))
    .map((task_id) => ({ task_id, reason: task_id !== stop ? 'not_tried' : r.conflict ? 'conflict' : 'failed' }));
}

// The current integration rows, newest activity first. A store from before the table existed has had no integration.
function newestFirst(store) {
  try { return rows.currentAll(store, 'integration').reverse(); } catch (e) {
    if (/no such table/i.test(String(e && e.message))) return [];
    throw e;
  }
}

// The latest integration that named the task decides: `merged` (with the row's head and whether its checks passed),
// `conflict`, `failed`, `not_merged` (named but not tried) or `merging`. A done task with a branch no integration has named is
// `not_merged` with `into: null`; a task with no belay branch, or not done and never named, has none (null).
function ofTask(task, newest) {
  if (!task.worktree || !task.worktree.branch) return null;
  const r = newest.find((x) => Array.isArray(x.task_ids) && x.task_ids.includes(task.id));
  if (!r) return task.state === 'done' ? { state: 'not_merged', into: null } : null;
  const base = { id: r.id, into: r.into_branch, at: r.written_at };
  if (r.state === 'merging') return { state: 'merging', ...base };
  if ((r.merged || []).some((m) => m.task_id === task.id)) return { state: 'merged', ...base, head: r.head_sha, passed: r.passed == null ? null : !!r.passed };
  const miss = (notMerged(r) || []).find((m) => m.task_id === task.id);
  return { state: miss && miss.reason !== 'not_tried' ? miss.reason : 'not_merged', ...base };
}

module.exports = { notMerged, newestFirst, ofTask };
