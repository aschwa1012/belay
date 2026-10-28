'use strict';
// methods-task-batch.cjs — task.create with trees and the batch form (ADR 0062). The order is a fact: every check that needs no
// git runs first (a dry run of the real writes, rolled back), then each new task's id is locked, then the trees are made, then one
// store transaction re-checks everything and appends every row. Any throw after the first tree removes every tree this call made,
// newest first, and returns the original error with the removal receipts. No git runs inside a transaction.

const fs = require('node:fs');
const path = require('node:path');
const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const G = require('./git.cjs');
const H = require('./git-hooks.cjs');
const W = require('./methods-worktree.cjs');

const MAX_ITEMS = 10;
// Trees one call may make: each is a checkout, and the call must fit the adapter's tool timeout.
// Conservative until the time of one checkout is measured; the deadline below is the guard that holds either way.
const MAX_BATCH_TREES = 4;
const MARGIN_MS = 5000; // the least a further tree is assumed to need before its add is started
const TOOL_BUDGET_MS = 120000 - 10000; // the adapter's default MCP tool timeout less 10 s
const FIELDS = ['spec', 'acceptance', 'files_owned', 'depends_on', 'repairs', 'base', 'tree_of', 'id', 'worktree'];

// A test seam, honoured only when BELAY_TEST_SEAMS=1: afterTree is awaited after each tree is made (index, record), before the next
// tree and before the transaction; now is the clock; budgetMs replaces the call's time budget.
const seam = { afterTree: null, now: null, budgetMs: null };
const seamOn = () => process.env.BELAY_TEST_SEAMS === '1';
const clock = () => (seamOn() && seam.now ? seam.now() : Date.now());

// The time this call may spend: what the core client waits, and the adapter's tool timeout less 10 s (MCP_TOOL_TIMEOUT when the owner sees it).
function budget() {
  if (seamOn() && seam.budgetMs != null) return seam.budgetMs;
  const t = parseInt(process.env.MCP_TOOL_TIMEOUT, 10);
  return Math.min(require('./call-limits.cjs').writeTimeoutFor('task.create', { worktree: true }), Number.isInteger(t) && t > 10000 ? t - 10000 : TOOL_BUDGET_MS);
}

const DRY = Object.freeze({ dry: true }); // thrown inside the dry run's transaction so it rolls back

function items(args) {
  args = W.present(args);
  const isAmend = (a) => a.amend !== undefined && a.amend !== false;
  let list;
  if (args.tasks !== undefined) {
    if (!Array.isArray(args.tasks) || !args.tasks.length || args.tasks.length > MAX_ITEMS) throw err('E_ARGS', `task.create tasks must be an array of 1 to ${MAX_ITEMS} tasks`, { max: MAX_ITEMS });
    const mixed = Object.keys(args).filter((k) => k !== 'tasks' && !(k === 'amend' && args.amend === false));
    if (mixed.length) throw err('E_ARGS', `task.create takes tasks or one task's fields, not both: ${mixed.join(', ')} beside tasks`, { fields: mixed });
    list = args.tasks.map((t) => {
      if (!t || typeof t !== 'object' || Array.isArray(t)) throw err('E_ARGS', 'task.create tasks: each item is an object of task fields');
      return W.present(t);
    });
  } else list = [args];
  return list.map((a, i) => {
    if (isAmend(a)) throw err('E_ARGS', `task.create amend revises one existing task and cannot be a batch item or beside worktree${args.tasks ? ` (item ${i})` : ''}`);
    const extra = Object.keys(a).filter((k) => !FIELDS.includes(k) && k !== 'amend');
    if (args.tasks && extra.length) throw err('E_ARGS', `task.create tasks item ${i}: ${extra.join(', ')} is not one of a task's fields`, { item: i, fields: extra });
    const w = a.worktree;
    if (w !== undefined && w !== false && w !== true && (typeof w !== 'string' || !w.trim())) throw err('E_ARGS', 'task.create worktree must be true (a tree from HEAD) or a ref to cut it from', { field: 'worktree' });
    if (w && a.tree_of != null) throw err('E_ARGS', 'task.create worktree and tree_of together: a task has one tree');
    const id = a.id === undefined ? rows.newId() : a.id;
    if (typeof id !== 'string' || !id) throw err('E_ARGS', 'task.create id must be a non-empty string');
    if (w) W.pathName(id, 'id');
    const { worktree, amend, ...rest } = a;
    return { id, args: rest, tree: w ? (w === true ? 'HEAD' : w.trim()) : null };
  });
}

