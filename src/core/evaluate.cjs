'use strict';
// evaluate.cjs — running a task's acceptance criteria (api.md §3, `task.evaluate`).
//
// Every command runs through child_process.spawn with an argv array and no shell, so nothing in a spec
// is ever interpreted by cmd.exe or sh. A command that cannot be spawned at all (ENOENT) is not a
// failure to be reported as a red cross: it is `executable: false`, and a task whose checks are not all
// executable is never written `done`. Same for `files_within_owned` outside a git worktree.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const PROC = require('./process.cjs');

const DEFAULT_COMMAND_TIMEOUT_MS = 120000;
// The commands of one evaluation share this budget, inside the 600,000 ms a client waits for task.evaluate (index.cjs
// EVALUATE_TIMEOUT_MS), leaving room for the git checks and the write. Without it a task whose command timeouts summed past
// the client's wait was answered E_TIMEOUT "may have committed" and written done later (audit 0.3.1 P5).
const ACCEPTANCE_BUDGET_MS = 540000;
const TAIL = 2000;
const DEFAULT_BASE_REF = 'main';
// The default base resolves the branch, not the bare name: a worker's `git tag main` would win the bare name.
const DEFAULT_BASE_REV = `refs/heads/${DEFAULT_BASE_REF}`;

// Killing the direct child is not killing the command. `process.kill` on Windows is TerminateProcess on
// one handle: an acceptance command that spawned a test runner, a server or its own worker leaves those
// grandchildren running, holding ports and the worktree, long after the check is written `timed_out`.
// ADR 0039: the child handle proves the root (it has not exited), and the descendants come from one
// snapshot, kept only if created at or after their parent, killed leaves first, one pid at a time. No
// the old Windows tree-kill tool, which walks recorded parent pids that Windows keeps after a parent dies. The receipt
// carries `identity`. A child that has already exited is never killed.
async function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return { tool: 'process.kill', pid: child.pid || null, ok: true, already_exited: true };
  return PROC.killTree(child).catch(e => ({ tool: 'process.kill', pid: child.pid || null, ok: false, error: e.code || e.message }));
}

// One output stream, kept within TAIL characters. `keep: 'head'` keeps the start (git's short answers, read whole). `keep: 'ends'`
// keeps the first and last TAIL/2 characters with a marker naming what was cut between them, because an acceptance command's
// verdict (the summary line, the failing assertion) is at its end (audit 0.3.1 C3). `bytes` counts everything the stream sent.
// `keep: 'ends'` also keeps the test runner's failure section (from FAILING_MARK, at most SECTION characters) wherever it falls,
// since a long one can start before the kept tail and its first lines name the failing tests (try-2 gap 10).
const FAILING_MARK = '✖ failing tests:'; // node --test
const SECTION = 600;
function capture(keep, limit = TAIL) {
  const dec = new StringDecoder('utf8');
  const half = TAIL / 2;
  let head = '', tail = '', bytes = 0, chars = 0, section = null, look = '';
  return {
    add(d) {
      bytes += d.length;
      let s = dec.write(d);
      chars += s.length;
      if (keep !== 'ends') { if (head.length < limit) head += s; return; }
      if (section === null) { const j = look + s, i = j.indexOf(FAILING_MARK); if (i >= 0) section = j.slice(i, i + SECTION); look = j.slice(-FAILING_MARK.length); } else if (section.length < SECTION) section = (section + s).slice(0, SECTION);
      if (head.length < half) { const take = half - head.length; head += s.slice(0, take); s = s.slice(take); }
      if (s) tail = (tail + s).slice(-half);
    },
    get section() { return section; },
    get bytes() { return bytes; },
    get truncated() { return keep !== 'ends' ? head.length >= limit : chars > head.length + tail.length; },
    text() {
      if (keep !== 'ends') return head.slice(0, limit);
      const cut = chars - head.length - tail.length;
      return cut > 0 ? [head, `[... ${cut} characters omitted ...]`, tail].join(String.fromCharCode(10)) : head + tail;
    },
  };
}

