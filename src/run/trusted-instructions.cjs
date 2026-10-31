'use strict';
// trusted-instructions.cjs — a worker that reads another worker's tree (a reviewer: agent_type `reviewer`, or any worker spawned
// for a review task) must not take its instructions from that tree's working copy: the reviewed coder can edit CLAUDE.md there and
// address its reviewer. Its spawn-time copy comes from CLAUDE.md as committed at a commit no worker authored: the run's anchor
// (the main checkout's HEAD when the run first spawns, recorded once per core connection), or the reviewed work's recorded base
// when that base is an ancestor of the anchor. A base cut from a worker's commit (a follow-up, stacked work) is not an ancestor,
// so the anchor is used. With no anchor, nothing is copied. A failed task read is treated as a review. Every other spawn keeps
// instructions.cjs's copy of its own worktree. Spawn path only (invariant 9).

const I = require('./instructions.cjs');
const G = require('../core/git.cjs');

const isReviewTask = (t) => !!(t && t.acceptance && t.acceptance.verdict === true); // the core's review-tree.cjs isReview
const sha = (v) => (typeof v === 'string' && /^[0-9a-f]{40,64}$/i.test(v) ? v : null); // a full commit id only: never a ref or option-shaped text
const SAFE = { GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, args) => G.run(cwd, ['--no-replace-objects', ...args], { timeoutMs: 10000, env: SAFE });

async function getTask(core, id) {
  try { return core && core.task && typeof core.task.get === 'function' ? await core.task.get({ task_id: id }) : null; } catch { return null; }
}

// The run's anchor { top, sha }, resolved once per core: the main checkout is the run's project_dir, else the first entry of the
// spawn's `git worktree list` (never a coder tree's own HEAD). Null when neither resolves.
const anchors = new WeakMap();
function anchorOf(core, worktree) {
  const key = core && typeof core === 'object' ? core : null;
  if (key && anchors.has(key)) return anchors.get(key);
  const p = (async () => {
    let dir = null;
    try { const r = core && core.run && typeof core.run.get === 'function' ? await core.run.get({}) : null; dir = r && r.run && r.run.project_dir; } catch { /* no run row */ }
    if (!dir) {
      const wl = await git(worktree, ['worktree', 'list', '--porcelain']);
      const first = wl.ok ? /^worktree (.+)$/m.exec(wl.stdout) : null;
      dir = first && first[1].trim();
    }
    if (!dir) return null;
    let top;
    try { top = await G.toplevel(dir); } catch { return null; }
    const head = await git(top, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
    const id = head.ok && sha(head.stdout.trim());
    return id ? { top, sha: id } : null;
  })();
  if (key) anchors.set(key, p);
  return p;
}

// The commit the reviewed work started from, if some recorded base is an ancestor of the anchor; else the anchor itself.
async function trustedRef(core, task, anchor) {
  const bases = [];
  for (const dep of Array.isArray(task && task.depends_on) ? task.depends_on : []) {
    const t = await getTask(core, dep);
    if (t && t.worktree && sha(t.worktree.base_sha)) bases.push(t.worktree.base_sha);
  }
  if (task && task.worktree && sha(task.worktree.base_sha)) bases.push(task.worktree.base_sha);
  for (const b of bases) {
    const r = await git(anchor.top, ['merge-base', '--is-ancestor', b, anchor.sha]);
    if (r.ok) return b;
  }
  return anchor.sha;
}

// Paths that change instructions, in the diff from the trusted commit to each reviewed head: the receipt names them.
async function touchedInstructions(core, task, commit) {
  const paths = new Set();
  for (const dep of Array.isArray(task && task.depends_on) ? task.depends_on : []) {
    const t = await getTask(core, dep);
    const at = t && t.worktree && !t.worktree.removed_at && t.worktree.path;
    if (!at) continue;
    const d = await git(at, ['diff', '--name-only', commit, 'HEAD', '--', 'CLAUDE.md', '.claude']);
    if (d.ok) d.stdout.split('\n').map((x) => x.trim()).filter(Boolean).forEach((x) => paths.add(x));
  }
  return [...paths].sort();
}

// The `instructions` record for a Claude Code spawn. `agentType` and `taskId` are the spawn's arguments.
async function snapshotFor({ core, worktree, dir, agentType, taskId }) {
  const task = taskId ? await getTask(core, taskId) : null;
  const trusted = agentType === 'reviewer' || isReviewTask(task) || (!!taskId && !task); // a failed task read fails closed
  if (!trusted) { anchorOf(core, worktree).catch(() => null); return I.snapshotInstructions(worktree, dir); } // the first spawn fixes the anchor
  const anchor = await anchorOf(core, worktree);
  if (!anchor) return I.snapshotTrusted(null, dir, null);
  const commit = await trustedRef(core, task, anchor);
  const out = await I.snapshotTrusted(anchor.top, dir, commit);
  const touched = task ? await touchedInstructions(core, task, commit) : [];
  return touched.length ? { ...out, reviewed_changes_instructions: touched } : out;
}

module.exports = { snapshotFor, trustedRef, anchorOf };