function planned(top, it) {
  return { repo: top, path: G.fwd(path.join(path.dirname(top), `${path.basename(top)}.worktrees`, it.id)), branch: `belay/${it.id}`, base_ref: it.tree, base_sha: null, junctions: [], junctions_skipped: [], created_at: Date.now(), removed_at: null };
}

// Every item's checks and append, in order, so a later item sees the earlier ones as rows. Call it inside a transaction.
function writeAll(E, caller, list, trees, runTop, own = {}) {
  const N = require('./methods-task-new.cjs');
  return list.map((it, i) => N.one(E, caller, { ...it.args, id: it.id }, { ...(own.follows_up && list.length === 1 ? { follows_up: own.follows_up } : {}), ...(trees[i] ? { worktree: trees[i] } : {}) }, runTop)); // own.follows_up: a follow-up with its own tree (ADR 0064)
}

// The steps of task.worktreeCreate up to and including the junctions, for a new task's tree. `made` gets the record as soon as
// the add succeeds, so a failure after it still has the tree to remove.
// The git-only checks for one item, with nothing made: its base commit, branch and path.
async function checkTree(top, it) {
  const baseSha = await G.commitOf(top, it.tree);
  const branch = await G.validBranch(top, `belay/${it.id}`);
  if (await G.branchExists(top, branch)) throw err('E_EXISTS', `branch ${branch} already exists; an earlier call may have left it, so name another task id or remove it`, { branch, task_id: it.id });
  const wtPath = planned(top, it).path;
  if (fs.existsSync(wtPath) && fs.readdirSync(wtPath).length) throw err('E_EXISTS', `${wtPath} exists and is not empty`, { path: wtPath, task_id: it.id });
  return { baseSha, branch, wtPath };
}

async function makeTree(E, caller, top, it, checked, made, undone) {
  const { baseSha, branch, wtPath } = checked;
  await H.mustAdd(top, ['worktree', 'add', '-b', branch, '--', wtPath, baseSha], `the worktree for task ${it.id} could not be added`, async () => {
    const r = await W.undoAdd(top, { path: wtPath, branch }, baseSha);
    undone.push({ task_id: it.id, path: wtPath, branch, ...r });
    return r;
  });
  const rec = { repo: top, path: wtPath, branch, base_ref: it.tree, base_sha: baseSha, junctions: [], junctions_skipped: [], created_at: Date.now(), created_by: E.writtenBy(caller), removed_at: null };
  made.push({ task_id: it.id, top, rec });
  await W.makeJunctions(top, wtPath, W.junctionList(undefined), rec.junctions, rec.junctions_skipped);
  return rec;
}

// Removes what this call made, newest first. Never throws; the receipts name what is left.
async function removeMade(made, undone) {
  const receipts = [...undone];
  for (const m of [...made].reverse()) {
    let r;
    try { r = await W.rollback(m.top, m.rec); } catch (e) { r = { junctions: [], worktree_removed: false, branch_deleted: false, path_gone: !fs.existsSync(m.rec.path), error: e.message }; }
    receipts.push({ task_id: m.task_id, path: m.rec.path, branch: m.rec.branch, ...r });
  }
  const kept = receipts.filter((r) => r.kept); // an add that made nothing: whatever is there is not belay's, so it is not "left"
  const left = receipts.filter((r) => !r.kept && (!r.path_gone || r.error || r.junction_error || (r.worktree_removed && r.branch_deleted === false)));
  return { receipts, left, kept };
}