// On Windows `npm` and `npx` are .cmd shims, which a spawn without a shell cannot start (ENOENT for the bare name, EINVAL for the
// .cmd). They are scripts run by the node that sits beside them, so the command is rewritten to that node and script. Anything
// else, and a Windows install whose script is not where it is expected, is spawned as written.
const NPM_SCRIPTS = { npm: 'npm-cli.js', npx: 'npx-cli.js' };
function resolveWindowsShim(argv, platform = process.platform, execPath = process.execPath, exists = fs.existsSync) {
  if (platform !== 'win32') return argv;
  const name = String(argv[0]).toLowerCase().replace(/\.cmd$/, '');
  if (!Object.hasOwn(NPM_SCRIPTS, name)) return argv; // a path such as ./npm is never a key, so it is the caller's own file
  const script = path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', NPM_SCRIPTS[name]);
  return exists(script) ? [execPath, script, ...argv.slice(1)] : argv;
}

// `env`, when given, replaces the child's environment (git.cjs passes the owner's own plus its fixed git variables), and
// `tail` raises the 2,000-character output cap for a caller that parses the whole output (`git worktree list`).
// `onChild(child)`, when given, is told the live child handle as soon as it is spawned (a cancel kills it by that handle).
// `keep: 'ends'` keeps the head and the tail of each stream (an acceptance command; capture above).
function runCommand(argvGiven, cwd, timeoutMs, { env, tail = TAIL, onChild, keep = 'head' } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    // A missing worktree or cwd is named as such: left to spawn it reads as ENOENT for the executable.
    if (cwd && !fs.existsSync(cwd)) {
      return resolve({ executable: false, exit_code: null, ms: Date.now() - t0, timed_out: false, stdout: '', stderr: '', spawn_error: `cwd does not exist: ${cwd}` });
    }
    const argv = resolveWindowsShim(argvGiven);
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) });
    } catch (e) {
      return resolve({ executable: false, exit_code: null, ms: Date.now() - t0, timed_out: false, stdout: '', stderr: '', spawn_error: e.code || e.message });
    }
    if (onChild) onChild(child);
    const out = capture(keep, tail), errText = capture(keep);
    let settled = false, timedOut = false, killing = null, pipesDropped = false;
    const timer = setTimeout(() => { timedOut = true; killing = killTree(child); }, timeoutMs);
    timer.unref();
    // ADR 0039: the exit, not the later close, ends the kill's right to fire (the pid may be reused from here on).
    // A grandchild that outlives its parent and holds our pipes would keep `close` from ever firing, and nothing
    // may kill it by a bare pid; so after a short grace our ends of the pipes are dropped and the survivor is left.
    child.once('exit', () => {
      if (timedOut) return;
      clearTimeout(timer);
      const drop = setTimeout(() => { pipesDropped = true; try { child.stdout.destroy(); child.stderr.destroy(); } catch { /* closed */ } }, 2000);
      drop.unref();
      child.once('close', () => clearTimeout(drop));
    });
    child.stdout.on('data', d => out.add(d));
    child.stderr.on('data', d => errText.add(d));
    const sizes = () => (keep === 'ends' ? { stdout_bytes: out.bytes, stderr_bytes: errText.bytes, ...(out.section ? { stdout_failing: out.section } : {}) } : {});
    // The direct child's `close` arrives while the tree kill is still walking the tree, so the result waits
    // for the kill to report: a caller that reads `timed_out` must be able to trust that the tree is
    // gone by the time it reads it, not merely that it was asked to go.
    const finish = r => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      Promise.resolve(killing).then(k => resolve({ ...r, tree_kill: k || null, ...(pipesDropped ? { pipes_dropped: 'the command exited but a process it started still held its output pipes; belay closed its ends after 2000 ms and left that process running' } : {}) }));
    };
    child.on('error', e => finish({ executable: false, exit_code: null, ms: Date.now() - t0, timed_out: timedOut, stdout: out.text(), stderr: errText.text(), ...sizes(), spawn_error: e.code || e.message }));
    child.on('close', (code, signal) => finish({
      executable: true, exit_code: code, signal: signal || null, ms: Date.now() - t0, timed_out: timedOut,
      stdout: out.text(), stderr: errText.text(), ...sizes(), truncated: out.truncated,
    }));
  });
}

