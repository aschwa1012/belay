'use strict';
// The interactive orchestrator's surface gate (ADR 0037 decision 5). Without `-p` there is no
// `system/init`, so the gate reads two files Claude Code writes: its debug log (--debug-file) and the
// session file (~/.claude/projects/<encoded cwd>/<session-id>.jsonl). Both formats are undocumented.
// Every check therefore keys on an exact string measured in the probe receipts
// and FAILS when its line is
// absent or its format is not recognised: it never passes by default. Reading only, no writes
// (invariant 6). The pure checks take text; createInteractiveGate does the polling.

const os = require('node:os');
const { compareVersions, MIN_CLAUDE_CODE_VERSION } = require('./ready.cjs');

// Claude Code names a project directory by its cwd with every character outside [A-Za-z0-9] replaced
// by '-': `C:\Home\me\proj\wt` is `C--Home-me-proj-wt`, and `\.claude\` is
// `--claude-` (receipts C0 session path; ~/.claude/projects listing). A path over 200 characters is
// shortened with a hash by Claude Code; that form is not reproduced, so findSessionFile searches every
// project directory for the session id instead.
function encodeCwd(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

function sessionFilePath({ cwd, sessionId, env = process.env, home = os.homedir() }) {
  const root = (env && env.CLAUDE_CONFIG_DIR) || `${String(home).replace(/\\/g, '/')}/.claude`;
  return `${String(root).replace(/\\/g, '/')}/projects/${encodeCwd(cwd)}/${sessionId}.jsonl`;
}

// A check that could not run because its line (or entry) is not there yet. `missing` lets the gate
// tell "still waiting" from "decisively wrong"; both have ok false in a debug result.
const pass = (name, detail) => ({ name, ok: true, detail });
const fail = (name, detail) => ({ name, ok: false, detail });
const absent = (name, expected) => ({ name, ok: false, missing: true, detail: `no line matching ${expected}` });

function summarise(checks, facts) {
  const failedNow = checks.find((c) => c.ok === false && !c.missing);
  const pending = checks.filter((c) => c.missing).map((c) => c.name);
  const ok = checks.every((c) => c.ok === true);
  const failed = (failedNow || checks.find((c) => c.ok === false) || {}).name;
  return { ok, checks, facts, ...(ok ? {} : { failed }), ...(pending.length ? { pending } : {}) };
}

// ------------------------------------------------------------------ debug log

const RE_VERSION = /cc_version=(\d+\.\d+\.\d+)/; // C1 line 120: `attribution header ... cc_version=2.1.293.d9e;`
const RE_NO_INSTR = /No CLAUDE\.md\/rules files found/; // C1 line 95
const RE_LOADED_INSTR = /Loaded (\d+) CLAUDE\.md\/rules files/; // C0 line 160 (the leak)
const RE_SKILLS = /Loaded (\d+) unique skills/g; // C1 line 8: `Loaded 0 unique skills (...)`; C0: 17
const RE_PLUGINS = /Loaded plugins - Enabled: (\d+), Disabled: (\d+), Commands: (\d+), Agents: (\d+)/g; // C1 line 138
const RE_FOUND_PLUGINS = /Found (\d+) plugins \((\d+) enabled, (\d+) disabled\)/; // C1 line 11
const RE_HOOKS_ENABLED = /Read hooks\.json for plugin (\S+) \(enabled=true\)(?:: ([^\r\n]+))?/g; // C0 lines 11-12 (the leak); the path after the colon is wake2 receipts/M debug-excerpt.log line 10
// ADR 0037 amendment 5: belay's own mod is the one admitted plugin. wake2 receipts/M debug-excerpt.log lines 7 and 12:
// `--plugin-dir <dir> is one plugin: ...` and `Loaded 1 directory-loaded plugins`.
const RE_PLUGIN_DIR = /\[DEBUG\] --plugin-dir ([^\r\n]+)/g; // D6: only the load line `[DEBUG] --plugin-dir <dir> is one plugin: ...` (W1/H5 debug logs line 29/37); never the free text of `clearPluginCache: ... (preAction: --plugin-dir inline plugins)`, written at every start
const RE_DIR_LOADED = /Loaded (\d+) directory-loaded plugins/g;
const normPath = (p) => String(p).split('\\').join('/').replace(/\/+$/, '').toLowerCase();
const RE_CHECKING_PLUGIN = /Checking plugin ([^\s:]+):/g; // C0 lines 15-24 list every enabled plugin; C1 lists only cc-plugin-*
const RE_MCP_OK = /MCP server "([^"]+)": Successfully connected/g; // C1 line 140
// The failure line is NOT in any receipt (no configured server failed in the probes). Claude Code's
// wording for it is matched loosely, and a pass still requires belay's own "Successfully connected".
const RE_MCP_FAILED = /MCP server "([^"]+)":? (?:Connection failed|Failed to connect|Connection error|Connection timed out|Connection timeout)/gi;
// The first submitted message: C1 line 127, `attribution header ... cc_turn_origin=human; cc_prompt_index=1;`,
// the header of the first request that carries the prompt. The E1/I1/I2 debug logs were not kept, so the
// session file's first typed user entry (firstUserEntry, keyed on E1/I1/I2) is the second source.
const RE_FIRST_PROMPT = /cc_prompt_index=1\b/;
const RE_TS = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/;

