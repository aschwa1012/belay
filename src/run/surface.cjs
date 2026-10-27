'use strict';
// surface.cjs — build step S2, ADR 0024: a worker sees
// only the tools, instructions and settings belay gives it, on every launch including a resume.
// Everything ADR 0024 adds lives here: the positive tool list, the settings-source restriction, the
// ancestor instruction-file excludes, the hygiene settings block, and the gate that reads a
// system/init and refuses one whose surface differs. Pure: no process, no fs, no network. Invariant 9
// (CLAUDE.md): no read path may import anything beyond node:path, node:os (the home directory, for checkNativeMemory), node:crypto
// and tool-policy.cjs (which requires nothing).

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const TP = require('./tool-policy.cjs'); // pure, requires nothing: the tools a list may name (ADR 0054)

// ADR 0024 decisions 1 and 2: one positive list, every role, every launch (fresh or resume).
const CLAUDE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'];
// ADR 0054 decision 1 (amends ADR 0024 decision 2; the operator, 2026-10-24): the orchestrator may edit and write files
// (records, notes, small fixes) but runs no shell: no Bash, so git reads go through belay's git_read and real code work is a
// worker's. Headless launches are held to the list by checkSurface; interactive ones pass it and record it as requested
// (ADR 0037 decision 5: the built-in list cannot be read there).
const ORCHESTRATOR_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write'];
// ADR 0024 decision 3 as replaced by amendment 1: no settings file is read except belay's own
// `--settings`. ONE argv token, exactly the form the settings-sources probe measured; the two-token form
// with an empty value was never measured. The worktree's CLAUDE.md arrives by instructions.cjs instead.
const SETTING_SOURCES_ARG = '--setting-sources=';

const fwd = (p) => String(p).replace(/\\/g, '/');

// Strict ancestors of an absolute, forward-slashed path, root-inclusive, nearest first. Works on a
// drive-rooted path ('C:/a/b') and a posix one ('/a/b') alike, without relying on path.dirname's own
// platform behaviour (which would treat a posix-shaped string as win32 on this host). The root keeps
// exactly one trailing slash internally so a caller can strip it once, uniformly (ancestorExcludes).
function ancestorsOf(resolved) {
  const isDrive = /^[A-Za-z]:\//.test(resolved);
  const rootLen = isDrive ? 3 : 1; // 'C:/'.length === 3, '/'.length === 1
  const root = resolved.slice(0, rootLen);
  const out = [];
  let cur = resolved;
  for (;;) {
    const trimmed = cur.length > rootLen && cur.endsWith('/') ? cur.slice(0, -1) : cur;
    const idx = trimmed.lastIndexOf('/');
    if (idx < rootLen - 1) break; // nothing left above the root
    const parent = idx === rootLen - 1 ? root : trimmed.slice(0, idx);
    out.push(parent);
    if (parent === root) break;
    cur = parent;
  }
  return out;
}

// ADR 0024 decision 4: every ancestor of the worktree, root-inclusive, cwd-exclusive, gets its own
// instruction files excluded — never the cwd's own copy, which the worker is meant to keep reading.
function ancestorExcludes(cwd) {
  const resolved = fwd(path.resolve(cwd));
  const out = [];
  for (const a of ancestorsOf(resolved)) {
    // The root already carries exactly one trailing slash ('C:/', '/'); every other ancestor has
    // none. Stripping it uniformly before appending is what keeps 'C:/CLAUDE.md' from becoming
    // 'C://CLAUDE.md'.
    const base = a.endsWith('/') ? a.slice(0, -1) : a;
    out.push(`${base}/CLAUDE.md`, `${base}/CLAUDE.local.md`, `${base}/.claude/CLAUDE.md`, `${base}/.claude/rules/**`);
  }
  return out;
}