async function createWithTrees(E, caller, args, own) {
  const list = items(args), single = W.present(args).tasks === undefined;
  const wanted = list.filter((it) => it.tree);
  if (wanted.length > MAX_BATCH_TREES) throw err('E_ARGS', `task.create makes at most ${MAX_BATCH_TREES} trees in one call; ${wanted.length} were asked for`, { max: MAX_BATCH_TREES });
  if (new Set(list.map((it) => it.id)).size !== list.length) throw err('E_ARGS', 'task.create tasks: two items have the same id');
  const needsRepo = wanted.length || list.some((it) => it.args.tree_of != null);
  const top = needsRepo ? await W.repoOf(E, caller, undefined, 'task.create') : null; // the first await: the rest of the checks are one turn
  for (const it of list) { // a tree the sweep was cut inside is not handed out
    const src = typeof it.args.tree_of === 'string' ? rows.current(E.store, 'task', it.args.tree_of) : null;
    if (src) await W.assertTreeListed(src);
  }
  const shape = (written) => (single ? written[0] : { tasks: written });

  if (!wanted.length) { // nothing to make: one transaction, all or nothing
    const out = E.store.tx(() => { E.assertRunOpen(caller, 'task.create'); return writeAll(E, caller, list, list.map(() => null), top, own); });
    E.noteWrite();
    return shape(out);
  }

  // 1. every check, with no git: the real writes in a transaction that is rolled back.
  try {
    E.store.tx(() => { E.assertRunOpen(caller, 'task.create'); writeAll(E, caller, list, list.map((it) => (it.tree ? planned(top, it) : null)), top, own); throw DRY; });
  } catch (e) { if (e !== DRY) throw e; }

  // 2. the lock for every new id, then 3. the trees.
  const started = clock();
  return W.exclusiveAll(list.map((it) => `task:${it.id}`), 'a task.create for these ids', async () => {
    const made = [], undone = [];
    try {
      const trees = list.map(() => null), checked = list.map(() => null);
      for (let i = 0; i < list.length; i++) if (list[i].tree) checked[i] = await checkTree(top, list[i]); // 3a. every git-only check, before any tree
      const limit = budget();
      let slowest = 0;
      for (let i = 0; i < list.length; i++) {
        if (!list[i].tree) continue;
        const at = clock(), elapsed = at - started, margin = Math.max(MARGIN_MS, slowest);
        if (made.length && elapsed + margin > limit) {
          throw err('E_TIMEOUT', `task.create stopped before the tree for ${list[i].id}: ${elapsed} ms spent, a further tree needs about ${margin} ms and the call has ${limit} ms; ${made.length} tree${made.length === 1 ? '' : 's'} made so far ${made.length === 1 ? 'is' : 'are'} removed and nothing was written. Create fewer tasks with trees in one call`,
            { elapsed_ms: elapsed, margin_ms: margin, budget_ms: limit, trees_made: made.length, trees_wanted: wanted.length });
        }
        trees[i] = await makeTree(E, caller, top, list[i], checked[i], made, undone);
        slowest = Math.max(slowest, clock() - at);
        if (seamOn() && seam.afterTree) await seam.afterTree(i, trees[i]);
      }
      for (const it of list) { // the trees took time: a tree_of source the sweep removed meanwhile is not handed out
        const src = typeof it.args.tree_of === 'string' ? rows.current(E.store, 'task', it.args.tree_of) : null;
        if (src) await W.assertTreeListed(src);
      }
      // 4. every row, one transaction, every check again on the store as it now is.
      const out = E.store.tx(() => { E.assertRunOpen(caller, 'task.create'); return writeAll(E, caller, list, trees, top, own); });
      E.noteWrite();
      return shape(out);
    } catch (e) {
      const { receipts, left, kept } = await removeMade(made, undone);
      e.detail = { ...(e.detail || {}), rollback: receipts, ...(left.length ? { rollback_incomplete: true, left: left.map((r) => r.path) } : {}), ...(kept.length ? { kept_foreign: kept.map((r) => r.path) } : {}) };
      throw e;
    }
  });
}

module.exports = { createWithTrees, MAX_ITEMS, MAX_BATCH_TREES, seam };
