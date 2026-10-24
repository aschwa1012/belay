'use strict';
// evaluate.cjs — running a task's acceptance criteria (api.md §3, `task.evaluate`).
//
// Every command runs through child_process.spawn with an argv array and no shell, so nothing in a spec
// is ever interpreted by cmd.exe or sh. A command that cannot be spawned at all (ENOENT) is not a
// failure to be reported as a red cross: it is `executable: false`, and a task whose checks are not all
// executable is never written `done`. Same for `files_within_owned` outside a git worktree.

const { spawn } = require('node:child_process');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const PROC = require('./process.cjs');

const DEFAULT_COMMAND_TIMEOUT_MS = 120000;
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
function capture(keep) {
  const dec = new StringDecoder('utf8');
  const half = TAIL / 2;
  let head = '', tail = '', bytes = 0, chars = 0;
  return {
    add(d) {
      bytes += d.length;
      let s = dec.write(d);
      chars += s.length;
      if (keep !== 'ends') { if (head.length < TAIL) head += s; return; }
      if (head.length < half) { const take = half - head.length; head += s.slice(0, take); s = s.slice(take); }
      if (s) tail = (tail + s).slice(-half);
    },
    get bytes() { return bytes; },
    text() {
      if (keep !== 'ends') return head.slice(0, TAIL);
      const cut = chars - head.length - tail.length;
      return cut > 0 ? `${head}
[... ${cut} characters omitted ...]
${tail}` : head + tail;
    },
  };
}

function runCommand(argv, cwd, timeoutMs, { keep = 'head' } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ executable: false, exit_code: null, ms: Date.now() - t0, timed_out: false, stdout: '', stderr: '', spawn_error: e.code || e.message });
    }
    const out = capture(keep), errText = capture(keep);
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
    const sizes = () => (keep === 'ends' ? { stdout_bytes: out.bytes, stderr_bytes: errText.bytes } : {});
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
      stdout: out.text(), stderr: errText.text(), ...sizes(),
    }));
  });
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

async function filesWithinOwned(worktree, filesOwned, base) {
  const t0 = Date.now();
  // --untracked-files=all matters: by default git collapses a wholly untracked directory to one entry
  // ("src/"), which sits outside every owned path below it and would fail an ownership check the worker
  // actually respected. -z removes quoting, so odd paths need no unescaping.
  const r = await runCommand(['git', 'status', '--porcelain', '-z', '--untracked-files=all'], worktree, 30000);
  if (!r.executable) {
    return { kind: 'files_within_owned', executable: false, ms: Date.now() - t0, passed: false, detail: { reason: 'git could not be run', error: r.spawn_error, worktree } };
  }
  if (r.exit_code !== 0) {
    return { kind: 'files_within_owned', executable: false, ms: Date.now() - t0, passed: false, detail: { reason: 'the worktree is not a git repository, so this check could not run', exit_code: r.exit_code, stderr: r.stderr.trim().slice(0, 400), worktree } };
  }
  const notRun = (reason, extra) => ({ kind: 'files_within_owned', executable: false, ms: Date.now() - t0, passed: false, detail: { reason, ...extra, worktree } });
  // A commit leaves a clean tree, so the working tree alone judges nothing: the diff from the base to
  // HEAD is what a worker's committed work looks like (ADR 0010 amendment 3).
  const refs = await resolveRefs(worktree, base);
  if (refs.failed) return notRun(`the ref ${refs.failed} could not be resolved, so the changed set is unknown`, { base_ref: base || DEFAULT_BASE_REF, failed_ref: refs.failed, stderr: refs.stderr });
  const d = await runCommand(['git', 'diff', '--name-status', '-z', '-M', refs.base_sha, 'HEAD'], worktree, 30000);
  if (!d.executable || d.exit_code !== 0) return notRun('git diff from the base failed', { base_ref: refs.ref, base_sha: refs.base_sha, head_sha: refs.head_sha, exit_code: d.exit_code, stderr: (d.stderr || d.spawn_error || '').trim().slice(0, 400) });
  const owned = Array.isArray(filesOwned) ? filesOwned : [];
  const changed = [...new Set([...parseNameStatusZ(d.stdout), ...parsePorcelainZ(r.stdout)])].sort();
  const outside = changed.filter(p => !within(p, owned));
  return {
    kind: 'files_within_owned', executable: true, ms: Date.now() - t0, passed: outside.length === 0,
    detail: { base_ref: refs.ref, base_sha: refs.base_sha, head_sha: refs.head_sha, empty_range: refs.base_sha === refs.head_sha, changed_count: changed.length, changed, outside, files_owned: owned },
  };
}

async function runAcceptance(acceptance, worktree, filesOwned, { base } = {}) {
  const checks = [];
  const commands = (acceptance && Array.isArray(acceptance.commands)) ? acceptance.commands : [];
  for (const c of commands) {
    if (!c || !Array.isArray(c.argv) || c.argv.length === 0 || c.argv.some(x => typeof x !== 'string')) {
      checks.push({ kind: 'command', argv: c && c.argv, executable: false, exit_code: null, ms: 0, passed: false, detail: { reason: 'acceptance command argv must be a non-empty array of strings' } });
      continue;
    }
    const cwd = c.cwd ? path.resolve(worktree, c.cwd) : worktree;
    const r = await runCommand(c.argv, cwd, Number(c.timeout_ms) > 0 ? Number(c.timeout_ms) : DEFAULT_COMMAND_TIMEOUT_MS, { keep: 'ends' });
    checks.push({
      kind: 'command', argv: c.argv, executable: r.executable, exit_code: r.exit_code, ms: r.ms,
      passed: r.executable && r.exit_code === 0 && !r.timed_out,
      detail: { cwd, timed_out: r.timed_out, signal: r.signal || null, tree_kill: r.tree_kill || null, pipes_dropped: r.pipes_dropped || null, spawn_error: r.spawn_error || null, stdout_tail: r.stdout.slice(-400), stderr_tail: r.stderr.slice(-400), stdout_bytes: r.stdout_bytes ?? null, stderr_bytes: r.stderr_bytes ?? null },
    });
  }
  if (acceptance && acceptance.files_within_owned) checks.push(await filesWithinOwned(worktree, filesOwned, base));
  return checks;
}

module.exports = { runAcceptance, runCommand, filesWithinOwned, normalise, within, parsePorcelainZ, parseNameStatusZ, DEFAULT_BASE_REF, DEFAULT_COMMAND_TIMEOUT_MS };
