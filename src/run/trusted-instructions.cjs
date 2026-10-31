'use strict';
// trusted-instructions.cjs — a worker that reads another worker's tree (a reviewer: agent_type `reviewer`, or any worker spawned
// for a review task) must not take its instructions from that tree's working copy: the reviewed coder can edit CLAUDE.md there and
// address its reviewer. Its spawn-time copy is CLAUDE.md as committed at the run's anchor itself: the main checkout's HEAD when
// the run first spawned. The anchor is fixed once per run in <data>/anchor-<run id>.json (written once, never overwritten), so a
// restarted adapter reads it back and does not re-anchor. A task's own recorded base is never used: ancestry would trust every
// worker commit ever merged. With no anchor nothing is copied; a failed task read is treated as a review. Every other spawn keeps
// instructions.cjs's copy of its own worktree. The receipt carries `reviewed_changes_instructions`, the CLAUDE.md or .claude paths
// the reviewed branch changes against the anchor, read in the main checkout (not in the coder's tree); the fact is also written to
// <worker dir>/review-flag.json. Spawn path only (invariant 9).

const fs = require('node:fs');
const path = require('node:path');
const I = require('./instructions.cjs');
const G = require('../core/git.cjs');

const isReviewTask = (t) => !!(t && t.acceptance && t.acceptance.verdict === true); // the core's review-tree.cjs isReview
const sha = (v) => (typeof v === 'string' && /^[0-9a-f]{40,64}$/i.test(v) ? v : null); // a full commit id only: never a ref or option-shaped text
const git = (cwd, args) => G.run(cwd, ['--no-replace-objects', ...args], { timeoutMs: 10000, env: { GIT_NO_REPLACE_OBJECTS: '1' } });

async function getTask(core, id) {
  try { return core && core.task && typeof core.task.get === 'function' ? await core.task.get({ task_id: id }) : null; } catch { return null; }
}

const anchorFile = (dataDir, runId) => path.join(dataDir, `anchor-${String(runId).replace(/[^\w.-]/g, '_')}.json`);
function readAnchor(file) {
  try { const a = JSON.parse(fs.readFileSync(file, 'utf8')); return a && typeof a.top === 'string' && sha(a.sha) ? { top: a.top, sha: a.sha } : null; } catch { return null; }
}

// Resolves { top, sha } from the run's project_dir, else (only when `fallback`) the first entry of the spawn's `git worktree list`
// (never a coder tree's own HEAD). Awaited, so no git outlives the spawn.
async function resolveAnchor(core, worktree, fallback) {
  let dir = null;
  try { const r = core.run.get ? await core.run.get({}) : null; dir = r && r.run && r.run.project_dir; } catch { /* no run row */ }
  if (!dir && fallback) {
    const wl = await git(worktree, ['worktree', 'list', '--porcelain']);
    const first = wl.ok ? /^worktree (.+)$/m.exec(wl.stdout) : null;
    dir = first && first[1].trim();
  }
  if (!dir) return null;
  const tl = await git(dir, ['rev-parse', '--show-toplevel']);
  if (!tl.ok) return null;
  const top = G.fwd(tl.stdout.trim());
  const head = await git(top, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
  const id = head.ok && sha(head.stdout.trim());
  return id ? { top, sha: id } : null;
}

// The run's anchor: read back from the data dir, else resolved and written once (flag wx; a lost race reads the winner's file).
const memo = new Map();
async function anchorOf({ core, worktree, dataDir, runId, fallback }) {
  if (!dataDir) return null;
  const file = anchorFile(dataDir, runId);
  if (memo.has(file)) return memo.get(file);
  const have = readAnchor(file);
  if (have) { memo.set(file, have); return have; }
  if (!core || !core.run) return null;
  const a = await resolveAnchor(core, worktree, fallback);
  if (!a) return null;
  try { fs.writeFileSync(file, JSON.stringify({ ...a, at: Date.now() }), { flag: 'wx' }); } catch { /* another spawn wrote it first */ }
  const final = readAnchor(file) || a;
  memo.set(file, final);
  return final;
}

// The paths of CLAUDE.md or .claude the reviewed branches change against the anchor, read in the main checkout from the branch ref.
async function touchedInstructions(core, task, anchor) {
  const paths = new Set();
  for (const dep of Array.isArray(task && task.depends_on) ? task.depends_on : []) {
    const t = await getTask(core, dep);
    const branch = t && t.worktree && !t.worktree.removed_at && typeof t.worktree.branch === 'string' && t.worktree.branch;
    if (!branch || branch.startsWith('-')) continue;
    const d = await git(anchor.top, ['diff', '--name-only', anchor.sha, `refs/heads/${branch}`, '--', 'CLAUDE.md', '.claude']);
    if (d.ok) d.stdout.split('\n').map((x) => x.trim()).filter(Boolean).forEach((x) => paths.add(x));
  }
  return [...paths].sort();
}

// The `instructions` record for a Claude Code spawn. `agentType` and `taskId` are the spawn's arguments; `dataDir` and `runId`
// locate the run's anchor.
async function snapshotFor({ core, worktree, dir, agentType, taskId, dataDir, runId }) {
  const task = taskId ? await getTask(core, taskId) : null;
  const trusted = agentType === 'reviewer' || isReviewTask(task) || (!!taskId && !task); // a failed task read fails closed
  if (!trusted) return I.snapshotInstructions(worktree, dir); // a coder spawn makes no core call: the anchor is fixed by the run's first trusted spawn
  const anchor = await anchorOf({ core, worktree, dataDir, runId, fallback: true });
  if (!anchor) return I.snapshotTrusted(null, dir, null);
  const out = await I.snapshotTrusted(anchor.top, dir, anchor.sha);
  const touched = task ? await touchedInstructions(core, task, anchor) : [];
  if (!touched.length) return out;
  try { fs.writeFileSync(path.join(dir, 'review-flag.json'), JSON.stringify({ task_id: taskId, anchor: anchor.sha, changes_instructions: touched })); } catch { /* the receipt still carries it */ }
  return { ...out, reviewed_changes_instructions: touched };
}

module.exports = { snapshotFor, anchorOf, anchorFile, _forgetMemo: () => memo.clear() }; // _forgetMemo: tests stand in for a restarted adapter
