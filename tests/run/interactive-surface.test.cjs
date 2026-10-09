'use strict';
// interactive-surface.test.cjs — ADR 0037 decision 5. The fixtures are excerpts of the probe's real
// receipts (C1 passes, C0 is the leaking
// control). Each check has a mutation of the passing fixture that fails exactly that check.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const S = require('../../src/run/interactive-surface.cjs');

const FIX = path.join(__dirname, 'fixtures', 'interactive');
const rd = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
const DEBUG = rd('debug-pass.log');
const SESSION = rd('session-pass.jsonl');
const REQ = { model: 'claude-sonnet-5-5', permissionMode: 'auto', effort: 'medium', versionFloor: '2.1.280' };
const failedNames = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);
const without = (text, re) => text.split('\n').filter((l) => !re.test(l)).join('\n');

// ------------------------------------------------------------ session file path

test('sessionFilePath encodes a drive-letter cwd with spaces like Claude Code does', () => {
  const p = S.sessionFilePath({
    cwd: 'C:\\Home\\a b\\AppData\\Local\\Temp\\belay-iosurf-1007a\\C1\\wt',
    sessionId: 'sid', env: {}, home: 'C:\\Home\\a b',
  });
  assert.strictEqual(p, 'C:/Home/a b/.claude/projects/C--Home-a-b-AppData-Local-Temp-belay-iosurf-1007a-C1-wt/sid.jsonl');
});

test('sessionFilePath turns a dot into a dash (.claude -> --claude) and honours CLAUDE_CONFIG_DIR', () => {
  assert.strictEqual(S.encodeCwd('C:\\Home\\dev\\Projects\\belay\\.claude\\worktrees\\x'), 'C--Home-dev-Projects-belay--claude-worktrees-x');
  const p = S.sessionFilePath({ cwd: 'C:/w', sessionId: 's', env: { CLAUDE_CONFIG_DIR: 'D:\\cfg' }, home: 'C:/h' });
  assert.strictEqual(p, 'D:/cfg/projects/C--w/s.jsonl');
});

// ------------------------------------------------------------ debug log

test('the real C1 debug excerpt passes every check and yields its facts', () => {
  const r = S.checkDebugLog(DEBUG, REQ);
  assert.strictEqual(r.ok, true, JSON.stringify(r.checks));
  assert.deepStrictEqual(r.checks.map((c) => c.name),
    ['version', 'instructions', 'skills', 'plugin_agents', 'user_plugins_disabled', 'mcp_servers']);
  assert.strictEqual(r.facts.version, '2.1.293');
  assert.deepStrictEqual(r.facts.mcp_servers, ['belay']);
});

test('the real C0 (leaking control) debug excerpt fails instructions, skills, plugins, agents and mcp', () => {
  const r = S.checkDebugLog(rd('debug-leak.log'), REQ);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(failedNames(r).sort(), ['instructions', 'mcp_servers', 'plugin_agents', 'skills', 'user_plugins_disabled']);
});

const DEBUG_MUTATIONS = [
  ['version', (t) => t.replace(/cc_version=\d+\.\d+\.\d+/g, 'cc_version=2.1.279'), /below the floor/],
  ['instructions', (t) => t + '2026-10-07T18:28:39.800Z [DEBUG] "Loaded 1 CLAUDE.md/rules files:\\n  [User] C:\\\\x\\\\CLAUDE.md (70 chars)"\n', /Loaded 1 CLAUDE\.md/],
  ['skills', (t) => t.replace('Loaded 0 unique skills', 'Loaded 3 unique skills'), /Loaded 3 unique skills/],
  ['plugin_agents', (t) => t.replace('Agents: 0', 'Agents: 2'), /Agents: 2/],
  ['user_plugins_disabled', (t) => t.replace('plugin example-plugin (enabled=false; will NOT register, plugin is disabled)', 'plugin example-plugin (enabled=true)'), /example-plugin/],
  ['mcp_servers', (t) => t + '2026-10-07T18:28:40.800Z [DEBUG] MCP server "claude.ai Mail": Successfully connected (transport: sse) in 5ms\n', /claude\.ai Mail/],
];
for (const [name, mutate, detail] of DEBUG_MUTATIONS) {
  test(`debug: only the ${name} check fails when its line is wrong`, () => {
    const r = S.checkDebugLog(mutate(DEBUG), REQ);
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(failedNames(r), [name]);
    assert.match(r.checks.find((c) => c.name === name).detail, detail);
    assert.strictEqual(r.checks.find((c) => c.name === name).missing, undefined, 'a wrong value is decisive, not missing');
  });
}

