'use strict';
// handback-commit.cjs — belay commits for a Codex worker. Codex's workspace-write sandbox denies the worktree's index lock, so a
// Codex coder cannot commit and its hand-back would name the base as its head. When a Codex worker has released a task, the run
// manager commits what is in the worker's own belay worktree, on the branch the task row records, before the hand-back is
// evaluated, and writes what it did to the task's hand-back (core task.recordCommit). Claude Code workers commit for themselves
// and are not touched. Facts only: a commit that could not be made is recorded with its reason and the head stays what it was.
// The whole commit has one bound (TOTAL_MS) and a stop ends the git call in flight by its child handle (job.cancel). A path that looks
// like a secret is never committed: the commit is refused and the paths are named.

const fs = require('node:fs');
const G = require('../core/git.cjs');
const PROC = require('../core/process.cjs');

const MSG_MAX = 72;
const TOTAL_MS = 120000;
// Well-known secret names; only a NEW (untracked) path is refused, so a tracked fixture a task modifies is committed. Example, sample and template env files are not secrets.
const SECRET = /^(\.env(\.(?!(example|sample|template)$).+)?|.*\.pem|.*\.key|id_(rsa|ed25519|ecdsa|dsa)(?!.*\.pub$).*|credentials(\.json)?|\.credentials|.*\.(p12|pfx|keystore|jks)|\.(npmrc|pypirc|netrc))$/i;

// The commit subject: the hand-back summary's first non-empty line, controls removed, cut; else a fixed line naming the worker.
function subjectOf(task, workerId) {
  const s = task && task.handoff && task.handoff.result && typeof task.handoff.result.summary === 'string' ? task.handoff.result.summary : '';
  const line = s.split(/\r?\n/).map((x) => x.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).find((x) => x) || '';
  return (line.length > MSG_MAX ? `${line.slice(0, MSG_MAX - 3).trimEnd()}...` : line) || `codex worker ${workerId}: hand-back`;
}

const norm = (p) => { const x = String(p || '').replace(/\\/g, '/').replace(/\/+$/, ''); return process.platform === 'win32' ? x.toLowerCase() : x; };
const secretsIn = (paths) => paths.filter((p) => SECRET.test(String(p).split('/').pop()));

// `git status --porcelain -z`: every path with a change staged, unstaged or untracked (a rename or copy puts its old path second, and both count),
// and the paths that are new (untracked or staged as added), which are the only ones the secret rule refuses.
function parseStatus(out) {
  const parts = String(out).split('\0');
  const all = []; const fresh = [];
  for (let i = 0; i < parts.length; i += 1) {
    const e = parts[i];
    if (!e) continue;
    const xy = e.slice(0, 2), p = e.slice(3);
    all.push(p);
    if (xy === '??' || xy[0] === 'A') fresh.push(p);
    if (/[RC]/.test(xy)) { i += 1; if (parts[i]) all.push(parts[i]); }
  }
  return { all: [...new Set(all)], fresh };
}

// One commit job: its git calls share a deadline and a cancel. `job.cancel(by)` ends the call in flight and refuses the next.
function newJob(totalMs = TOTAL_MS) {
  const job = { cancelled: null, child: null, deadline: Date.now() + totalMs };
  job.cancel = (by) => { job.cancelled = by || 'a stop'; return job.child ? PROC.killTree(job.child).catch(() => {}) : Promise.resolve(); };
  job.git = async (cwd, args) => {
    const room = job.deadline - Date.now();
    if (job.cancelled) return { ok: false, exit_code: null, stdout: '', stderr: `cancelled by ${job.cancelled}` };
    if (room <= 0) return { ok: false, exit_code: null, stdout: '', stderr: `the hand-back commit passed its ${Math.round(totalMs / 1000)} s bound` };
    const r = await G.run(cwd, args, { timeoutMs: room, onChild: (c) => { job.child = c; if (job.cancelled) PROC.killTree(c).catch(() => {}); } });
    job.child = null;
    if (job.cancelled) return { ...r, ok: false, stderr: `cancelled by ${job.cancelled}; ${r.stderr}`.trim() };
    return r.timed_out ? { ...r, stderr: `timed out; ${r.stderr}`.trim() } : r;
  };
  return job;
}