function checkDebugLog(text, requested = {}) {
  const t = String(text || '');
  const floor = requested.versionFloor || MIN_CLAUDE_CODE_VERSION;
  const checks = [];
  const facts = {};

  const v = t.match(RE_VERSION);
  if (!v) checks.push(absent('version', 'cc_version=<x.y.z>'));
  else {
    facts.version = v[1];
    checks.push(compareVersions(v[1], floor) < 0
      ? fail('version', `Claude Code ${v[1]} is below the floor ${floor} (ADR 0021 amendment 3)`)
      : pass('version', v[1]));
  }

  const loaded = t.match(RE_LOADED_INSTR);
  if (loaded) {
    facts.instruction_files = Number(loaded[1]);
    checks.push(fail('instructions', `${loaded[0]}`));
  } else if (RE_NO_INSTR.test(t)) checks.push(pass('instructions', 'No CLAUDE.md/rules files found'));
  else checks.push(absent('instructions', '"No CLAUDE.md/rules files found"'));

  const skills = [...t.matchAll(RE_SKILLS)].map((m) => Number(m[1]));
  if (!skills.length) checks.push(absent('skills', '"Loaded <n> unique skills"'));
  else {
    facts.skills = Math.max(...skills);
    checks.push(facts.skills === 0 ? pass('skills', 'Loaded 0 unique skills') : fail('skills', `Loaded ${facts.skills} unique skills`));
  }

  // The whole text is read: a later line (a second plugins summary, a second server) counts too.
  const pls = [...t.matchAll(RE_PLUGINS)];
  if (!pls.length) checks.push(absent('plugin_agents', '"Loaded plugins - Enabled: n, Disabled: n, Commands: n, Agents: n"'));
  else {
    facts.plugin_agents = Math.max(...pls.map((m) => Number(m[4])));
    facts.plugin_commands = Math.max(...pls.map((m) => Number(m[3])));
    checks.push(facts.plugin_agents === 0 ? pass('plugin_agents', 'Agents: 0') : fail('plugin_agents', `Agents: ${facts.plugin_agents}`));
  }

  // user_plugins_disabled: no user plugin enabled (a name not cc-plugin-*, the builtin ones C1 shows
  // enabled), no hooks.json read as enabled=true, and Commands: 0.
  const found = t.match(RE_FOUND_PLUGINS);
  // The admitted plugin (requested.plugin = { name, dir }): admitted by name AND path. A hooks.json read for that
  // name from anywhere but under its directory, or any --plugin-dir other than its directory, is not admitted.
  const want = requested.plugin && requested.plugin.name && requested.plugin.dir ? { name: requested.plugin.name, dir: normPath(requested.plugin.dir) } : null;
  // A line naming the known directory is anchored on it (so a path containing " is " parses); any other is cut at its first " is ".
  const dirLines = [...t.matchAll(RE_PLUGIN_DIR)].map((m) => {
    const rest = normPath(m[1]);
    if (want && rest.startsWith(`${want.dir} is `)) return want.dir;
    const cut = rest.indexOf(' is ');
    return cut >= 0 ? rest.slice(0, cut) : rest;
  });
  const hooksRead = [...t.matchAll(RE_HOOKS_ENABLED)].map((m) => ({ name: m[1], path: m[2] ? normPath(m[2]) : null }));
  const hookAdmitted = (h) => !!want && h.name === want.name && h.path !== null && h.path.startsWith(`${want.dir}/`);
  const dirsOk = !!want && dirLines.length > 0 && dirLines.every((d) => d === want.dir);
  const otherDirs = [...new Set(dirLines.filter((d) => !want || d !== want.dir))];
  const unadmittedHooks = hooksRead.filter((h) => !hookAdmitted(h)).map((h) => h.name);
  const admitted = dirsOk && hooksRead.some(hookAdmitted) && !unadmittedHooks.includes(want.name);
  const userEnabled = [...t.matchAll(RE_CHECKING_PLUGIN)].map((m) => m[1]).filter((n) => !n.startsWith('cc-plugin-') && !(admitted && n === want.name));
  const enabledHooks = unadmittedHooks;
  const badPlugins = [...new Set([...userEnabled, ...enabledHooks, ...otherDirs.map((d) => `--plugin-dir ${d}`)])];
  if (want) {
    facts.plugin = { name: want.name, dir: requested.plugin.dir };
    const loaded = [...t.matchAll(RE_DIR_LOADED)].map((m) => Number(m[1]));
    if (otherDirs.length) checks.push(fail('belay_plugin', `--plugin-dir other than belay's: ${otherDirs.join(', ')}`));
    else if (Math.max(0, ...loaded) > 1) checks.push(fail('belay_plugin', `Loaded ${Math.max(...loaded)} directory-loaded plugins; expected 1`));
    else if (admitted) checks.push(pass('belay_plugin', `${want.name} at ${requested.plugin.dir}`));
    else if (unadmittedHooks.includes(want.name)) checks.push(fail('belay_plugin', `hooks.json read for ${want.name} from outside ${requested.plugin.dir}`));
    else checks.push(absent('belay_plugin', `--plugin-dir ${requested.plugin.dir} and hooks.json read for plugin ${want.name} (enabled=true)`));
  }
  if (badPlugins.length) {
    facts.enabled_plugins = badPlugins;
    checks.push(fail('user_plugins_disabled', `enabled user plugins: ${badPlugins.join(', ')}`));
  } else if (facts.plugin_commands > 0) {
    checks.push(fail('user_plugins_disabled', `plugin Commands: ${facts.plugin_commands}`));
  } else if (!found || facts.plugin_commands === undefined) {
    checks.push(absent('user_plugins_disabled', '"Found <n> plugins (<e> enabled, <d> disabled)" and "Commands: 0"'));
  } else checks.push(pass('user_plugins_disabled', '0 enabled user plugins, Commands: 0'));

  const servers = [...new Set([...t.matchAll(RE_MCP_OK)].map((m) => m[1]))];
  const failedServers = [...new Set([...t.matchAll(RE_MCP_FAILED)].map((m) => m[1]))];
  facts.mcp_servers = servers;
  if (failedServers.length) {
    facts.mcp_failed = failedServers;
    checks.push(fail('mcp_servers', `failed to connect: ${failedServers.join(', ')} (pattern unverified)`));
  } else if (servers.some((s) => s !== 'belay')) checks.push(fail('mcp_servers', `connected: ${servers.join(', ')}; expected exactly belay`));
  else if (!servers.length) checks.push(absent('mcp_servers', 'MCP server "belay": Successfully connected'));
  else checks.push(pass('mcp_servers', 'belay'));

  return summarise(checks, facts);
}

