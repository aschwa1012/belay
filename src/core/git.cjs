'use strict';
// git.cjs — the git calls core makes for worktrees and integration (ADR 0053). Every call is a fixed argv through
// evaluate.cjs's runCommand: no shell, a bounded child the caller waits on, killed by its handle on timeout (ADR 0039).
// The environment is the owner's own with prompts and editors turned off, so no call can wait on a person.

const { err } = require('./errors.cjs');
const { runCommand, parsePorcelainZ } = require('./evaluate.cjs');

const GIT_TIMEOUT_MS = 120000; // a checkout of a large tree (this repository: about 10,800 files) takes seconds
const LIST_TAIL = 4 * 1024 * 1024;

const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' });

const fwd = (p) => String(p).split('\\').join('/');

// Runs `git <args>` in `cwd`. Resolves { ok, exit_code, stdout, stderr, argv } and never throws: the caller decides
// whether a failure is a refusal (`must`) or a fact to report.
async function run(cwd, args, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const argv = ['git', ...args];
  const r = await runCommand(argv, cwd, timeoutMs, { env: gitEnv(), tail: LIST_TAIL });
  return {
    ok: r.executable && r.exit_code === 0 && !r.timed_out && !r.truncated, exit_code: r.exit_code, timed_out: r.timed_out,
    stdout: r.stdout, stderr: (r.stderr || r.spawn_error || '').trim().slice(0, 800), argv, cwd: fwd(cwd),
  };
}

const failure = (r, what) => err('E_GIT', `${what}: git ${r.argv.slice(1).join(' ')} exited ${r.timed_out ? 'by timeout' : r.exit_code}${r.stderr ? `: ${r.stderr.split('\n')[0]}` : ''}`,
  { argv: r.argv, cwd: r.cwd, exit_code: r.exit_code, timed_out: !!r.timed_out, stderr: r.stderr });

async function must(cwd, args, what, opts) {
  const r = await run(cwd, args, opts);
  if (!r.ok) throw failure(r, what);
  return r.stdout;
}

// The top of the work tree that contains `dir`, forward slashes.
async function toplevel(dir) {
  return fwd((await must(dir, ['rev-parse', '--show-toplevel'], `${fwd(dir)} is not inside a git work tree`)).trim());
}

// A ref resolved to the commit it names. A ref that begins with a dash would be read as an option, so it is refused.
async function commitOf(cwd, ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-')) throw err('E_ARGS', `a base must be a ref or commit that does not begin with a dash, got ${JSON.stringify(ref)}`, { base: ref });
  return (await must(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], `the base ${ref} does not name a commit`)).trim();
}

async function validBranch(cwd, name) {
  if (typeof name !== 'string' || !name || name.startsWith('-')) throw err('E_ARGS', `a branch name may not be empty or begin with a dash, got ${JSON.stringify(name)}`, { branch: name });
  const r = await run(cwd, ['check-ref-format', '--branch', name]);
  if (!r.ok) throw err('E_ARGS', `${name} is not a valid branch name`, { branch: name, stderr: r.stderr });
  return name;
}

async function branchExists(cwd, name) {
  return (await run(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])).ok;
}

// `git status --porcelain -z --untracked-files=all`: every changed or untracked path (ignored files excluded).
async function dirtyPaths(cwd) {
  const out = await must(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'], `the status of ${fwd(cwd)} could not be read`);
  return out.split('\0').filter(Boolean).map((e) => e.slice(3)).filter((p) => p);
}

// `git worktree list --porcelain`: [{ path, head, branch }] with branch as the short name, or null when detached.
async function worktrees(cwd) {
  const out = await must(cwd, ['worktree', 'list', '--porcelain'], 'the worktree list could not be read');
  const list = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: fwd(line.slice(9).trim()), head: null, branch: null }; list.push(cur); }
    else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5).trim();
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
  }
  return list;
}

const samePath = (a, b) => {
  const x = fwd(a).replace(/\/+$/, ''), y = fwd(b).replace(/\/+$/, '');
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

module.exports = { run, must, failure, toplevel, commitOf, validBranch, branchExists, dirtyPaths, worktrees, samePath, fwd, GIT_TIMEOUT_MS };
