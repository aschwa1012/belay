'use strict';
// conflict-forecast.cjs — a dry run of the merge a released task's branch would make into the integration branch, so the
// orchestrator hears of a conflict before it calls integrate. A warning field only: it never blocks, retries or acts, and every
// failure of its own is `unavailable`, never an error.
// - `git merge-tree --write-tree --name-only -z <against> <head>` exits 1 on a conflict (the conflicted paths follow the tree id),
//   0 when the merge is clean. It needs git 2.38.
// - It writes the merged tree as objects, and the repository is shared with the user, so they go to a scratch directory:
//   GIT_OBJECT_DIRECTORY is the scratch and the repository's own objects are its only alternate. No object, ref, index or
//   config of the repository is written, and its object count is unchanged. What still changes: git freshens the modification time
//   of an object it would have written that already exists in the alternate (a pack file's mtime, a matching loose object's),
//   which only postpones that object's pruning by gc. Content is never touched.
// - Every git call goes through git-safe.cjs, hardened. One forecast has one overall deadline (`totalMs`), not one per call: the
//   git calls share what is left of it, and the whole call resolves `unavailable` when it passes, whatever git is doing.
// Results: `{ files, against, ms }` (conflict), `{ clean: true, against, ms }`, `{ against: null, ms }` (no integration head yet),
// `{ unavailable: <why>, against, ms }`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { safeGit, prepare } = require('./git-safe.cjs');

const TOTAL_MS = 5000;
const MIN_GIT = [2, 38];
const FILES_MAX = 50;

const noop = () => {};
// The result carries `exited` (not enumerable): a promise that resolves when every git call the forecast made has exited, which can be after
// the deadline returned the result. A caller capping how many forecasts run counts one as running until then.
const withExited = (o, p) => Object.defineProperty(o, 'exited', { value: Promise.resolve(p).then(noop, noop), enumerable: false, configurable: true });

const sha = (s) => { const l = String(s || '').trim().split('\n')[0]; return /^[0-9a-f]{40,64}$/.test(l) ? l : null; };

// The forecast of merging `head` into `against` (both commits of the repository at `repo`; `against` null when the integration
// branch does not exist yet). `scratchRoot` is where the throwaway object directory goes (a test points it elsewhere). `prepared`
// (git-safe prepare's result) and `deadline` (epoch ms) are shared by a caller that already spent some of the forecast's budget.
async function forecast({ repo, head, against, totalMs = TOTAL_MS, scratchRoot = os.tmpdir(), prepared = null, deadline = null }) {
  const t0 = Date.now();
  const end = deadline || t0 + totalMs;
  const left = () => Math.max(1, end - Date.now());
  const done = (o) => ({ ...o, against: against || null, ms: Date.now() - t0 });
  if (!against) return done({});
  let scratch = null;
  let timer = null;
  let settled = false;
  const work = (async () => {
    const p = prepared || await prepare(repo, left());
    if (p.error) return done({ unavailable: p.error });
    const v = await safeGit(['--version'], repo, left(), { prepared: p });
    const m = /(\d+)\.(\d+)/.exec(v.stdout || '');
    if (!m || Number(m[1]) < MIN_GIT[0] || (Number(m[1]) === MIN_GIT[0] && Number(m[2]) < MIN_GIT[1])) return done({ unavailable: `git ${m ? `${m[1]}.${m[2]}` : 'of unknown version'} is older than 2.38` });
    const c = await safeGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo, left(), { prepared: p });
    const common = c.executable && c.exit_code === 0 ? String(c.stdout).trim().split('\n')[0] : '';
    if (!common) return done({ unavailable: 'the repository\'s object directory was not found' });
    scratch = fs.mkdtempSync(path.join(scratchRoot, 'belay-forecast-'));
    const scratched = { ...p, env: { ...p.env, GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(common, 'objects') } };
    const r = await safeGit(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', against, head], repo, left(), { prepared: scratched });
    if (r.timed_out) return done({ unavailable: `timed out after ${Date.now() - t0} ms` });
    if (!r.executable) return done({ unavailable: r.spawn_error || 'git did not run' });
    if (r.exit_code === 0) return done({ clean: true });
    if (r.exit_code === 1) {
      const parts = String(r.stdout).split('\0').filter(Boolean);
      // git also exits 1 for a commit it cannot merge, with no tree on stdout: that is no conflict.
      if (!sha(parts[0]) || parts.length < 2) return done({ unavailable: `git merge-tree exited 1 with no conflict listed: ${String(r.stderr).trim().split('\n').pop() || 'no stderr'}`.slice(0, 200) });
      return done({ files: [...new Set(parts.slice(1))].slice(0, FILES_MAX) });
    }
    return done({ unavailable: `git merge-tree exited ${r.exit_code}: ${String(r.stderr).trim().split('\n').pop() || 'no stderr'}`.slice(0, 200) });
  })().catch((e) => done({ unavailable: String((e && e.message) || e).slice(0, 200) })).finally(() => { settled = true; });
  const late = new Promise((res) => { timer = setTimeout(() => res(done({ unavailable: `deadline of ${end - t0} ms passed` })), left()); });
  try { return withExited(await Promise.race([work, late]), work); } finally {
    clearTimeout(timer);
    // A git call still running past the deadline holds the scratch directory on Windows; its own timeout kills it, so retry once it has.
    const rm = () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* a leftover scratch directory is harmless */ } };
    if (scratch) { if (settled) rm(); else work.then(rm, rm); }
  }
}

// The forecast for a released task: its branch tip against the run's integration branch (`belay/integrate/<run id>`, the default
// of integration.merge), both read in the task's repository with one shared preparation and one overall deadline. A task with no
// belay branch has nothing to forecast (null).
async function forecastTask(task, runId, opts = {}) {
  const wt = task && task.worktree;
  if (!wt || !wt.repo || !wt.branch) return null;
  const t0 = Date.now();
  const deadline = t0 + (opts.totalMs || TOTAL_MS);
  let timer = null;
  // The whole call ends at the deadline even while a git call is still being killed (a kill can take longer than the call's timeout).
  const late = new Promise((res) => { timer = setTimeout(() => res({ unavailable: `deadline of ${deadline - t0} ms passed`, against: null, ms: Date.now() - t0 }), deadline - t0); });
  const inner = forecastWithin(wt, runId, opts, t0, deadline);
  try { const r = await Promise.race([inner, late]); return r && withExited(r, inner.then((x) => x && x.exited, noop)); } finally { clearTimeout(timer); }
}

async function forecastWithin(wt, runId, opts, t0, deadline) {
  const left = () => Math.max(1, deadline - Date.now());
  let prepared;
  try { prepared = await prepare(wt.repo, left()); } catch (e) { prepared = { error: String((e && e.message) || e).slice(0, 200) }; }
  if (prepared.error) return { unavailable: prepared.error, against: null, ms: Date.now() - t0 };
  const ref = async (name) => {
    const r = await safeGit(['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`], wt.repo, left(), { prepared });
    return r.executable && r.exit_code === 0 ? sha(r.stdout) : null;
  };
  const head = await ref(wt.branch);
  if (!head) return null;
  const against = await ref(`belay/integrate/${runId}`);
  return forecast({ repo: wt.repo, head, against, prepared, deadline, scratchRoot: opts.scratchRoot });
}

module.exports = { forecast, forecastTask, TOTAL_MS };