const DEBUG_ABSENCES = [
  ['version', /cc_version=/],
  ['instructions', /CLAUDE\.md\/rules/],
  ['skills', /unique skills/],
  ['plugin_agents', /Loaded plugins - /],
  ['user_plugins_disabled', /Found \d+ plugins/],
  ['mcp_servers', /Successfully connected/],
];
for (const [name, re] of DEBUG_ABSENCES) {
  test(`debug: ${name} fails (never passes by default) when its line is absent, and names the pattern`, () => {
    const r = S.checkDebugLog(without(DEBUG, re), REQ);
    assert.strictEqual(r.ok, false);
    const c = r.checks.find((x) => x.name === name);
    assert.strictEqual(c.ok, false);
    assert.strictEqual(c.missing, true);
    assert.match(c.detail, /no line matching/);
  });
}

test('debug: an empty or unrecognised log fails every check', () => {
  for (const t of ['', 'hello\nworld\n']) {
    const r = S.checkDebugLog(t, REQ);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(failedNames(r).length, 6);
  }
});

// ------------------------------------------------------------ session file

test('the real C1 session excerpt passes and yields the facts', () => {
  const r = S.checkSessionFile(SESSION, REQ);
  assert.strictEqual(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.deepStrictEqual(r.facts, { permission_mode: 'auto', model: 'claude-sonnet-5-5', version: '2.1.293', effort: 'medium' });
});

const SESSION_MUTATIONS = [
  ['permission_mode', (t) => t.replace(/"permissionMode":"auto"/g, '"permissionMode":"default"'), /got default, requested auto/],
  ['model', (t) => t.replace(/claude-sonnet-5-5/g, 'claude-haiku-4-5'), /claude-haiku-4-5/],
  ['version', (t) => t.replace(/"version":"2\.1\.293"/g, '"version":"2.1.100"'), /below the floor/],
  ['effort', (t) => t.replace(/"effort":"medium"/g, '"effort":"low"'), /got low, requested medium/],
  ['no_instructions', (t) => t + rd('session-leak-instructions.jsonl'), /instructions .*CLAUDE\.md/],
];
for (const [name, mutate, detail] of SESSION_MUTATIONS) {
  test(`session: only the ${name} check fails when its entry is wrong`, () => {
    const r = S.checkSessionFile(mutate(SESSION), REQ);
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(failedNames(r), [name]);
    assert.match(r.checks.find((c) => c.name === name).detail, detail);
  });
}

test('session: the real C0 instructions attachment (home CLAUDE.md, auto-memory) is a leak', () => {
  const r = S.checkSessionFile(rd('session-leak-instructions.jsonl') + SESSION, REQ);
  assert.strictEqual(r.ok, false);
  assert.match(r.checks.find((c) => c.name === 'no_instructions').detail, /AutoMem:/);
});

test('session: a memory-typed attachment is a leak too', () => {
  const extra = JSON.stringify({ attachment: { type: 'nested_memory', files: [] }, type: 'attachment' }) + '\n';
  assert.deepStrictEqual(failedNames(S.checkSessionFile(SESSION + extra, REQ)), ['no_instructions']);
});

test('session: an empty file or one with only the leading entries is pending, not failed', () => {
  const e = S.checkSessionFile('', REQ);
  assert.strictEqual(e.ok, null);
  assert.ok(e.pending.includes('permission_mode') && e.pending.includes('model'));
  const head = SESSION.split('\n').slice(0, 2).join('\n') + '\n'; // mode + permission-mode only
  const r = S.checkSessionFile(head, REQ);
  assert.strictEqual(r.ok, null);
  assert.ok(!r.pending.includes('permission_mode'));
  assert.ok(r.pending.includes('model') && r.pending.includes('effort'));
});

test('session: effort is pending until an assistant entry exists, and unchecked when not requested', () => {
  const noAssistant = SESSION.split('\n').filter((l) => !l.includes('"type":"assistant"')).join('\n');
  const r = S.checkSessionFile(noAssistant, REQ);
  assert.strictEqual(r.ok, null);
  assert.deepStrictEqual(r.pending, ['model', 'effort']); // the model is read from the assistant entry too
  const noEffort = S.checkSessionFile(noAssistant, { ...REQ, effort: null });
  assert.deepStrictEqual(noEffort.pending, ['model']);
});

test('session: no model or environment attachment is required (typed-first-message sessions have none)', () => {
  const noAtt = SESSION.split('\n').filter((l) => !l.includes('"attachment"')).join('\n');
  assert.strictEqual(S.checkSessionFile(noAtt, REQ).ok, true);
});

test('debug: user_plugins_disabled needs 0 enabled user plugins and Commands: 0', () => {
  const user = S.checkDebugLog(DEBUG + '2026-10-07T18:28:35.289Z [DEBUG] Checking plugin example-plugin: skillsPath=exists, skillsPaths=0 paths\n', REQ);
  assert.deepStrictEqual(failedNames(user), ['user_plugins_disabled']);
  assert.match(user.checks.find((c) => c.name === 'user_plugins_disabled').detail, /example-plugin/);
  const builtin = S.checkDebugLog(DEBUG + '2026-10-07T18:28:35.289Z [DEBUG] Checking plugin cc-plugin-diff: skillsPath=none, skillsPaths=0 paths\n', REQ);
  assert.strictEqual(builtin.ok, true, 'the builtin cc-plugin-* entries C1 shows enabled are not user plugins');
  const cmds = S.checkDebugLog(DEBUG.replace('Commands: 0', 'Commands: 11'), REQ);
  assert.deepStrictEqual(failedNames(cmds), ['user_plugins_disabled']);
  assert.match(cmds.checks.find((c) => c.name === 'user_plugins_disabled').detail, /Commands: 11/);
});

test('debug: a configured MCP server that failed to connect fails mcp_servers, even beside belay', () => {
  const line = '2026-10-07T18:28:40.800Z [ERROR] MCP server "example": Connection failed after 30000ms: timeout\n';
  const r = S.checkDebugLog(DEBUG + line, REQ);
  assert.deepStrictEqual(failedNames(r), ['mcp_servers']);
  assert.match(r.checks.find((c) => c.name === 'mcp_servers').detail, /failed to connect: example.*pattern unverified/);
  assert.deepStrictEqual(r.facts.mcp_failed, ['example']);
});

test('session: a wrong value fails even while other entries are still pending', () => {
  const r = S.checkSessionFile('{"type":"permission-mode","permissionMode":"bypassPermissions"}\n', REQ);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.failed, 'permission_mode');
});

