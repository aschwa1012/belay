'use strict';
// Finding the Claude Code and Codex CLI executables. Order, first hit wins:
//   1. the environment variable BELAY_CLAUDE_EXE / BELAY_CODEX_EXE,
//   2. the config key claude_exe / codex_exe (the CLI exports a configured value into the environment
//      before it launches anything, so every child process sees the same answer),
//   3. a search of PATH for `claude` / `codex`.
// Node spawns no .cmd/.bat without a shell, so an npm shim (`claude.cmd`) is never returned: it is
// followed to the real executable the npm package ships beside it. A native or winget install puts a
// real claude.exe on PATH, which is returned as found. No shell is started. Nothing here runs unless a
// command is about to launch a worker or `belay doctor` asks, so read commands do not pay for it.

const fs = require('node:fs');
const path = require('node:path');

const SPECS = {
  claude: {
    env: 'BELAY_CLAUDE_EXE',
    key: 'claude_exe',
    names: ['claude'],
    // Relative to the npm prefix directory that holds the shim.
    shimTargets: ['node_modules/@anthropic-ai/claude-code/bin/claude.exe'],
  },
  codex: {
    env: 'BELAY_CODEX_EXE',
    key: 'codex_exe',
    names: ['codex'],
    shimTargets: [
      'node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
      'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
    ],
  },
};

const fwd = (p) => String(p).split(path.sep).join('/');
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// The absolute PATH entries, in order, with surrounding quotes removed. `env` is injectable for tests.
function pathDirs(env) {
  const raw = env.PATH !== undefined ? env.PATH : (env.Path !== undefined ? env.Path : '');
  return String(raw).split(path.delimiter).map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
    // A relative entry would resolve against the worktree an agent can write to, so only absolute ones count.
    .filter((d) => path.isAbsolute(d));
}

// Search PATH for one tool. A real `.exe` wins in its own directory; otherwise a shim (`.cmd`, or the
// extensionless script npm also writes) is followed to the package's executable.
function searchPath(spec, env) {
  for (const dir of pathDirs(env)) {
    for (const name of spec.names) {
      const exe = path.join(dir, `${name}.exe`);
      if (isFile(exe)) return fwd(exe);
      if (isFile(path.join(dir, `${name}.cmd`)) || isFile(path.join(dir, name))) {
        for (const rel of spec.shimTargets) {
          const target = path.join(dir, rel);
          if (isFile(target)) return fwd(target);
        }
      }
    }
  }
  return null;
}

// Resolve one tool. `configured` is the config key's resolved path or null. Returns
// { path, source } where source is 'env', 'config' or 'PATH', or { path: null, source: null, error }.
// An env or config value is returned as given even if the file is absent: the operator named it, and
// the launch (or doctor) then reports that exact path rather than silently looking elsewhere.
function resolveTool(which, { env = process.env, configured = null } = {}) {
  const spec = SPECS[which];
  if (env[spec.env]) return { path: fwd(env[spec.env]), source: 'env' };
  if (configured) return { path: fwd(configured), source: 'config' };
  const found = searchPath(spec, env);
  if (found) return { path: found, source: 'PATH' };
  return {
    path: null, source: null,
    error: `no ${which} executable found: set ${spec.env} to its full path, set "${spec.key}" in the belay config, or put ${spec.names[0]} on PATH`,
  };
}

// The launch-time answer, memoised (hits only) per tool per PATH. Throws the clear error when nothing
// is found, so a launch fails naming the variable instead of spawning a bogus path.
const cache = new Map();
function exeFor(which, env = process.env) {
  const spec = SPECS[which];
  if (env[spec.env]) return fwd(env[spec.env]);
  const key = `${which}|${env.PATH || env.Path || ''}`;
  if (cache.has(key)) return cache.get(key);
  const r = resolveTool(which, { env });
  if (!r.path) throw new Error(r.error); // a miss is not cached: claude may be installed while the process lives
  cache.set(key, r.path);
  return r.path;
}

// Called once by a command that is about to launch: a configured path becomes the environment value,
// unless the operator already set the variable (the environment outranks the file).
function exportConfigured(found, effective, env = process.env) {
  for (const which of Object.keys(SPECS)) {
    const spec = SPECS[which];
    if (env[spec.env]) continue;
    const eff = effective(found, spec.key, {});
    if (eff && eff.resolved) env[spec.env] = eff.resolved;
  }
}

module.exports = { SPECS, resolveTool, searchPath, exeFor, exportConfigured, pathDirs };
