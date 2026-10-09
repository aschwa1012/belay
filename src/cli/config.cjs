'use strict';
// config.cjs — the one config file, discovered once and the same way for every command.
//
// command table §6 (P4): one file, found by walking up from cwd to the project root and stopping
// there, **never the home directory**. `config path` prints which file was actually
// read; `config get` prints the effective value and where it came from. No key is read from anywhere
// the CLI cannot name, which is why `effective()` always returns a `source` and never a bare value.
//
// This is shared rather than copied into each `cmd-*.cjs` because discovery that differs between
// `config`, `init`, `doctor` and `mcp status` is worse than no discovery at all: the operator would
// be told about a file that a different command did not read. The one-file-per-command ownership
// rule in CLAUDE.md is about concurrent writers, not about duplicating a lookup four ways.
//
// Nothing here imports src/core. A read path that reached the store would pull in the embedder,
// which is 13.5 s cold (command table §5), and every slice-3a command has a 300 ms budget.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG_NAME = 'belay.config.json';

const fwd = (p) => String(p).split('\\').join('/');

// Path equality: forward-slash normalised, and case-blind on Windows, where a cwd spelled c:/Home/me
// is the home directory C:/Home/me. Falls back to that comparison when a path cannot be resolved.
const samePath = (a, b) => {
  const x = fwd(a);
  const y = fwd(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

const realOf = (p) => { try { return fwd(fs.realpathSync.native(p)); } catch { return null; } };

// Is a level of the walk the home directory? A string match is the cheap answer. An 8.3 short name
// or a junction names home with other text, so each level is also resolved and compared with home
// resolved once per walk. A level that cannot be resolved falls back to the string comparison.
function homeWalk() {
  const home = fwd(os.homedir());
  const realHome = realOf(home);
  return {
    isHome(dir) {
      if (samePath(dir, home)) return true;
      if (realHome === null) return false;
      const real = realOf(dir);
      return real !== null && samePath(real, realHome);
    },
  };
}

// The keys the CLI will answer for, their defaults, and what each one is. An unknown key is a usage
// error rather than a silent null: a config surface that answers `undefined` for a typo teaches the
// operator that the key exists.
const KEYS = {
  data_dir: {
    default: '.belay',
    describe: 'store directory, relative to the config file (api.md §1 fixes what lives in it)',
    kind: 'path',
  },
  claude_exe: {
    default: null,
    describe: 'Claude Code binary; null means BELAY_CLAUDE_EXE, else claude on PATH',
    kind: 'path',
  },
  codex_exe: {
    default: null,
    describe: 'Codex CLI binary; null means BELAY_CODEX_EXE, else codex on PATH',
    kind: 'path',
  },
  // The panel's display settings (ADR 0036 amendment 1 §6). Stored nested in the file,
  // { "mod": { "pane": "docked" } }, and addressed by the dotted key. A stored value outside `allowed`
  // is reported as invalid and the default is used, never silently accepted.
  'mod.pane':    { default: 'docked',    allowed: ['docked', 'above-prompt'],          describe: 'where the panel sits', kind: 'enum' },
  'mod.marks':   { default: 'shapes',    allowed: ['shapes', 'words', 'colour'],        describe: 'how an agent\'s state is marked', kind: 'enum' },
  'mod.cache':   { default: 'both',      allowed: ['countdown', 'bar', 'both'],         describe: 'how the cache lifetime is drawn', kind: 'enum' },
  'mod.context': { default: 'both',      allowed: ['figure', 'bar', 'both'],            describe: 'how the context size is drawn', kind: 'enum' },
  'mod.band':    { default: 'two-lines', allowed: ['one-line', 'two-lines', 'minimal'], describe: 'how much the band above the panel shows', kind: 'enum' },
  'mod.task':    { default: 'kind',      allowed: ['kind', 'title', 'off'],               describe: 'what the task column shows: the kind, the id and title, or nothing', kind: 'enum' },
};

const KEY_NAMES = Object.keys(KEYS);

// A directory is a project root when it carries one of these. Discovery stops at the first one it
// reaches, having checked it, so a config at the project root is found and a config above it is not.
const ROOT_MARKERS = ['.git', 'package.json'];

function isProjectRoot(dir) {
  for (const m of ROOT_MARKERS) {
    try { if (fs.existsSync(`${dir}/${m}`)) return m; } catch { /* unreadable is not a root */ }
  }
  return null;
}

// Walk up from `cwd`. Returns what was found and, either way, every path that was looked at, so a
// "not found" answer can say where it looked rather than only that it failed.
function discover(cwd) {
  const searched = [];
  let dir = fwd(path.resolve(cwd));
  const atHome = homeWalk();
  let stopped = 'filesystem root';

  for (;;) {
    // The home directory is never searched and never returned. On Windows the system temp
    // directory sits underneath it, so this guard is load-bearing and not theoretical.
    if (atHome.isHome(dir)) { stopped = 'the home directory, which is never searched'; break; }

    const candidate = `${dir}/${CONFIG_NAME}`;
    searched.push(candidate);
    if (fs.existsSync(candidate)) return read(candidate, dir, searched);

    const marker = isProjectRoot(dir);
    if (marker) { stopped = `the project root, identified by ${marker}`; break; }

    const parent = fwd(path.dirname(dir));
    if (parent === dir) break;
    dir = parent;
  }

  return {
    found: false, path: null, dir: null, raw: null, config: {}, parse_error: null,
    searched, stopped_at: dir, stopped_because: stopped,
  };
}

function read(file, dir, searched) {
  const base = {
    found: true, path: file, dir, searched, stopped_at: dir,
    stopped_because: 'the config file was found here',
  };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ...base, raw: null, config: {}, parse_error: `could not read ${file}: ${e.message}` };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...base, raw, config: {}, parse_error: `${file} is valid JSON but not an object` };
    }
    return { ...base, raw, config: parsed, parse_error: null };
  } catch (e) {
    return { ...base, raw, config: {}, parse_error: `${file} is not valid JSON: ${e.message}` };
  }
}

