'use strict';
// conflict-forecast.cjs — a dry run of the merge a released task's branch would make into the integration branch, so the
// orchestrator hears of a conflict before it calls integrate. A warning field only: it never blocks, retries or acts, and every
// failure of its own is `unavailable`, never an error.
// - `git merge-tree --write-tree --name-only -z <against> <head>` exits 1 on a conflict (the conflicted paths follow the tree id),
//   0 when the merge is clean. It needs git 2.38.
// - It writes the merged tree as objects, and the repository is shared with the user, so they go to a scratch directory:
//   GIT_OBJECT_DIRECTORY is the scratch and the repository's own objects are its only alternate. The repository gains nothing.
// - Every git call goes through git-safe.cjs, hardened and bounded by `timeoutMs`.
// Results: `{ files, against, ms }` (conflict), `{ clean: true, against, ms }`, `{ against: null, ms }` (no integration head yet),
// `{ unavailable: <why>, against, ms }`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { safeGit, prepare } = require('./git-safe.cjs');

const TIMEOUT_MS = 4000;
const MIN_GIT = [2, 38];
const FILES_MAX = 50;

const sha = (s) => { const l = String(s || '').trim().split('\n')[0]; return /^[0-9a-f]{40,64}$/.test(l) ? l : null; };

// The forecast of merging `head` into `against` (both commits of the repository at `repo`; `against` null when the integration
// branch does not exist yet). `scratchRoot` is where the throwaway object directory goes (a test points it elsewhere).
async function forecast({ repo, head, against, timeoutMs = TIMEOUT_MS, scratchRoot = os.tmpdir() }) {
  const t0 = Date.now();
  const done = (o) => ({ ...o, against: against || null, ms: Date.now() - t0 });
  if (!against) return done({});
  let scratch = null;
  try {
    const p = await prepare(repo, timeoutMs);
    if (p.error) return done({ unavailable: p.error });
    const v = await safeGit(['--version'], repo, timeoutMs, { prepared: p });
    const m = /(\d+)\.(\d+)/.exec(v.stdout || '');
    if (!m || Number(m[1]) < MIN_GIT[0] || (Number(m[1]) === MIN_GIT[0] && Number(m[2]) < MIN_GIT[1])) return done({ unavailable: `git ${m ? `${m[1]}.${m[2]}` : 'of unknown version'} is older than 2.38` });
    const c = await safeGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo, timeoutMs, { prepared: p });
    const common = c.executable && c.exit_code === 0 ? String(c.stdout).trim().split('\n')[0] : '';
    if (!common) return done({ unavailable: 'the repository\'s object directory was not found' });
    scratch = fs.mkdtempSync(path.join(scratchRoot, 'belay-forecast-'));
    const prepared = { ...p, env: { ...p.env, GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(common, 'objects') } };
    const r = await safeGit(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', against, head], repo, timeoutMs, { prepared });
    if (r.timed_out) return done({ unavailable: `timed out after ${timeoutMs} ms` });
    if (!r.executable) return done({ unavailable: r.spawn_error || 'git did not run' });
    if (r.exit_code === 0) return done({ clean: true });
    if (r.exit_code === 1) {
      const parts = String(r.stdout).split('\0').filter(Boolean);
      // git also exits 1 for a commit it cannot merge, with no tree on stdout: that is no conflict.
      if (!sha(parts[0]) || parts.length < 2) return done({ unavailable: `git merge-tree exited 1 with no conflict listed: ${String(r.stderr).trim().split('\n').pop() || 'no stderr'}`.slice(0, 200) });
      return done({ files: [...new Set(parts.slice(1))].slice(0, FILES_MAX) });
    }
    return done({ unavailable: `git merge-tree exited ${r.exit_code}: ${String(r.stderr).trim().split('\n').pop() || 'no stderr'}`.slice(0, 200) });
  } catch (e) {
    return done({ unavailable: String((e && e.message) || e).slice(0, 200) });
  } finally {
    if (scratch) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* a leftover scratch directory is harmless */ } }
  }
}

// The forecast for a released task: its branch tip against the run's integration branch (`belay/integrate/<run id>`, the default
// of integration.merge), both read in the task's repository. A task with no belay branch has nothing to forecast (null).
async function forecastTask(task, runId, opts = {}) {
  const wt = task && task.worktree;
  if (!wt || !wt.repo || !wt.branch) return null;
  const ref = async (name) => {
    const r = await safeGit(['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`], wt.repo, opts.timeoutMs || TIMEOUT_MS);
    return r.executable && r.exit_code === 0 ? sha(r.stdout) : null;
  };
  const head = await ref(wt.branch);
  if (!head) return null;
  return forecast({ repo: wt.repo, head, against: await ref(`belay/integrate/${runId}`), ...opts });
}

module.exports = { forecast, forecastTask, TIMEOUT_MS };
