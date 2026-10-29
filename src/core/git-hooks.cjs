'use strict';
// git-hooks.cjs — what a repository's git hooks did to a call belay makes with hooks on (the operator keeps them on; the
// read-only path in git-safe.cjs turns them off). A hook that rejects a call is named from git's own trace2 events (a child
// started with class "hook" that exited non-zero), never from the wording of its output. When no trace is readable the answer
// says only that a hook may have rejected the call, and names the hooks that exist. A hook that changed the merged files is a
// tree comparison (ADR 0053 decision 5), reported and never reverted.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { err } = require('./errors.cjs');
const G = require('./git.cjs');
const rows = require('./rows.cjs');
const T = require('./trace-sweep.cjs');

const HOOK_NAMES = ['pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-merge', 'post-checkout', 'pre-commit', 'reference-transaction'];

// The hooks that exist as files in the repository's hooks directory (core.hooksPath honoured), sample files excluded.
async function present(cwd) {
  const r = await G.run(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
  if (!r.ok) return [];
  const dir = r.stdout.trim();
  const out = [];
  for (const n of HOOK_NAMES) {
    try {
      const st = fs.statSync(path.join(dir, n));
      if (st.isFile()) out.push(n);
    } catch { /* absent */ }
  }
  return out;
}

// The hooks that ran in a trace2 event file, in order: [{ name, exit_code }].
function hooksIn(text) {
  const started = new Map(); // keyed by session and child id: child ids repeat across sessions
  const ran = [];
  for (const line of String(text).split('\n')) {
    if (!line.includes('"child_')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.event === 'child_start' && e.child_class === 'hook') started.set(`${e.sid}:${e.child_id}`, e.hook_name);
    else if (e.event === 'child_exit' && started.has(`${e.sid}:${e.child_id}`)) ran.push({ name: started.get(`${e.sid}:${e.child_id}`), exit_code: e.code });
  }
  return ran;
}

// Runs git with trace2 events written to a temporary file. -> the run result plus `hooks`: the hooks that ran with their exit
// codes (null when the trace could not be read).
async function runTraced(cwd, args, opts = {}) {
  const file = path.join(os.tmpdir(), T.traceFileName(process.pid, rows.newId()));
  try {
    const r = await G.run(cwd, args, { ...opts, env: { ...(opts.env || {}), GIT_TRACE2_EVENT: file } });
    let hooks = null;
    try { hooks = hooksIn(fs.readFileSync(file, 'utf8')); } catch { /* no trace written */ }
    return { ...r, hooks };
  } finally {
    fs.rmSync(file, { force: true });
    try { T.sweepOnce(); } catch { /* never fails the git call */ } // after the git run, not awaited: sweeps the temp folder of traces whose writer died
  }
}

// Says what a failed traced run owes to hooks: { hook, exit_code, may_be } with `hook` the one that exited non-zero, or
// `may_be` (the hooks that exist) when the trace could not say. Null when no hook is involved.
async function rejection(cwd, r) {
  if (r.hooks) {
    const bad = r.hooks.filter((h) => h.exit_code !== 0);
    return bad.length ? { hook: bad[0].name, exit_code: bad[0].exit_code } : null;
  }
  const have = await present(cwd);
  return have.length ? { may_be: have } : null;
}

const phrase = (rej, what) => (rej.hook
  ? `your ${rej.hook} hook rejected ${what} (exit ${rej.exit_code})`
  : `a hook may have rejected ${what}; hooks present: ${rej.may_be.join(', ')}`);

// `git worktree add` with hooks on. A failure a hook caused is E_GIT naming the hook and its output tail; any other failure is
// the plain E_GIT. A hook that fails after the tree was made leaves the tree behind, so `undo` (optional) removes it.
async function mustAdd(cwd, args, what, undo) {
  const r = await runTraced(cwd, args);
  if (r.ok) return r.stdout;
  const rej = await rejection(cwd, r);
  if (!rej) throw G.failure(r, what);
  const detail = { argv: r.argv, cwd: r.cwd, exit_code: r.exit_code, hook: rej.hook || null, hooks_present: rej.may_be || null, stderr: r.stderr_tail };
  if (undo) detail.rollback = await undo();
  throw err('E_GIT', `${phrase(rej, what)}${r.stderr_tail ? `: ${r.stderr_tail}` : ''}`, detail);
}

// The tree a merge of `sha` into HEAD would write with no hook, or null when git cannot say (an old git, a conflict).
async function expectedTree(tree, sha) {
  const r = await G.run(tree, ['merge-tree', '--write-tree', '--no-messages', 'HEAD', sha]);
  return r.ok && /^[0-9a-f]{40,64}$/.test(r.stdout.trim().split('\n')[0]) ? r.stdout.trim().split('\n')[0] : null;
}

// What a hook did to a merge that went through: `{ task_id, judged_tree, merged_tree, files, uncommitted_files? }`, or null when
// the commit at HEAD holds exactly `judged` and no tracked file differs from it. `files` are the paths whose content differs
// between the two trees (a hook that amended the merge commit); `uncommitted_files` are tracked files a hook edited in the work
// tree without the commit taking them (a pre-merge-commit hook's edit lands there, since the tree is written before it runs).
// `ran` is the hooks that ran in the merge: an uncommitted edit is a hook's only when one ran (the tree was clean before the merge, so
// the edit is this task's). It names them as `hooks`.
async function changedTree(tree, taskId, judged, ran = []) {
  if (!judged) return null;
  const t = await G.run(tree, ['rev-parse', '--verify', 'HEAD^{tree}']);
  if (!t.ok) return null;
  const merged = t.stdout.trim();
  const names = async (args) => { const d = await G.run(tree, args); return d.ok ? d.stdout.split('\0').filter(Boolean) : []; };
  const files = merged === judged ? [] : await names(['diff-tree', '-r', '--name-only', '-z', '--no-renames', judged, merged]);
  const uncommitted = ran.length ? await names(['diff', '--name-only', '-z', 'HEAD', '--']) : [];
  if (merged === judged && !uncommitted.length) return null;
  return { task_id: taskId, judged_tree: judged, merged_tree: merged, files, hooks: [...new Set(ran.map((h) => h.name))], ...(uncommitted.length ? { uncommitted_files: uncommitted } : {}) };
}

module.exports = { present, runTraced, rejection, phrase, mustAdd, expectedTree, changedTree, hooksIn };