// The effective value of one key and the exact place it came from. `source` is a file path when the
// file set it, the literal 'default' when it did not, and '--data' when the operator overrode it on
// the command line. There is no fourth possibility, which is the whole point of §6's last sentence.
function effective(found, key, { dataDirOverride = null } = {}) {
  if (!Object.prototype.hasOwnProperty.call(KEYS, key)) return null;

  if (key === 'data_dir' && dataDirOverride) {
    return { key, value: dataDirOverride, source: '--data', resolved: fwd(dataDirOverride), describe: KEYS[key].describe };
  }

  const spec = KEYS[key];
  const stored = found.found ? storedOf(found.config, key) : { present: false };
  let fromFile = stored.present;
  let invalid = null;
  if (fromFile && spec.allowed && !spec.allowed.includes(stored.value)) {
    invalid = {
      stored: stored.value,
      reason: `${JSON.stringify(stored.value)} is not one of ${spec.allowed.join(', ')}; the default ${JSON.stringify(spec.default)} is used`,
    };
    fromFile = false;
  }

  const value = fromFile ? stored.value : spec.default;
  const source = fromFile ? found.path : 'default';
  const out = {
    key, value, source, describe: spec.describe,
    resolved: spec.kind === 'path' ? resolve(value, found) : null,
  };
  if (spec.allowed) out.allowed = spec.allowed;
  if (invalid) out.invalid = invalid;
  return out;
}

// A dotted key reads one level into a nested object: 'mod.pane' is config.mod.pane.
function storedOf(config, key) {
  let cur = config;
  for (const p of key.split('.')) {
    if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, p)) return { present: false };
    cur = cur[p];
  }
  return cur === undefined ? { present: false } : { present: true, value: cur };
}

// A relative path in the config file is relative to the config file, not to the cwd. Otherwise the
// same config would name a different store depending on which subdirectory the operator ran from.
function resolve(value, found) {
  if (value === null || value === undefined) return null;
  const base = found.found ? found.dir : null;
  if (!base) return path.isAbsolute(String(value)) ? fwd(value) : null;
  return fwd(path.resolve(base, String(value)));
}

function all(found, opts) {
  return KEY_NAMES.map((k) => effective(found, k, opts));
}

// The dispatcher always fills `ctx.dataDir`, defaulting it to `<cwd>/.belay`, and records in
// `ctx.dataDirGiven` whether `--data` was on the command line. That flag decides, never a comparison
// of spellings: `--data` spelled exactly as the default must still win over a config's data_dir.
function overrideOf(ctx) {
  if (!ctx || !ctx.dataDir) return null;
  if (ctx.dataDirGiven !== undefined) return ctx.dataDirGiven ? fwd(ctx.dataDir) : null;
  // A caller that builds a ctx by hand (an in-process test) and does not say: anything but the default is a choice.
  const dflt = `${fwd(path.resolve(ctx.cwd || process.cwd()))}/${KEYS.data_dir.default}`;
  return fwd(ctx.dataDir) === dflt ? null : fwd(ctx.dataDir);
}

// Where the store is, for a command that needs to stat it. The override wins, then the config file,
// then `<project root or cwd>/.belay`. Always absolute, always forward slashes.
function dataDirOf(found, ctx) {
  const eff = effective(found, 'data_dir', { dataDirOverride: overrideOf(ctx) });
  if (eff.resolved) return eff.resolved;
  const base = found.found ? found.dir : fwd(path.resolve((ctx && ctx.cwd) || process.cwd()));
  return fwd(path.resolve(base, String(eff.value || KEYS.data_dir.default)));
}

// Where `init` writes: the project root if there is one, otherwise the cwd. Never above either.
function writeDirOf(cwd) {
  let dir = fwd(path.resolve(cwd));
  const start = dir;
  const atHome = homeWalk();
  for (;;) {
    if (atHome.isHome(dir)) return start;
    if (isProjectRoot(dir)) return dir;
    const parent = fwd(path.dirname(dir));
    if (parent === dir) return start;
    dir = parent;
  }
}

module.exports = {
  CONFIG_NAME, KEYS, KEY_NAMES, ROOT_MARKERS,
  fwd, samePath, isProjectRoot, discover, effective, all, dataDirOf, writeDirOf, overrideOf,
};
