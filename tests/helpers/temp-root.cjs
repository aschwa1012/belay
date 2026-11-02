'use strict';
// tests/helpers/temp-root.cjs — keeps the suite's scratch files out of folders the OS indexes and scans.
// Agents that pointed TEMP at a folder under the user's Projects directory put thousands of sandbox entries
// (belay-test-tmp-*) into the Windows Search index, whose crawl and Defender's scan of each file pin kernel
// pool memory per file. A temp root that resolves inside the user's home (outside AppData), or inside a
// folder named in BELAY_TEST_INDEXED_ROOTS (a path-delimited list), is refused: the caller falls back to the
// real OS temp dir and says so on stderr. BELAY_TEST_TEMP_ALLOW_INDEXED=1 keeps the chosen root (for a runner
// whose temp lives under its home on purpose; nothing sets it by default). Paths are compared through the
// native realpath, so an 8.3 short name or a junction to an indexed folder is caught too.
// Loaded by tests/helpers/tmp.cjs, git-env.cjs and tests/mcp/rpc.cjs, so a bare `node --test file` reaches it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The real path of `p`; for a path that does not exist yet, the real path of its deepest existing ancestor plus the rest.
function real(p) {
  let cur = path.resolve(String(p));
  const rest = [];
  for (;;) {
    try { cur = fs.realpathSync.native(cur); break; } catch { /* missing or unreadable: try the parent */ }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(cur, ...rest);
}
const norm = (p) => real(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const under = (child, parent) => child === parent || child.startsWith(`${parent}/`);

// Why `dir` is an indexed location, or null. Pure apart from reading the file system for real paths.
function indexedReason(dir, { env = process.env, home = os.homedir() } = {}) {
  const d = norm(dir);
  for (const extra of String(env.BELAY_TEST_INDEXED_ROOTS || '').split(path.delimiter).filter(Boolean)) {
    if (under(d, norm(extra))) return `inside the indexed root ${extra}`;
  }
  if (home) {
    const h = norm(home);
    if (under(d, h) && !under(d, `${h}/appdata`)) return `inside the home folder ${home} (outside AppData)`;
  }
  return null;
}

// The real OS temp dir of a parent environment: %LOCALAPPDATA%\Temp on Windows, else the platform default.
function fallbackTemp({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Temp');
  return '/tmp';
}

// { dir, refused, reason }: the temp root to use. `current` defaults to the process's os.tmpdir().
function safeTempRoot(opts = {}) {
  const env = opts.env || process.env;
  const current = opts.current || os.tmpdir();
  if (env.BELAY_TEST_TEMP_ALLOW_INDEXED === '1') return { dir: current, refused: false, reason: null };
  const reason = indexedReason(current, opts);
  if (!reason) return { dir: current, refused: false, reason: null };
  return { dir: fallbackTemp(opts), refused: true, reason, from: current };
}

// Applies safeTempRoot to the process: on a refusal TEMP/TMP/TMPDIR move to the fallback and stderr says so.
function enforceSafeTemp(env = process.env) {
  const r = safeTempRoot({ env });
  if (r.refused) {
    try { fs.mkdirSync(r.dir, { recursive: true }); } catch { /* the OS creates its own temp dir */ }
    env.TEMP = env.TMP = env.TMPDIR = r.dir;
    process.stderr.write(`belay tests: temp root ${r.from} is ${r.reason}; it would put test sandboxes into the Windows Search index. Using ${r.dir}. Set BELAY_TEST_TEMP_ALLOW_INDEXED=1 to keep it.\n`);
  }
  return r;
}

module.exports = { indexedReason, fallbackTemp, safeTempRoot, enforceSafeTemp };