// The debug log's first timestamp in ms, or null.
function firstTimestamp(text) {
  const m = String(text || '').match(RE_TS);
  return m ? Date.parse(m[1]) : null;
}

// ------------------------------------------------------------------ session file

function parseLines(text) {
  const t = String(text || '');
  const lines = t.split('\n');
  const tailOpen = !t.endsWith('\n'); // the last line may be half written; it is not a parse failure yet
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let v;
    try { v = JSON.parse(lines[i]); } catch (e) {
      if (i === lines.length - 1 && tailOpen) continue;
      return { entries, error: `line ${i + 1} is not JSON (${e.message.slice(0, 60)})` };
    }
    // `null`, a number or an array parses but is no session entry: unrecognised, so the parse check fails.
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return { entries, error: `line ${i + 1} is not a JSON object (unrecognised entry)` };
    entries.push(v);
  }
  return { entries, error: null };
}

function checkSessionFile(text, requested = {}) {
  const floor = requested.versionFloor || MIN_CLAUDE_CODE_VERSION;
  const { entries, error } = parseLines(text);
  const checks = [];
  const facts = { permission_mode: null, model: null, version: null, effort: null };
  if (error) checks.push(fail('parse', error));

  const modes = entries.filter((e) => e.type === 'permission-mode');
  if (!modes.length) checks.push(absent('permission_mode', '{"type":"permission-mode","permissionMode":...}'));
  else {
    facts.permission_mode = modes[0].permissionMode;
    checks.push(facts.permission_mode === requested.permissionMode
      ? pass('permission_mode', facts.permission_mode)
      : fail('permission_mode', `got ${facts.permission_mode}, requested ${requested.permissionMode}`));
  }

  const att = entries.filter((e) => e.attachment).map((e) => e.attachment);
  // The model is the assistant entries' `message.model` (E1, I1: claude-sonnet-5-5). A typed-first-message
  // session carries no `model` or `environment` attachment (E1, I1, I2), so none is required.
  const assistantModels = [...new Set(entries.filter((e) => e.type === 'assistant' && e.message && e.message.model)
    .map((e) => e.message.model).filter((m) => !m.startsWith('<')))];
  if (!assistantModels.length) checks.push(absent('model', '{"type":"assistant","message":{"model":...}}'));
  else {
    facts.model = assistantModels[0];
    const wrong = assistantModels.filter((m) => m !== requested.model);
    checks.push(wrong.length ? fail('model', `got ${wrong.join(', ')}, requested ${requested.model}`) : pass('model', facts.model));
  }

  const versioned = entries.find((e) => typeof e.version === 'string');
  if (!versioned) checks.push(absent('version', '"version":"<x.y.z>" on an entry'));
  else {
    facts.version = versioned.version;
    checks.push(compareVersions(facts.version, floor) < 0
      ? fail('version', `Claude Code ${facts.version} is below the floor ${floor}`)
      : pass('version', facts.version));
  }

  const efforts = [...new Set(entries.filter((e) => e.type === 'assistant' && e.effort).map((e) => e.effort))];
  if (efforts.length) facts.effort = efforts[0];
  if (!requested.effort) checks.push(pass('effort', 'none requested'));
  else if (!efforts.length) checks.push(absent('effort', '"effort":"<level>" on an assistant entry'));
  else checks.push(efforts.length === 1 && efforts[0] === requested.effort
    ? pass('effort', efforts[0])
    : fail('effort', `got ${efforts.join(', ')}, requested ${requested.effort}`));

  const leaks = att.filter((a) => (a.type === 'instructions' && (!a.files || a.files.length)) || /memor|claude_?md/i.test(a.type || ''));
  if (leaks.length) {
    const paths = leaks.flatMap((a) => (a.files || []).map((f) => `${f.type}:${f.path}`));
    checks.push(fail('no_instructions', `attachment ${leaks.map((a) => a.type).join(', ')}${paths.length ? ` (${paths.join(', ')})` : ''}`));
  } else checks.push(pass('no_instructions', 'no instructions or memory attachment'));

  const r = summarise(checks, facts);
  // A session file with nothing wrong yet but entries still to come is pending, not failed.
  const decisivelyBad = checks.some((c) => c.ok === false && !c.missing);
  if (decisivelyBad) return { ok: false, checks, facts, failed: r.failed };
  if (r.ok) return { ok: true, checks, facts };
  return { ok: null, pending: r.pending, checks, facts };
}