test('session: a complete line that is not JSON fails; a half-written last line does not', () => {
  const bad = S.checkSessionFile(SESSION + 'not json\n', REQ);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.failed, 'parse');
  const half = S.checkSessionFile(SESSION + '{"type":"assis', REQ);
  assert.strictEqual(half.ok, true);
});


// ------------------------------------------------------------ findSessionFile

test('findSessionFile: the direct path first, then a search of every project directory', () => {
  const files = { 'P/C--w/sid.jsonl': 'x' };
  const deps = { exists: (p) => p in files, readdir: () => ['aaa', 'C--w'] };
  assert.strictEqual(S.findSessionFile({ projectsDir: 'P', cwd: 'C:\\w', sessionId: 'sid', ...deps }), 'P/C--w/sid.jsonl');
  const hashed = { 'P/C--long-0a1b2c/sid.jsonl': 'x' };
  const d2 = { exists: (p) => p in hashed, readdir: () => ['aaa', 'C--long-0a1b2c'] };
  assert.strictEqual(S.findSessionFile({ projectsDir: 'P', cwd: 'C:\\a\\very\\long\\cwd', sessionId: 'sid', ...d2 }), 'P/C--long-0a1b2c/sid.jsonl');
  assert.strictEqual(S.findSessionFile({ projectsDir: 'P', cwd: 'C:\\w', sessionId: 'other', ...d2 }), null);
  assert.strictEqual(S.findSessionFile({ projectsDir: 'P', cwd: 'C:\\w', sessionId: 'sid', exists: () => false, readdir: () => { throw new Error('ENOENT'); } }), null);
});

// ------------------------------------------------------------ the gate

const SID = 'sid';
const SPATH = 'P/C--w/sid.jsonl';
const SPAWN = Date.parse('2026-10-07T18:28:30.000Z'); // before every timestamp of the debug fixtures
const FIRST = rd('debug-first-message.log'); // the real C1 line carrying cc_prompt_index=1
const DEBUG_NO_PROMPT = without(DEBUG, /cc_prompt_index/); // the excerpt with the first message's header lines removed
const DEBUG_P = DEBUG_NO_PROMPT + FIRST; // ... and then the first message arrives

