'use strict';
// trusted-instructions.cjs — a worker that reads another worker's tree (a reviewer: agent_type `reviewer`, or any worker spawned
// for a review task) must not take its instructions from that tree's working copy: the reviewed coder can edit CLAUDE.md there and
// address its reviewer. Its spawn-time copy is CLAUDE.md as committed at the run's anchor itself: the main checkout's HEAD at run
// start. `belay run` fixes the anchor once, before the orchestrator launches (fixAnchor, called before either launcher, for
// an interactive run as for a headless one), in <data>/anchor-<run id>.json, written once and never overwritten. A spawn only READS
// that file: no core call, no git for a coder spawn. With no anchor file nothing is copied (fail closed). A task's own recorded
// base is never used: ancestry would trust every worker commit ever merged. A failed task read is treated as a review. Every other
// spawn keeps instructions.cjs's copy of its own worktree. The receipt carries `reviewed_changes_instructions`, the CLAUDE.md or
// .claude paths the reviewed branch changes against the anchor, read in the main checkout (not in the coder's tree); the fact is
// also written to <worker dir>/review-flag.json. Spawn and run-start paths only (invariant 9).

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
function readAnchor(dataDir, runId) {
  try { const a = JSON.parse(fs.readFileSync(anchorFile(dataDir, runId), 'utf8')); return a && typeof a.top === 'string' && sha(a.sha) ? { top: a.top, sha: a.sha } : null; } catch { return null; }
}

// Run start: records { top, sha } of `projectDir`'s repository (its HEAD now) once; an existing file is kept, so a re-launch of the
// same run id keeps its first anchor. Returns { ok, anchor? , reason? , existing? } and never throws; awaited, no git outlives it.
async function fixAnchor({ dataDir, runId, projectDir }) {
  const have = readAnchor(dataDir, runId);
  if (have) return { ok: true, anchor: have, existing: true };
  if (!projectDir) return { ok: false, reason: 'no project directory to anchor' };
  const tl = await git(projectDir, ['rev-parse', '--show-toplevel']);
  if (!tl.ok) return { ok: false, reason: `${projectDir} is not in a git repository: ${String(tl.stderr).split('\n')[0]}` };
  const top = G.fwd(tl.stdout.trim());
  const head = await git(top, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
  const id = head.ok && sha(head.stdout.trim());
  if (!id) return { ok: false, reason: `${top} has no commit to anchor to` };
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(anchorFile(dataDir, runId), JSON.stringify({ top, sha: id, at: Date.now() }), { flag: 'wx' }); } catch { /* a concurrent writer won: read it below */ }
  const final = readAnchor(dataDir, runId);
  return final ? { ok: true, anchor: final } : { ok: false, reason: 'the anchor file could not be written' };
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
  if (!trusted) return I.snapshotInstructions(worktree, dir);
  const anchor = dataDir ? readAnchor(dataDir, runId) : null;
  if (!anchor) return I.snapshotTrusted(null, dir, null);
  const out = await I.snapshotTrusted(anchor.top, dir, anchor.sha);
  const touched = task ? await touchedInstructions(core, task, anchor) : [];
  if (!touched.length) return out;
  try { fs.writeFileSync(path.join(dir, 'review-flag.json'), JSON.stringify({ task_id: taskId, anchor: anchor.sha, changes_instructions: touched })); } catch { /* the receipt still carries it */ }
  return { ...out, reviewed_changes_instructions: touched };
}

module.exports = { snapshotFor, fixAnchor, anchorFile };