// ------------------------------------------------------------------ the gate

// The session file of a session id: sessionFilePath()'s own form first, then every directory under
// projectsDir (a hashed long path, an odd cwd form). Reads only; null when there is none.
function findSessionFile({ projectsDir, cwd, sessionId, exists, readdir, search = true }) {
  const ex = exists || ((p) => require('node:fs').existsSync(p));
  const rd = readdir || ((p) => require('node:fs').readdirSync(p));
  const root = projectsDir ? String(projectsDir).replace(/\\/g, '/') : null;
  const direct = root ? `${root}/${encodeCwd(cwd)}/${sessionId}.jsonl` : sessionFilePath({ cwd, sessionId });
  try { if (ex(direct)) return direct; } catch (e) { /* fall through to the search */ }
  if (!search) return null;
  const base = root || direct.slice(0, direct.indexOf('/projects/') + '/projects'.length);
  let dirs = [];
  try { dirs = rd(base); } catch (e) { return null; }
  for (const d of dirs) {
    const p = `${base}/${d}/${sessionId}.jsonl`;
    try { if (ex(p)) return p; } catch (e) { /* next */ }
  }
  return null;
}

// Two halves and one fact: whether the session was REACHED (ADR 0037 amendment 4).
//  - reached: the session file exists for the session id (any content, even mode entries only), or the
//    debug log shows cc_prompt_index=1. The file is looked for on its own 2 s throttle from the spawn, the
//    direct path on every poll, so no cue is needed to find it.
//  - before it is reached only a decisive leak line, or a stale debug log (first timestamp before
//    spawnedAt), fails, and at once. Nothing else can: not a missing version line, not a missing file.
//  - once reached, the debug half is decided over the WHOLE file at reach + surfaceMs, and the session
//    file's metadata (permission mode, version, file found) at reach + settleMs; a missing one fails.
//  - the model and effort checks never kill a live session: they are decided at finalize only.
// Reads only (invariant 6). stop() resolves what is pending with { ok: null, reason: 'stopped', ...known }.
// finalize() is for a claude that has exited: not reached, both halves are { ok: null, reason: 'not reached' }
// (only a leak or a stale log can still fail them); reached, every check is decided over the final files
// (an absent line fails; an absent assistant entry fails 'no_assistant_reply_before_exit').
// It returns { debug, session }.
const ASSISTANT_CHECKS = ['model', 'effort'];
const SEARCH_EVERY_MS = 2000;