function fakeEnv(files) {
  let t = 0;
  const timers = new Map();
  let id = 0;
  return {
    files,
    deps: {
      readFile: (p) => { if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[p]; },
      exists: (p) => p in files,
      readdir: () => [...new Set(Object.keys(files).filter((k) => k.startsWith('P/')).map((k) => k.split('/')[1]))],
      now: () => t,
      setTimeout: (fn, ms) => { timers.set(++id, { fn, at: t + ms }); return id; },
      clearTimeout: (h) => { timers.delete(h); },
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); t = due[1].at; due[1].fn();
      }
      t = end;
    },
    timerCount: () => timers.size,
  };
}
const tick = () => new Promise((r) => setImmediate(r));
const mk = (env, over = {}) => S.createInteractiveGate({
  debugFile: 'D', projectsDir: 'P', cwd: 'C:\\w', sessionId: SID, requested: REQ, spawnedAt: SPAWN,
  surfaceMs: 15000, settleMs: 15000, pollMs: 250, deps: env.deps, ...over,
});
const watch = (p) => { const s = { done: false, value: null }; p.then((v) => { s.done = true; s.value = v; }); return s; };

test('gate: a slow operator is not killed: the first message 60 s after spawn still passes (the clock starts there)', async () => {
  const env = fakeEnv({ D: DEBUG_NO_PROMPT });
  const g = mk(env);
  const d = watch(g.debug);
  env.advance(60000); await tick();
  assert.strictEqual(d.done, false, 'no first message, nothing can fail on time');
  env.files.D = DEBUG_P;
  env.advance(250);
  assert.strictEqual(await g.firstMessage, 60250);
  env.advance(14000); await tick();
  assert.strictEqual(d.done, false, 'the verdict waits for firstMessage + surfaceMs');
  env.advance(1500); await tick();
  assert.strictEqual(d.done, true);
  assert.strictEqual(d.value.ok, true);
  assert.strictEqual(d.value.facts.version, '2.1.293');
  g.stop();
});

test('gate: the debug verdict is over the whole file, never the first passing prefix', async () => {
  const env = fakeEnv({ D: DEBUG_P });
  const g = mk(env);
  const d = watch(g.debug);
  env.advance(14000); await tick();
  assert.strictEqual(d.done, false, 'a passing prefix does not settle the half early');
  env.files.D += '2026-10-07T18:29:00.000Z [DEBUG] MCP server "claude.ai Mail": Successfully connected (transport: sse) in 5ms\n';
  env.advance(250); await tick();
  assert.strictEqual(d.done, true);
  assert.strictEqual(d.value.ok, false);
  assert.strictEqual(d.value.failed, 'mcp_servers');
  g.stop();
});

test('gate: lines appended after a passing prefix (Agents: 6) fail it; untouched, the same prefix passes at the deadline', async () => {
  const env = fakeEnv({ D: DEBUG_P });
  const g = mk(env);
  env.files.D += '2026-10-07T18:29:00.000Z [DEBUG] Loaded plugins - Enabled: 4, Disabled: 4, Commands: 0, Agents: 6, Errors: 0\n';
  env.advance(250);
  const r = await g.debug;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.failed, 'plugin_agents');
  g.stop();
  const env2 = fakeEnv({ D: DEBUG_P });
  const g2 = mk(env2);
  const d2 = watch(g2.debug);
  env2.advance(14750); await tick();
  assert.strictEqual(d2.done, false);
  env2.advance(250); await tick();
  assert.strictEqual(d2.value.ok, true, 'at exactly firstMessage + surfaceMs');
  g2.stop();
});

test('gate: a decisive leak line fails at once, even before the first message', async () => {
  const env = fakeEnv({ D: rd('debug-leak.log') });
  const g = mk(env, { spawnedAt: 0 });
  const r = await g.debug;
  assert.strictEqual(r.ok, false);
  assert.ok(['instructions', 'skills', 'plugin_agents', 'user_plugins_disabled', 'mcp_servers'].includes(r.failed), r.failed);
  assert.strictEqual(env.timerCount() > 0, true, 'the session half is still polling');
  g.stop();
});

test('gate: an enabled user plugin (the H5 shape, handrun-dummy) before the session is reached fails user_plugins_disabled at once', async () => {
  const leaky = DEBUG_NO_PROMPT.replace('plugin example-plugin (enabled=false; will NOT register, plugin is disabled)', 'plugin handrun-dummy (enabled=true)');
  const env = fakeEnv({ D: leaky });
  const g = mk(env);
  const r = await g.debug;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.failed, 'user_plugins_disabled');
  assert.match(r.detail, /handrun-dummy/);
  assert.strictEqual(g.current().session.ok, null, 'nothing was reached');
  g.stop();
});