// The tails a check reports, shared by task.evaluate and integration.merge: the last 400 characters of each stream, except that a
// test runner's failure section (capture's `section`) replaces the stdout tail when the tail does not already show its start; the
// last 200 characters of the output stay after it, joined by a marker, so the end of the run is not lost (400 characters in all).
const TAIL_JOIN = '\n[... end of output ...]\n';
function outputTails(r) {
  const out = String(r.stdout || ''), tail = out.slice(-400), sec = r.stdout_failing;
  const stdout_tail = sec && !tail.includes(FAILING_MARK) ? sec.slice(0, 400 - 200 - TAIL_JOIN.length) + TAIL_JOIN + out.slice(-200) : tail;
  return { stdout_tail, stderr_tail: String(r.stderr || '').slice(-400) };
}

// Forward slashes everywhere, no trailing slash, no leading './'. Windows paths compare case-blind.
function normalise(p) {
  let s = String(p).replace(/\\/g, '/').trim();
  s = path.posix.normalize(s).replace(/^\.\//, '').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

// A path is inside an owned path when it is that path or sits under it as a directory.
function within(p, owned) {
  const a = normalise(p);
  return owned.some(o => { const b = normalise(o); return a === b || a.startsWith(b + '/'); });
}

// `git status --porcelain -z`: NUL-separated entries, so no quoting and no ambiguity about odd paths.
// A rename or copy entry is followed by a second field holding the original path; both must be owned.
function parsePorcelainZ(buf) {
  const parts = buf.split('\0');
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (status[0] === 'R' || status[0] === 'C') { i++; if (parts[i]) paths.push(parts[i]); }
  }
  return paths;
}

// `git diff --name-status -z`: NUL-separated, a status field then its path, and a rename or copy
// (R or C, with a score) carries two paths. Both count, so a file moved out of an owned path is seen.
function parseNameStatusZ(buf) {
  const parts = buf.split('\0');
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (!status) continue;
    const n = (status[0] === 'R' || status[0] === 'C') ? 2 : 1;
    for (let k = 0; k < n; k++) { i++; if (parts[i]) paths.push(parts[i]); }
  }
  return paths;
}

// Resolves the ref the diff is judged from and the head it is judged to. An unresolved ref is reported,
// never guessed: the caller turns it into a check that is not executable.
async function resolveRefs(worktree, base) {
  const ref = base || DEFAULT_BASE_REF;
  if (base && base.startsWith('-')) return { failed: ref, stderr: 'a ref may not begin with a dash' };
  const b = base
    ? await runCommand(['git', 'rev-parse', '--verify', `${base}^{commit}`], worktree, 30000)
    : await runCommand(['git', 'merge-base', 'HEAD', DEFAULT_BASE_REV], worktree, 30000);
  if (!b.executable || b.exit_code !== 0 || !b.stdout.trim()) return { failed: ref, stderr: (b.stderr || b.spawn_error || '').trim().slice(0, 400) };
  const h = await runCommand(['git', 'rev-parse', 'HEAD'], worktree, 30000);
  if (!h.executable || h.exit_code !== 0 || !h.stdout.trim()) return { failed: 'HEAD', stderr: (h.stderr || h.spawn_error || '').trim().slice(0, 400) };
  return { ref, base_sha: b.stdout.trim(), head_sha: h.stdout.trim() };
}

// A `git status` refreshes and rewrites .git/index when it can take the lock; GIT_OPTIONAL_LOCKS=0 stops that, so judging a
// worker's tree never writes to it (ADR 0053 check, finding 1). git.cjs builds its environment on this one.
const readOnlyGitEnv = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0' });

// A changed set is judged whole or not at all: output past the cap would hide paths, so a truncated listing is not run.
const LIST_TAIL = 4 * 1024 * 1024;