// Why a git call failed, for the plan: 'bound' (cancelled or out of time), 'identity' (no author configured), 'signing', else `dflt` ('hook' for a commit:
// the output of a failing pre-commit or commit-msg hook is what the worker can act on; 'add' for a stale lock or an unreadable file).
function reasonOf(r, dflt) {
  const t = String(r.stderr || '');
  if (r.timed_out || /^cancelled by|passed its \d+ s bound|^timed out/.test(t)) return 'bound';
  if (/Author identity unknown|unable to auto-detect email|Committer identity unknown|empty ident name/i.test(t)) return 'identity';
  if (/gpg|signing|sign the data/i.test(t)) return 'signing';
  return dflt;
}

// A commit that fails after pre-commit passed was refused by a later hook (commit-msg or prepare-commit-msg), which rejects belay's own subject:
// the worker cannot fix that. Git writes COMMIT_EDITMSG only after pre-commit, so a fresh one holding our subject, with a commit-msg hook present, says so.
async function msgHookRefused(job, cwd, startedAt, subject) {
  const path = async (p) => ((await job.git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', p])).stdout || '').trim();
  try {
    const hook = await path('hooks/commit-msg'), edit = await path('COMMIT_EDITMSG');
    if (!hook || !edit || !fs.existsSync(hook) || !fs.existsSync(edit)) return false;
    return fs.statSync(edit).mtimeMs >= startedAt - 1000 && fs.readFileSync(edit, 'utf8').startsWith(subject);
  } catch { return false; }
}

// belay ended its own commit (a stop or the bound) and may have left the index lock git held. It is removed only when it was not there before the commit
// began, it appeared after the commit started, and no git process is running at all (a snapshot that cannot be read removes nothing). -> text for the error.
async function dropOwnLock(lock, existedBefore, startedAt, snapshot = () => PROC.processSnapshot()) {
  try {
    if (!lock || !fs.existsSync(lock)) return '';
    if (existedBefore) return `; ${lock} was there before the commit began and is left`;
    if (fs.statSync(lock).mtimeMs < startedAt - 1000) return `; ${lock} predates the commit and is left`;
    const snap = await snapshot();
    if (!snap) return `; ${lock} may be from the ended commit and is left (the process list could not be read)`;
    const rows = snap instanceof Map ? [...snap.values()] : Object.values(snap);
    if (rows.some((r) => /^git(\.exe)?$/i.test(String((r && r.image) || '').split(/[\\/]/).pop()))) return `; ${lock} may be from the ended commit, but another git process is running, so it is left`;
    fs.unlinkSync(lock);
    return `; the index.lock the ended commit left was removed`;
  } catch (e) { return `; ${lock} could not be checked or removed (${(e && e.code) || e})`; }
}

// -> the commit fact to record: { made, head, branch, files?, paths?, message?, error? }, or null when this hand-back is not belay's to commit
// (not a Codex worker, or the task has no belay worktree). Never throws.
async function commitFor(w, task, job = newJob()) {
  if (!w || w.substrate !== 'codex') return null;
  const rec = task && task.worktree;
  if (!rec || !rec.path || rec.removed_at) return null;
  const branch = rec.branch || null;
  let head = null;
  const fact = (o) => ({ made: false, branch, head, ...o });
  try {
    if (w.worktree && norm(w.worktree) !== norm(rec.path)) return fact({ reason: 'tree', error: `worker ${w.id} runs in ${w.worktree}, not in the task's worktree ${rec.path}; nothing was committed` });
    const cwd = rec.path;
    const head0 = await job.git(cwd, ['rev-parse', 'HEAD']);
    head = head0.ok ? head0.stdout.trim() : null;
    const sym = await job.git(cwd, ['symbolic-ref', '-q', 'HEAD']);
    const on = sym.ok ? sym.stdout.trim() : '';
    if (!on) return fact({ reason: 'head', error: 'HEAD is detached in the worktree; nothing was committed' });
    if (!branch || on !== `refs/heads/${branch}`) return fact({ reason: 'head', error: `the worktree is on ${on.replace(/^refs\/heads\//, '')}, not on the task's branch ${branch}; nothing was committed` });
    // Everything the commit will hold: staged (a refused earlier commit leaves belay's own add staged), unstaged and untracked; ignored files left out.
    const st = await job.git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
    if (!st.ok) return fact({ reason: reasonOf(st, 'git'), error: `git could not list the worktree changes: ${(st.stderr || `exit ${st.exit_code}`).slice(0, 200)}; nothing was committed` });
    const { all: dirty, fresh } = parseStatus(st.stdout);
    if (!dirty.length) return fact({});
    const secrets = secretsIn(fresh);
    if (secrets.length) return fact({ reason: 'secret', error: `not committed: ${secrets.slice(0, 10).join(', ')} look${secrets.length === 1 ? 's' : ''} like a secret; remove ${secrets.length === 1 ? 'it' : 'them'} from the worktree or ignore ${secrets.length === 1 ? 'it' : 'them'}` });
    const add = await job.git(cwd, ['add', '-A']);
    if (!add.ok) return fact({ reason: reasonOf(add, 'add'), error: `git add failed: ${add.stderr || `exit ${add.exit_code}`}` });
    const message = subjectOf(task, w.id);
    const lock = ((await job.git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index.lock'])).stdout || '').trim();
    const lockBefore = !!lock && fs.existsSync(lock);
    const startedAt = Date.now();
    const c = await job.git(cwd, ['commit', '-m', message]);
    if (!c.ok) {
      let reason = reasonOf(c, 'hook'), note = '';
      if (reason === 'bound') note = await dropOwnLock(lock, lockBefore, startedAt);
      else if (reason === 'hook' && await msgHookRefused(job, cwd, startedAt, message)) reason = 'hook-msg';
      return fact({ reason, error: `git commit failed: ${(c.stderr || `exit ${c.exit_code}`).slice(0, 300)}${note}` });
    }
    const h = await job.git(cwd, ['rev-parse', 'HEAD']);
    if (!h.ok || !h.stdout.trim() || h.stdout.trim() === head) return fact({ reason: 'moved', error: 'git commit reported success but HEAD did not move' });
    return { made: true, head: h.stdout.trim(), branch, files: dirty.length, paths: dirty, message };
  } catch (e) {
    return fact({ error: `${(e && e.message) || e}`.slice(0, 300) });
  }
}

// Commits for the Codex worker `w` that released `taskId`, and records it. -> the recorded commit, or null. Never throws: a recording
// that fails is a worker lastError. `ev` (the release evaluation) gets `ev.cancelCommit`, which a stop calls.
async function handBack(w, ctx, taskId, ev = null) {
  if (!w || w.substrate !== 'codex' || !ctx.core || !ctx.core.task || typeof ctx.core.task.recordCommit !== 'function') return null;
  const job = newJob();
  if (ev) ev.cancelCommit = job.cancel;
  try {
    const task = await ctx.core.task.get({ task_id: taskId });
    if (!task || task.state !== 'released' || !task.handoff || task.handoff.by !== w.id) return null;
    const commit = await commitFor(w, task, job);
    if (!commit) return null;
    await ctx.core.task.recordCommit({ task_id: taskId, worker_id: w.id, lease_id: task.handoff.lease_id, commit });
    return commit;
  } catch (e) {
    w.lastError = { where: 'handback-commit', code: e && e.code, message: e && e.message };
    return null;
  } finally { if (ev) ev.cancelCommit = null; }
}

module.exports = { dropOwnLock, parseStatus, commitFor, handBack, subjectOf, newJob, secretsIn, reasonOf, TOTAL_MS };