test('gate: a stale debug log (first timestamp before spawnedAt) fails stale_debug_log at once', async () => {
  const env = fakeEnv({ D: DEBUG_P });
  const g = mk(env, { spawnedAt: Date.parse('2026-10-07T18:30:00.000Z') });
  const r = await g.debug;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.failed, 'stale_debug_log');
  assert.match(r.detail, /before the spawn/);
  g.stop();
});

test('gate: a missing debug file fails as debug_file_missing at firstMessage + surfaceMs, and not before a first message', async () => {
  const env = fakeEnv({ S_: '' });
  const g = mk(env);
  const d = watch(g.debug);
  env.advance(40000); await tick();
  assert.strictEqual(d.done, false, 'without a first message there is no clock');
  env.files[SPATH] = rd('session-e1.jsonl'); // the first typed user entry starts the clock
  env.advance(250);
  const first = await g.firstMessage;
  assert.strictEqual(first, 40250);
  env.advance(15000); await tick();
  assert.strictEqual(d.value.failed, 'debug_file_missing');
  g.stop();
});

const E1_REQ = { ...REQ, effort: 'high' };
for (const [name, fixture, req] of [['E1', 'session-e1.jsonl', E1_REQ], ['I1', 'session-i1.jsonl', { ...REQ, effort: 'medium' }]]) {
  test(`gate: the real ${name} typed-first-message session (no model or environment attachment) passes within the deadline`, async () => {
    const env = fakeEnv({ D: DEBUG_P, [SPATH]: rd(fixture) });
    const g = mk(env, { requested: req });
    const r = await g.session;
    assert.strictEqual(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
    assert.strictEqual(r.facts.session_file, SPATH);
    assert.strictEqual(r.facts.model, 'claude-sonnet-5-5');
    assert.strictEqual(r.facts.permission_mode, 'auto');
    assert.strictEqual(r.facts.effort, req.effort);
    assert.strictEqual(typeof (await g.firstMessage), 'number');
    g.stop();
  });
}

test('gate: the real I2 session has no assistant turn: a live session is never killed for it (1 h), finalize fails no_assistant_reply_before_exit', async () => {
  const env = fakeEnv({ D: DEBUG_P, [SPATH]: rd('session-i2.jsonl') });
  const g = mk(env, { requested: { ...REQ, effort: null } });
  const s = watch(g.session);
  const d = watch(g.debug);
  env.advance(60 * 60 * 1000); await tick();
  assert.strictEqual(s.done, false, 'stage 1 passed; model stays pending for as long as claude lives');
  assert.strictEqual(d.value.ok, true, 'the debug half settles on its own');
  assert.strictEqual(g.current().session.ok, null);
  assert.deepStrictEqual(g.current().session.pending, ['model']);
  const r = await g.finalize();
  assert.strictEqual(r.session.ok, false);
  assert.strictEqual(r.session.failed, 'no_assistant_reply_before_exit');
});

test('gate: a WRONG model or effort is not acted on while claude lives either; finalize names it', async () => {
  const wrong = rd('session-e1.jsonl').replace(/claude-sonnet-5-5/g, 'claude-haiku-4-5');
  const env = fakeEnv({ D: DEBUG_P, [SPATH]: wrong });
  const g = mk(env, { requested: E1_REQ });
  const s = watch(g.session);
  env.advance(60 * 60 * 1000); await tick();
  assert.strictEqual(s.done, false);
  const r = await g.finalize();
  assert.strictEqual(r.session.failed, 'model');
});

test('gate: a first assistant reply arriving at 200 s passes the session half', async () => {
  const assistant = rd('session-e1.jsonl').split('\n').find((l) => l.includes('"type":"assistant"')) + '\n';
  const env = fakeEnv({ D: DEBUG_P, [SPATH]: rd('session-i2.jsonl') });
  const g = mk(env, { requested: E1_REQ });
  const s = watch(g.session);
  env.advance(200000); await tick();
  assert.strictEqual(s.done, false);
  env.files[SPATH] += assistant;
  env.advance(250); await tick();
  assert.strictEqual(s.value.ok, true, JSON.stringify(s.value.checks.filter((c) => !c.ok)));
  assert.strictEqual(s.value.facts.model, 'claude-sonnet-5-5');
  g.stop();
});

test('gate: a missing stage-1 entry (permission-mode) still fails at settleMs even while the reply is pending', async () => {
  const noMode = rd('session-i2.jsonl').split('\n').filter((l) => !l.includes('"type":"permission-mode"')).join('\n');
  const env = fakeEnv({ D: DEBUG_P, [SPATH]: noMode });
  const g = mk(env, { requested: E1_REQ });
  const s = watch(g.session);
  env.advance(15000); await tick();
  assert.strictEqual(s.value.failed, 'permission_mode');
  g.stop();
});

const USER_LINE = rd('session-e1.jsonl').split('\n').filter((l) => l.includes('"type":"user"'))[0] + '\n';
test('gate: reached = the session file exists (a mode-only file counts), the debug cue, or both (the earlier wins)', async () => {
  const modeOnly = rd('session-e1.jsonl').split('\n').slice(0, 3).join('\n') + '\n'; // mode + permission-mode, no user entry
  // session file alone, with mode entries only: reached the poll it exists, no user entry needed
  let env = fakeEnv({ D: DEBUG_NO_PROMPT });
  let g = mk(env);
  env.advance(5000);
  assert.strictEqual(g.current().session.ok, null);
  env.files[SPATH] = modeOnly;
  env.advance(250);
  assert.strictEqual(await g.firstMessage, 5250, 'a mode-only session file is reached');
  assert.notStrictEqual(g.current().debug.ok, false, 'the cue is not a failure');
  g.stop();
  // debug cue alone (no session file yet): the clock still starts, nothing fails before the deadlines
  env = fakeEnv({ D: DEBUG_NO_PROMPT });
  g = mk(env);
  env.advance(7000);
  env.files.D = DEBUG_P;
  env.advance(250);
  assert.strictEqual(await g.firstMessage, 7250);
  assert.strictEqual(g.current().session.ok, null);
  g.stop();
  // both: the debug cue is earlier
  env = fakeEnv({ D: DEBUG_NO_PROMPT });
  g = mk(env);
  env.advance(1000);
  env.files.D = DEBUG_P;
  env.advance(250);
  env.advance(3000);
  env.files[SPATH] = modeOnly + USER_LINE;
  env.advance(250);
  assert.strictEqual(await g.firstMessage, 1250);
  const d = watch(g.debug);
  env.advance(13750); await tick();
  assert.strictEqual(d.value && d.value.ok, true, 'the debug deadline counts from the earlier cue');
  g.stop();
  // both: the session file is earlier than the debug cue
  env = fakeEnv({ D: DEBUG_NO_PROMPT });
  g = mk(env);
  env.advance(1000);
  env.files[SPATH] = modeOnly;
  env.advance(250);
  env.files.D = DEBUG_P;
  env.advance(2000);
  assert.strictEqual(await g.firstMessage, 1250);
  g.stop();
});

test('gate: with no cue at all a session file at a hashed path is found by the throttled search, reached, and decided during the run', async () => {
  // N4: the search runs from the spawn, so finding the file does not wait for a cue that only the file could give.
  const env = fakeEnv({ D: DEBUG_NO_PROMPT });
  let lists = 0;
  const readdir = env.deps.readdir;
  env.deps.readdir = (...a) => { lists++; return readdir(...a); };
  const g = mk(env, { requested: E1_REQ, cwd: 'C:\\some\\other\\cwd' });
  const s = watch(g.session);
  env.advance(10000); await tick();
  assert.strictEqual(s.done, false);
  assert.ok(lists >= 4 && lists <= 6, `the search is throttled to one per 2 s: ${lists} listings in 10 s`);
  env.files['P/C--long-0a1b2c/sid.jsonl'] = rd('session-e1.jsonl');
  env.advance(2000); await tick();
  assert.strictEqual(s.value.ok, true, 'decided during the run, without finalize');
  assert.strictEqual(s.value.facts.session_file, 'P/C--long-0a1b2c/sid.jsonl');
  assert.strictEqual(typeof (await g.firstMessage), 'number');
  g.stop();
});

test('gate: a missing version line before the session is reached fails nothing, however long the wait', async () => {
  const env = fakeEnv({ D: without(DEBUG_NO_PROMPT, /cc_version=/) });
  const g = mk(env);
  const d = watch(g.debug);
  const s = watch(g.session);
  env.advance(60 * 60 * 1000); await tick();
  assert.strictEqual(d.done, false);
  assert.strictEqual(s.done, false);
  assert.strictEqual(g.current().debug.ok, null);
  g.stop();
});

test('gate: a session lacking permission-mode fails at firstMessage + settleMs, naming it', async () => {
  const noMode = rd('session-e1.jsonl').split('\n').filter((l) => !l.includes('"type":"permission-mode"')).join('\n');
  const env = fakeEnv({ D: DEBUG_P, [SPATH]: noMode });
  const g = mk(env, { requested: E1_REQ });
  const s = watch(g.session);
  env.advance(14750); await tick();
  assert.strictEqual(s.done, false);
  env.advance(250); await tick();
  assert.strictEqual(s.value.ok, false);
  assert.strictEqual(s.value.failed, 'permission_mode');
  g.stop();
});

test('gate: the session file is found by id in a directory that is not the encoded cwd (a hashed long path)', async () => {
  const env = fakeEnv({ D: DEBUG_P, 'P/C--long-0a1b2c/sid.jsonl': rd('session-e1.jsonl') });
  const g = mk(env, { requested: E1_REQ, cwd: 'C:\\some\\other\\cwd' });
  const r = await g.session;
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.facts.session_file, 'P/C--long-0a1b2c/sid.jsonl');
  g.stop();
});