// `baseSource` names where `base` came from (ADR 0053 decision 4): 'arg', 'recorded' (the task's worktree) or, with no base, 'default'.
async function filesWithinOwned(worktree, filesOwned, base, baseSource) {
  const t0 = Date.now();
  // --untracked-files=all matters: by default git collapses a wholly untracked directory to one entry
  // ("src/"), which sits outside every owned path below it and would fail an ownership check the worker
  // actually respected. -z removes quoting, so odd paths need no unescaping.
  // git-safe.cjs: belay's hardened argv and environment, so the repository's config (an fsmonitor, a filter) runs nothing.
  const r = await require('./git-safe.cjs').safeGit(['status', '--porcelain', '-z', '--untracked-files=all'], worktree, 30000, { tail: LIST_TAIL });
  if (!r.executable) {
    return { kind: 'files_within_owned', executable: false, ms: Date.now() - t0, passed: false, detail: { reason: 'git could not be run', error: r.spawn_error, worktree } };
  }
  if (r.exit_code !== 0) {
    return { kind: 'files_within_owned', executable: false, ms: Date.now() - t0, passed: false, detail: { reason: 'the worktree is not a git repository, so this check could not run', exit_code: r.exit_code, stderr: r.stderr.trim().slice(0, 400), worktree } };
  }
  const source = base ? (baseSource || 'arg') : 'default';
  const notRun = (reason, extra) => ({ kind: 'files_within_owned', executable: false, ms: Date.now() - t0, passed: false, detail: { reason, ...extra, base_source: source, worktree } });
  if (r.truncated) return notRun(`git status listed more than ${LIST_TAIL} characters, so the changed set is not known whole`, {});
  // A commit leaves a clean tree, so the working tree alone judges nothing: the diff from the base to
  // HEAD is what a worker's committed work looks like (ADR 0010 amendment 3).
  const refs = await resolveRefs(worktree, base);
  if (refs.failed) return notRun(`the ref ${refs.failed} could not be resolved, so the changed set is unknown`, { base_ref: base || DEFAULT_BASE_REF, failed_ref: refs.failed, stderr: refs.stderr });
  const d = await runCommand(['git', 'diff', '--name-status', '-z', '-M', refs.base_sha, 'HEAD'], worktree, 30000, { tail: LIST_TAIL, env: readOnlyGitEnv() });
  if (!d.executable || d.exit_code !== 0) return notRun('git diff from the base failed', { base_ref: refs.ref, base_sha: refs.base_sha, head_sha: refs.head_sha, exit_code: d.exit_code, stderr: (d.stderr || d.spawn_error || '').trim().slice(0, 400) });
  if (d.truncated) return notRun(`git diff listed more than ${LIST_TAIL} characters, so the changed set is not known whole`, { base_ref: refs.ref, base_sha: refs.base_sha, head_sha: refs.head_sha });
  const owned = Array.isArray(filesOwned) ? filesOwned : [];
  const changed = [...new Set([...parseNameStatusZ(d.stdout), ...parsePorcelainZ(r.stdout)])].sort();
  const outside = changed.filter(p => !within(p, owned));
  return {
    kind: 'files_within_owned', executable: true, ms: Date.now() - t0, passed: outside.length === 0,
    detail: { base_ref: refs.ref, base_source: source, base_sha: refs.base_sha, head_sha: refs.head_sha, empty_range: refs.base_sha === refs.head_sha, changed_count: changed.length, changed, outside, files_owned: owned },
  };
}

// A cancel token (ADR 0058): `cancel()` kills the command running now by its live child handle (exact identity, ADR 0039)
// and skips the rest. Returns the kills' receipts.
function createCancel() {
  const live = new Set();
  const c = { cancelled: false, by: null, live,
    async cancel(by) { c.cancelled = true; c.by = by || null; return Promise.all([...live].map((child) => killTree(child))); } };
  return c;
}

// A command's retries_on_fail, as task.create admits it (retriesError); anything else runs it once.
const RETRIES_MAX = 5;
const retriesOf = (c) => (Number.isSafeInteger(c.retries_on_fail) && c.retries_on_fail > 0 ? Math.min(c.retries_on_fail, RETRIES_MAX) : 0);
function retriesError(acceptance) {
  const commands = acceptance && Array.isArray(acceptance.commands) ? acceptance.commands : [];
  const bad = commands.find((c) => c && c.retries_on_fail != null && !(Number.isSafeInteger(c.retries_on_fail) && c.retries_on_fail >= 0 && c.retries_on_fail <= RETRIES_MAX));
  return bad ? `task.acceptance.commands retries_on_fail must be an integer from 0 to ${RETRIES_MAX}` : null;
}