// ADR 0024 decisions 4 and 5, one settings-file block.
// ADR 0024 amendment 3 (proposed): an eval-only `nativeMemory` directory turns Claude Code's own auto-memory on,
// pointed at that folder. Off (null) is exactly what it was.
function hygieneSettings(cwd, { nativeMemory = null } = {}) {
  const off = { claudeMdExcludes: ancestorExcludes(cwd), autoMemoryEnabled: false, autoDreamEnabled: false }; // key order is part of the file: off is byte-identical to before the lever
  if (nativeMemory == null) return off;
  return { ...off, autoMemoryEnabled: true, autoMemoryDirectory: checkNativeMemory(nativeMemory) };
}

// The requested folder must be absolute and outside Claude Code's config directory (<home>/.claude and CLAUDE_CONFIG_DIR);
// the RESOLVED form, forward-slashed, is what is stored, written to settings and compared at the ready gate. Refused as E_ARGS
// otherwise. Inside that directory is where Claude Code's default memory folder lives (<config>/projects/<git root>/memory), so
// the gate's equality check could not tell a folder it honoured from the fallback it takes on a malformed value (ADR 0024
// amendment 3): the operator's real memory is never a valid ask. On Windows the path must be drive-rooted (a posix-rooted, UNC,
// \\?\ or \\.\ path is refused), each segment loses its trailing dots and spaces the way Win32 does, then it is resolved and
// compared case-insensitively. Junctions and 8.3 names are the file-system half of this guarantee (native-memory.cjs).
const ABSRE = /^([A-Za-z]:[\\/]|\/)/;
const WINABS = /^[A-Za-z]:[\\/]/;
const CTLRE = /[\x00-\x1f]/;
const WINBAD = /[<>"|?*]/;
function win32Segments(p) { // trailing dots and spaces are stripped per segment by Win32; '.' and '..' stay navigation
  return fwd(p).split('/').map((seg) => (seg === '.' || seg === '..' ? seg : seg.replace(/[. ]+$/, ''))).filter((seg) => seg !== '');
}
function resolveFolder(dir) {
  const win = process.platform === 'win32';
  const ok = typeof dir === 'string' && (win ? WINABS : ABSRE).test(dir) && CTLRE.test(dir) === false && !(win && (WINBAD.test(dir) || dir.indexOf(':', 2) >= 0 || fwd(dir).split('/').some((sg) => sg !== '.' && sg !== '..' && /^[. ]+$/.test(sg))));
  if (!ok) throw Object.assign(new Error('native_memory must be an absolute directory path'), { code: 'E_ARGS', detail: { native_memory: dir } });
  if (!win) return path.posix.resolve(fwd(dir));
  const parts = win32Segments(dir);
  return fwd(path.win32.resolve(parts[0] + '/', ...parts.slice(1)));
}
const lc = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const under = (n, c) => n === c || n.startsWith(c.replace(/\/+$/, '') + '/');
function claudeConfigDirs() {
  const dirs = [path.join(os.homedir(), '.claude')];
  if (process.env.CLAUDE_CONFIG_DIR) dirs.push(process.env.CLAUDE_CONFIG_DIR);
  return dirs.map((d) => fwd(path.resolve(d)));
}
function checkNativeMemory(dir) {
  const folder = resolveFolder(dir);
  if (claudeConfigDirs().some((c) => under(lc(folder), lc(c)))) {
    throw Object.assign(new Error("native_memory must be outside Claude Code's config directory, where its default memory folder lives"), { code: 'E_ARGS', detail: { native_memory: dir, reason: 'claude_config_dir' } });
  }
  return folder;
}

// Two paths name the same folder: separators, case and a trailing slash do not matter (Windows).
const sameDir = (a, b) => {
  const n = (p) => fwd(p).replace(/\/+$/, '').toLowerCase();
  return typeof a === 'string' && typeof b === 'string' && a !== '' && n(a) === n(b);
};

// ADR 0024 decisions 1 and 3: a launch may narrow the built-in list (the knowledge agent reads only), never widen it past
// the six; ADR 0054 decision 4 admits WebFetch and WebSearch beside them, for an agent type whose list names them.
// Returns null for exactly the six, or the list; anything else is refused before any file or row exists.
function narrowTools(tools) {
  if (tools == null) return null;
  const ok = Array.isArray(tools) && tools.length > 0 && new Set(tools).size === tools.length && tools.every((t) => TP.POLICY_TOOLS.includes(t));
  if (!ok) throw Object.assign(new Error(`tools must be a non-empty subset of ${TP.POLICY_TOOLS.join(', ')} with no repeats`), { code: 'E_ARGS', detail: { tools } });
  return tools.length === CLAUDE_TOOLS.length && CLAUDE_TOOLS.every((t) => tools.includes(t)) ? null : [...tools];
}

// ADR 0024 decision 6: the ready event reports the surface the worker actually got; a wrong surface
// is a failed launch. Reads only `tools`, `plugins` and `memory_paths` off the ready event the parser
// already built (parsers.cjs), never the raw system/init line.
// `tools`: the narrowed built-in list this launch was given (launch.cjs narrowTools), checked exactly as the full
// list is; null for the full list.
// `job`: the worker carries a reserved job id prefix (src/core/job-ids.cjs). Its adapter lists no belay tool by design, so the gate
// expects none (ADR 0024 decision 6, amendment 2); the built-in check is unchanged and exact.
// `nativeMemory`: the folder this launch asked Claude Code to use for its auto-memory (ADR 0024 amendment 3), or null.
function checkSurface(ready, { permissionPrompt = false, tools: wanted = null, job = false, nativeMemory = null } = {}) {
  const tools = ready && ready.tools;
  if (!Array.isArray(tools)) {
    return {
      ok: false,
      reason: `the system/init surface is not the one ADR 0024 allows: tools is not an array (system/init carried ${JSON.stringify(tools)})`,
    };
  }

  const reasons = [];
  const builtins = tools.filter((t) => !String(t).startsWith('mcp__'));
  const mcpTools = tools.filter((t) => String(t).startsWith('mcp__'));

  const want = wanted || CLAUDE_TOOLS;
  const wantSet = new Set(want);
  const gotSet = new Set(builtins);
  const extra = builtins.filter((t) => !wantSet.has(t));
  const missing = want.filter((t) => !gotSet.has(t));
  if (extra.length) reasons.push(`extra built-in tool(s) beyond ADR 0024's list: ${extra.join(', ')}`);
  if (missing.length) reasons.push(`missing built-in tool(s) from ADR 0024's list: ${missing.join(', ')}`);

  const foreign = mcpTools.filter((t) => !t.startsWith('mcp__belay__'));
  if (foreign.length) reasons.push(`mcp tool(s) not under mcp__belay__: ${foreign.join(', ')}`);

  // F2 (S2 review 1, should-fix 2, to ADR 0024 decision 6's letter): the belay tool set is "any
  // mcp__belay__*, and at least one" — the adapter's own tool list is its business, and mcp_servers
  // (ready.cjs) already proves the connection, but an init naming none at all names no adapter.
  const belayTools = mcpTools.filter((t) => t.startsWith('mcp__belay__'));
  if (job) {
    if (belayTools.length) reasons.push(`a job worker lists no belay tool, and this one lists: ${belayTools.join(', ')} (ADR 0024 decision 6, amendment 2)`);
  } else if (belayTools.length === 0) reasons.push('no mcp__belay__* tool is listed (ADR 0024 decision 6 expects at least one)');

  if (permissionPrompt && mcpTools.includes('mcp__belay__permit')) {
    reasons.push('mcp__belay__permit is listed even though a permission-prompt tool was configured for this launch (ADR 0024 decision 7)');
  }

  // F1/F2 (should-fix 1 and 2): plugins must be an array, and only ever refused, never thrown on — a
  // blind .filter over an object or a string (review 1 finding 1) left verifyReady rejecting instead
  // of refusing, and the orchestrator's un-caught .then an unhandled rejection. Absent, null or any
  // other non-array shape is refused by naming its own shape.
  const pluginsField = ready && ready.plugins;
  let plugins = [];
  if (!Array.isArray(pluginsField)) {
    reasons.push(`plugins is not an array (system/init carried ${JSON.stringify(pluginsField)})`);
  } else {
    plugins = pluginsField;
    const badPlugins = plugins.filter((p) => !(p && String(p.source).endsWith('@builtin')));
    if (badPlugins.length) {
      reasons.push(`non-builtin plugin(s): ${badPlugins.map((p) => (p && p.source) || JSON.stringify(p)).join(', ')}`);
    }
  }

  // F2: decision 6 expects no memory_paths at all — any value that is not null or undefined is
  // refused, not only a truthy `.auto` (review 1 finding 2: {project:...}, a string, an array and
  // {auto:''} all passed the looser check).
  const memoryPaths = ready && ready.memory_paths;
  if (nativeMemory != null) {
    // Exact equality, nothing else: a malformed directory is ignored by Claude Code, which then falls back to the default
    // projects/<git root>/memory folder, possibly the operator's real memory.
    const keys = memoryPaths && typeof memoryPaths === 'object' && !Array.isArray(memoryPaths) ? Object.keys(memoryPaths) : null;
    if (!keys) reasons.push(`memory_paths is absent, and this launch asked for native memory in ${nativeMemory}: ${JSON.stringify(memoryPaths === undefined ? null : memoryPaths)}`);
    else if (keys.length !== 1 || keys[0] !== 'auto') reasons.push(`memory_paths must carry exactly {auto} for native memory, and carries ${JSON.stringify(memoryPaths)}`);
    else if (!sameDir(memoryPaths.auto, nativeMemory)) reasons.push(`memory_paths.auto is ${JSON.stringify(memoryPaths.auto)}, and this launch asked for ${nativeMemory}`);
  } else if (memoryPaths !== null && memoryPaths !== undefined) {
    if (memoryPaths && typeof memoryPaths === 'object' && 'auto' in memoryPaths) {
      reasons.push(`memory_paths.auto is set: ${memoryPaths.auto}`);
    } else {
      reasons.push(`memory_paths is present, and ADR 0024 decision 6 expects none: ${JSON.stringify(memoryPaths)}`);
    }
  }

  if (reasons.length) {
    return { ok: false, reason: `the system/init surface is not the one ADR 0024 allows: ${reasons.join('; ')}` };
  }

  const toolsHash = crypto.createHash('sha256').update([...tools].sort().join('\n')).digest('hex');
  return {
    ok: true,
    evidence: {
      tools_hash: toolsHash,
      builtins: [...builtins].sort(),
      belay_tools: belayTools.sort(),
      plugins,
    },
  };
}

// F4 (S2 review 1, should-fix 4): the fields spawn, restart, resume and the orchestrator report as
// `surface`, picked from checkSurface's own evidence — never `mcp_servers`, which is ready.cjs's own
// concern, never stored alongside it. `null` when there is no evidence yet (a launch that never
// reached this gate, or a Codex worker, whose verifyReady branch returns none of these fields).
function surfaceFields(evidence) {
  if (!evidence) return null;
  const { tools_hash, builtins, belay_tools, plugins } = evidence;
  if (tools_hash === undefined && builtins === undefined && belay_tools === undefined && plugins === undefined) return null;
  return { tools_hash: tools_hash ?? null, builtins: builtins ?? null, belay_tools: belay_tools ?? null, plugins: plugins ?? null };
}

module.exports = { checkNativeMemory, claudeConfigDirs, under, sameDir, CLAUDE_TOOLS, ORCHESTRATOR_TOOLS, narrowTools, SETTING_SOURCES_ARG, ancestorExcludes, hygieneSettings, checkSurface, surfaceFields };