test('gate: no session file anywhere fails session_file_missing at firstMessage + settleMs, not a false ok', async () => {
  const env = fakeEnv({ D: DEBUG_P });
  const g = mk(env);
  const s = watch(g.session);
  env.advance(14750); await tick();
  assert.strictEqual(s.done, false);
  env.advance(250); await tick();
  assert.strictEqual(s.value.ok, false);
  assert.strictEqual(s.value.failed, 'session_file_missing');
  g.stop();
});

test('gate: a session value that differs resolves ok false at once', async () => {
  const env = fakeEnv({ D: DEBUG_P, [SPATH]: rd('session-e1.jsonl').replace(/"permissionMode":"auto"/g, '"permissionMode":"plan"') });
  const g = mk(env, { requested: E1_REQ });
  const r = await g.session;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.failed, 'permission_mode');
  g.stop();
});

test('gate: stop() resolves pending halves with reason stopped and every fact learned, clears timers, resolves firstMessage', async () => {
  const head = rd('session-e1.jsonl').split('\n').slice(0, 3).join('\n') + '\n'; // mode + permission-mode, no user entry yet
  const env = fakeEnv({ D: DEBUG_NO_PROMPT, [SPATH]: head });
  const g = mk(env, { requested: E1_REQ });
  env.advance(500);
  assert.ok(env.timerCount() > 0);
  const cur = g.current();
  assert.strictEqual(cur.session.facts.permission_mode, 'auto');
  assert.strictEqual(cur.debug.facts.version, '2.1.293');
  g.stop();
  const d = await g.debug;
  const s = await g.session;
  assert.strictEqual(d.ok, null); assert.strictEqual(d.reason, 'stopped'); assert.strictEqual(d.facts.version, '2.1.293');
  assert.strictEqual(s.ok, null); assert.strictEqual(s.reason, 'stopped'); assert.strictEqual(s.facts.permission_mode, 'auto');
  assert.strictEqual(s.facts.session_file, SPATH);
  assert.strictEqual(await g.firstMessage, 0, 'the mode-only session file existed at the first poll: reached');
  assert.strictEqual(env.timerCount(), 0);
  g.stop(); // idempotent
});