// `beside(t0, t1)` (ADR 0061 section 4 (b)): the evaluations that ran beside a command, as [{ task_id, overlap_ms }]; a check with
// any records them as `concurrent`, so a flaky failure can be weighed against load.
async function runAcceptance(acceptance, worktree, filesOwned, { base, baseSource, cancel = null, budgetMs = ACCEPTANCE_BUDGET_MS, beside = null } = {}) {
  const checks = [];
  const until = Date.now() + budgetMs;
  const commands = (acceptance && Array.isArray(acceptance.commands)) ? acceptance.commands : [];
  for (const c of commands) {
    if (!c || !Array.isArray(c.argv) || c.argv.length === 0 || c.argv.some(x => typeof x !== 'string')) {
      checks.push({ kind: 'command', argv: c && c.argv, executable: false, exit_code: null, ms: 0, passed: false, detail: { reason: 'acceptance command argv must be a non-empty array of strings' } });
      continue;
    }
    if (cancel && cancel.cancelled) break; // the caller discards the run
    const cwd = c.cwd ? path.resolve(worktree, c.cwd) : worktree;
    const left = until - Date.now(), own = Number(c.timeout_ms) > 0 ? Number(c.timeout_ms) : DEFAULT_COMMAND_TIMEOUT_MS;
    if (left <= 0) {
      checks.push({ kind: 'command', argv: c.argv, executable: false, exit_code: null, ms: 0, passed: false, detail: { cwd, reason: `not run: the evaluation's commands share a budget of ${budgetMs} ms and it was spent`, budget_ms: budgetMs } });
      continue;
    }
    const once = async (room) => {
      let mine = null;
      const r = await runCommand(c.argv, cwd, Math.min(own, room), { keep: 'ends', ...(cancel ? { onChild: (ch) => { mine = ch; cancel.live.add(ch); if (cancel.cancelled) killTree(ch); } } : {}) });
      if (mine) cancel.live.delete(mine);
      return r;
    };
    const ok = (x) => x.executable && x.exit_code === 0 && !x.timed_out;
    const t0 = Date.now();
    let r = await once(left);
    // ADR 0060 decision 2: a command that ran and failed is run again, up to retries_on_fail times while the budget lasts. One that
    // passes after a failure passes, and is marked flaky with every attempt kept; one that cannot run is never retried.
    const attempts = [r];
    for (let n = 0; n < retriesOf(c) && r.executable && !ok(r) && !(cancel && cancel.cancelled) && until - Date.now() > 0; n++) {
      r = await once(until - Date.now());
      attempts.push(r);
    }
    const flaky = ok(r) && attempts.length > 1;
    const concurrent = beside ? beside(t0, Date.now()) : [];
    checks.push({
      kind: 'command', argv: c.argv, executable: r.executable, exit_code: r.exit_code, ms: attempts.reduce((s, a) => s + a.ms, 0),
      passed: ok(r), ...(flaky ? { flaky: true } : {}), ...(concurrent.length ? { concurrent } : {}),
      detail: { cwd, timed_out: r.timed_out, signal: r.signal || null, tree_kill: r.tree_kill || null, pipes_dropped: r.pipes_dropped || null, spawn_error: r.spawn_error || null, ...outputTails(r), stdout_bytes: r.stdout_bytes ?? null, stderr_bytes: r.stderr_bytes ?? null, ...(left < own ? { budget_capped_ms: left } : {}),
        ...(attempts.length > 1 ? { attempts: attempts.map((a) => ({ exit_code: a.exit_code, timed_out: a.timed_out, ms: a.ms, ...(ok(a) ? {} : { stderr_tail: a.stderr.slice(-200) }) })) } : {}) },
    });
  }
  if (acceptance && acceptance.files_within_owned && !(cancel && cancel.cancelled)) checks.push(await filesWithinOwned(worktree, filesOwned, base, baseSource));
  return checks;
}

module.exports = { outputTails, runAcceptance, retriesError, createCancel, runCommand, readOnlyGitEnv, resolveWindowsShim, filesWithinOwned, normalise, within, parsePorcelainZ, parseNameStatusZ, DEFAULT_BASE_REF, DEFAULT_COMMAND_TIMEOUT_MS, ACCEPTANCE_BUDGET_MS };