function createInteractiveGate({
  debugFile, projectsDir, cwd, sessionId, requested, spawnedAt,
  surfaceMs = 15000, settleMs = 15000, pollMs = 250, deps = {},
}) {
  const readFile = deps.readFile || ((p) => require('node:fs').readFileSync(p, 'utf8'));
  const now = deps.now || Date.now;
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const read = (p) => { try { return readFile(p); } catch (e) { return null; } };

  let stopped = false;
  let timer = null;
  let firstAt = null; // when the session was reached
  let resolveFirst;
  const firstMessage = new Promise((r) => { resolveFirst = r; });
  const half = () => {
    const h = { done: false, last: { ok: null, checks: [], facts: {} } };
    h.promise = new Promise((r) => { h.resolve = r; });
    return h;
  };
  const dbg = half();
  const ses = half();
  let sessionPath = null;
  const noteReached = () => { if (firstAt === null) { firstAt = now(); resolveFirst(firstAt); } };
  let finalizing = false; // set by finalize(): every result it decides is marked 'finalized'
  let final = false; // reached, and the files are final: every deadline counts as passed
  let finalP = null;
  // A half that was not decided (not reached, stopped) did not fail a check: drop `failed` and `detail`, keep `pending` and `reason`.
  const undecided = (h, reason) => { const { failed, detail, ...rest } = h.last; return { ...rest, ok: null, reason }; };
  const finish = (h, result) => { if (!h.done) { h.done = true; h.last = result; h.resolve(finalizing ? { ...result, finalized: true } : result); } };
  const pendingResult = (r) => ({ ...r, ok: null });
  const pastDeadline = (ms) => firstAt !== null && (final || now() >= firstAt + ms);
  let searchedAt = null; // the last directory search for the session file

  function tickDebug() {
    const text = read(debugFile);
    if (text === null || !text.trim()) { // a missing and an empty log are the same: nothing was written
      if (pastDeadline(surfaceMs)) finish(dbg, { ok: false, failed: 'debug_file_missing', detail: `no debug file at ${debugFile}`, checks: [], facts: dbg.last.facts });
      return;
    }
    const r = checkDebugLog(text, requested);
    const ts = firstTimestamp(text);
    if (typeof spawnedAt === 'number' && ts !== null && ts < spawnedAt) {
      finish(dbg, { ok: false, failed: 'stale_debug_log', detail: `first timestamp ${new Date(ts).toISOString()} is before the spawn at ${new Date(spawnedAt).toISOString()}`, checks: r.checks, facts: r.facts });
      return;
    }
    if (RE_FIRST_PROMPT.test(text)) noteReached();
    dbg.last = pendingResult(r);
    // Decisive leak lines fail at any time. A version below the floor is decided once reached.
    const leak = r.checks.find((c) => c.ok === false && !c.missing && c.name !== 'version');
    if (leak) { finish(dbg, { ...r, ok: false, failed: leak.name, detail: leak.detail }); return; }
    if (pastDeadline(surfaceMs)) {
      const bad = r.checks.find((c) => c.ok === false && !c.missing) || r.checks.find((c) => c.ok === false);
      finish(dbg, r.ok ? r : { ...r, ok: false, failed: (bad || {}).name, detail: (bad || {}).detail });
    }
  }

  function tickSession() {
    if (!sessionPath) {
      // The direct path costs one stat and is tried on every poll. The directory search reads every project
      // directory (about 45 ms on a real home) and runs on its own throttle from the spawn, with or without a cue.
      const search = finalizing || searchedAt === null || now() >= searchedAt + SEARCH_EVERY_MS;
      if (search) searchedAt = now();
      sessionPath = findSessionFile({ projectsDir, cwd, sessionId, exists: deps.exists, readdir: deps.readdir, search });
    }
    const text = sessionPath ? read(sessionPath) : null;
    if (text === null) {
      sessionPath = null;
      if (pastDeadline(settleMs)) finish(ses, { ok: false, failed: 'session_file_missing', detail: `no session file for ${sessionId}`, checks: [], facts: ses.last.facts });
      return;
    }
    noteReached(); // the file exists, with any content
    const r = checkSessionFile(text, requested);
    r.facts = { ...r.facts, session_file: sessionPath };
    ses.last = pendingResult(r);
    const hard = r.checks.filter((c) => !ASSISTANT_CHECKS.includes(c.name));
    const hardBad = hard.find((c) => c.ok === false && !c.missing);
    if (hardBad) { finish(ses, { ...r, ok: false, failed: hardBad.name, detail: hardBad.detail }); return; }
    const hardMissing = hard.find((c) => c.missing);
    if (hardMissing) {
      if (pastDeadline(settleMs)) {
        finish(ses, { ...r, ok: false, failed: hardMissing.name, detail: final ? `required entry ${hardMissing.name} absent when claude exited` : `required entry ${hardMissing.name} absent ${settleMs} ms after the session was reached` });
      }
      return;
    }
    if (r.ok === true) { finish(ses, r); return; }
    if (!final) return; // model and effort never kill a live session
    const bad = r.checks.find((c) => c.ok === false && !c.missing);
    if (bad) { finish(ses, { ...r, ok: false, failed: bad.name, detail: bad.detail }); return; }
    const miss = r.checks.find((c) => c.missing);
    finish(ses, { ...r, ok: false, failed: 'no_assistant_reply_before_exit', detail: `required entry ${miss.name} absent: claude exited before an assistant reply` });
  }

  // A throw inside a half (an entry of a shape nobody has seen) must not escape into the timer: it settles
  // that half as failed 'gate_error' with the message.
  const guarded = (h, fn) => {
    try { fn(); } catch (e) {
      finish(h, { ok: false, failed: 'gate_error', detail: `the gate threw: ${(e && e.message) || String(e)}`, checks: [], facts: h.last.facts });
    }
  };
  const runDebug = () => guarded(dbg, tickDebug);
  const runSession = () => guarded(ses, tickSession);

  function tick() {
    timer = null;
    if (stopped) return;
    if (!dbg.done) runDebug();
    if (!ses.done) runSession();
    if (!stopped && !(dbg.done && ses.done)) timer = setT(tick, pollMs);
  }
  tick();

  function finalize() {
    if (finalP) return finalP;
    stopped = true;
    if (timer !== null) { clearT(timer); timer = null; }
    finalizing = true;
    if (!dbg.done) runDebug(); // the last read: picks up the cues and any decisive result
    if (!ses.done) runSession();
    if (firstAt === null) {
      // Never reached: nothing but a leak or a stale log can fail. The halves keep what they learned.
      finish(dbg, undecided(dbg, 'not reached'));
      finish(ses, undecided(ses, 'not reached'));
    } else {
      final = true;
      if (!dbg.done) runDebug();
      if (!ses.done) runSession();
    }
    resolveFirst(firstAt);
    finalP = Promise.all([dbg.promise, ses.promise]).then(([debug, session]) => ({ debug, session }));
    return finalP;
  }

  return {
    debug: dbg.promise,
    session: ses.promise,
    firstMessage,
    current: () => ({ debug: dbg.last, session: ses.last }),
    finalize,
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) { clearT(timer); timer = null; }
      for (const h of [dbg, ses]) finish(h, undecided(h, 'stopped'));
      resolveFirst(firstAt);
    },
  };
}

module.exports = { encodeCwd, sessionFilePath, findSessionFile, checkDebugLog, checkSessionFile, createInteractiveGate };