test('gate: finalize() after a clean first message, before any deadline, decides both halves ok and clears the timers', async () => {
  const env = fakeEnv({ D: DEBUG_P, [SPATH]: rd('session-e1.jsonl') });
  const g = mk(env, { requested: E1_REQ });
  const r = await g.finalize();
  assert.strictEqual(r.debug.ok, true);
  assert.strictEqual(r.session.ok, true);
  assert.strictEqual(r.session.facts.model, 'claude-sonnet-5-5');
  assert.strictEqual(env.timerCount(), 0);
  assert.strictEqual(typeof (await g.firstMessage), 'number');
  assert.strictEqual(g.finalize(), g.finalize(), 'idempotent');
});

test('gate: finalize() decides a debug check whose line is absent as failed, naming it', async () => {
  const env = fakeEnv({ D: without(DEBUG_P, /Loaded plugins - Enabled/), [SPATH]: rd('session-e1.jsonl') });
  const g = mk(env, { requested: E1_REQ });
  env.advance(1000); // far inside surfaceMs: without finalize the debug half is still pending
  assert.strictEqual(g.current().debug.ok, null);
  const r = await g.finalize();
  assert.strictEqual(r.debug.ok, false);
  assert.strictEqual(r.debug.failed, 'plugin_agents');
});

test('gate: finalize() sees a leak line that arrived after the last poll', async () => {
  const env = fakeEnv({ D: DEBUG_P, [SPATH]: rd('session-e1.jsonl') });
  const g = mk(env, { requested: E1_REQ });
  env.advance(1000);
  env.files.D = `${DEBUG_P}\n2026-10-07T18:29:30.000Z [DEBUG] Loaded 3 unique skills (0 unconditional)\n`;
  const r = await g.finalize();
  assert.strictEqual(r.debug.ok, false);
  assert.strictEqual(r.debug.failed, 'skills');
});

test('gate: finalize() with a first message but no assistant entry fails no_assistant_reply_before_exit; a missing permission-mode still names itself', async () => {
  const env = fakeEnv({ D: DEBUG_P, [SPATH]: rd('session-i2.jsonl') });
  const g = mk(env, { requested: { ...REQ, effort: null } });
  const r = await g.finalize();
  assert.strictEqual(r.session.ok, false);
  assert.strictEqual(r.session.failed, 'no_assistant_reply_before_exit');
  assert.match(r.session.detail, /model/);
  const noMode = rd('session-e1.jsonl').split('\n').filter((l) => !l.includes('"permission-mode"')).join('\n');
  const env2 = fakeEnv({ D: DEBUG_P, [SPATH]: noMode });
  const g2 = mk(env2, { requested: E1_REQ });
  const r2 = await g2.finalize();
  assert.strictEqual(r2.session.ok, false);
  assert.strictEqual(r2.session.failed, 'permission_mode');
});

test('gate: finalize() with no first message resolves both halves ok null, reason not reached, and firstMessage null', async () => {
  const env = fakeEnv({ D: DEBUG_NO_PROMPT });
  const g = mk(env);
  env.advance(500);
  const r = await g.finalize();
  assert.strictEqual(r.debug.ok, null); assert.strictEqual(r.debug.reason, 'not reached');
  assert.strictEqual(r.session.ok, null); assert.strictEqual(r.session.reason, 'not reached');
  assert.strictEqual(await g.firstMessage, null);
  assert.strictEqual(env.timerCount(), 0);
});

test('gate: finalize() keeps a half already decided', async () => {
  const env = fakeEnv({ D: DEBUG_P, [SPATH]: rd('session-e1.jsonl') });
  const g = mk(env, { requested: E1_REQ });
  const first = await g.session; // decided ok by the poll
  const r = await g.finalize();
  assert.strictEqual(r.session, first);
  assert.ok(!r.session.finalized);
});

test('gate: reads only: a real directory is byte- and mtime-identical, with no new file, after a full run', async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'belay-gate-'));
  try {
    const proj = path.join(dir, 'projects', 'C--w');
    fs.mkdirSync(proj, { recursive: true });
    const dfile = path.join(dir, 'debug.log');
    fs.writeFileSync(dfile, DEBUG_P);
    fs.writeFileSync(path.join(proj, `${SID}.jsonl`), rd('session-e1.jsonl'));
    const list = () => {
      const out = [];
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { out.push(`${p} <dir> ${fs.statSync(p).mtimeMs}`); walk(p); } else { const st = fs.statSync(p); out.push(`${p} ${st.size} ${st.mtimeMs} ${fs.readFileSync(p).toString('base64')}`); }
      });
      walk(dir);
      return out.sort();
    };
    const before = list();
    const g = S.createInteractiveGate({
      debugFile: dfile, projectsDir: path.join(dir, 'projects'), cwd: 'C:\\w', sessionId: SID, requested: E1_REQ,
      spawnedAt: SPAWN, surfaceMs: 150, settleMs: 150, pollMs: 20,
    });
    assert.strictEqual((await g.session).ok, true);
    assert.strictEqual((await g.debug).ok, true);
    g.stop();
    assert.deepStrictEqual(list(), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const BELOW = (t) => t.replace(/cc_version=\d+\.\d+\.\d+/g, 'cc_version=2.1.279');

test('R4-3: a below-floor version line before the session is reached does not fail at once', async () => {
  const env = fakeEnv({ D: BELOW(DEBUG_NO_PROMPT) });
  const g = mk(env);
  const d = watch(g.debug);
  env.advance(60000); await tick();
  assert.strictEqual(d.done, false, 'the version is decided once reached, never before');
  g.stop();
});

test('R4-1: a quit before the first message with a below-floor version leaves the debug half undecided: no failed, no detail', async () => {
  const env = fakeEnv({ D: BELOW(DEBUG_NO_PROMPT) });
  const g = mk(env);
  env.advance(500);
  const r = await g.finalize();
  assert.strictEqual(r.debug.ok, null); assert.strictEqual(r.debug.reason, 'not reached');
  assert.ok(!('failed' in r.debug), 'a check that was never decided is reported failed');
  assert.ok(!('detail' in r.debug));
  const g2 = mk(fakeEnv({ D: BELOW(DEBUG_NO_PROMPT) }));
  g2.stop();
  const s = await g2.debug;
  assert.ok(!('failed' in s) && !('detail' in s) && s.reason === 'stopped');
});
