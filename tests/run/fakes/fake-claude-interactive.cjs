'use strict';
// fake-claude-interactive.cjs — the stub for ADR 0037 decision 10. Selected like the other fakes, through
// BELAY_CLAUDE_EXE. It reads no stdin, records its argv and TTY facts, writes the debug file named by
// --debug-file and the session file at ${CLAUDE_CONFIG_DIR}/projects/<encoded cwd>/<session-id>.jsonl in the
// formats captured from a real session, holds, then exits.
// Steering (FAKE_*): FAKE_HOLD_MS (default 1000), FAKE_EXIT_CODE (default 0), FAKE_LEAK=1 (a surface that
// loads an instruction file, skills and a second MCP server), FAKE_NEVER_EXIT=1, FAKE_ORPHAN=1 (a grandchild
// that outlives nothing it should), FAKE_NO_SESSION=1 (never writes the session file), FAKE_SESSION_DELAY_MS
// (default 200), FAKE_RECORD_FILE (default: stub-record.json beside the debug file), FAKE_VERSION (2.1.293),
// FAKE_NO_FIRST=1 (no first message anywhere: no session file either), FAKE_NO_ASSISTANT=1 (a first message, no reply), FAKE_LATE_LEAK=1,
// FAKE_NO_ORIGIN=1 (the user entry carries no origin or promptSource), FAKE_NO_DEBUG_PROMPT=1 (no cc_prompt_index line),
// FAKE_NO_DEBUG_FILE=1 (never writes the debug file), FAKE_EMPTY_DEBUG=1 (writes it empty).
// It never touches ~/.claude: with no CLAUDE_CONFIG_DIR it writes no session file at all.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const debugFile = arg('--debug-file');
const sessionId = arg('--session-id');
const model = arg('--model');
const permissionMode = arg('--permission-mode');
const effort = arg('--effort');
const pluginDir = arg('--plugin-dir');
const version = process.env.FAKE_VERSION || '2.1.293';
const iso = () => new Date().toISOString();
const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

const record = {
  pid: process.pid, argv, cwd: process.cwd(),
  stdinTTY: !!process.stdin.isTTY, stdoutTTY: !!process.stdout.isTTY, stderrTTY: !!process.stderr.isTTY,
  env: { MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT || null, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || null, PWD: process.env.PWD || null, CLAUDE_CODE_NO_FLICKER: process.env.CLAUDE_CODE_NO_FLICKER === undefined ? null : process.env.CLAUDE_CODE_NO_FLICKER, CLAUDE_CODE_AUTO_CONNECT_IDE: process.env.CLAUDE_CODE_AUTO_CONNECT_IDE || null },
  started_at: Date.now(), grandchild_pid: null,
};
const recordFile = process.env.FAKE_RECORD_FILE || (debugFile ? path.join(path.dirname(debugFile), 'stub-record.json') : null);
const flush = () => { if (recordFile) fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`); };

if (process.env.FAKE_ORPHAN === '1') {
  const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  record.grandchild_pid = gc.pid;
}
flush();

// FAKE_TAMPER_PLUGIN: 'early' appends to a mod file 300 ms after start (a live leak), 'late' does it in the breath of the exit
// (only the finalize hash can see it), 'engine' writes only the two paths Claude Code itself writes into a plugin dir (must not fail).
const tamper = process.env.FAKE_TAMPER_PLUGIN;
const doTamper = () => {
  if (!pluginDir) return;
  if (tamper === 'engine') {
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin', 'types'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, '.claude-plugin', 'types', 'x.d.ts'), 'declare const x: 1');
    fs.writeFileSync(path.join(pluginDir, 'tsconfig.json'), '{}');
  } else fs.appendFileSync(path.join(pluginDir, 'hooks', 'wake', 'index.ts'), '// tampered\n');
};
if (tamper === 'early' || tamper === 'engine') setTimeout(doTamper, 300);

if (debugFile && process.env.FAKE_NO_DEBUG_FILE !== '1') {
  const leak = process.env.FAKE_LEAK === '1';
  const lines = [
    `${iso()} [DEBUG] MDM settings load completed in 4ms`,
    `${iso()} [DEBUG] Loaded 3 installed plugins from plugins/installed_plugins.json`,
    `${iso()} [DEBUG] Loaded ${leak ? 2 : 0} unique skills (0 unconditional, 0 conditional, managed: 0, user: ${leak ? 2 : 0}, project: 0, additional: 0, legacy commands: 0)`,
    `${iso()} [DEBUG] Found 8 plugins (4 enabled, 4 disabled)`,
    // ADR 0037 amendment 5: the lines a loaded --plugin-dir produces (wake2 receipts/M). FAKE_NO_PLUGIN=1 omits them;
    // FAKE_OTHER_PLUGIN=1 adds a second plugin directory.
    ...(pluginDir && process.env.FAKE_NO_PLUGIN !== '1' ? [
      `${iso()} [DEBUG] --plugin-dir ${pluginDir} is one plugin: .claude-plugin at its top marks it`,
      `${iso()} [DEBUG] Read hooks.json for plugin belay (enabled=true): ${pluginDir.split('/').join('\\')}\\hooks\\hooks.json`,
      `${iso()} [DEBUG] Loaded inline plugin from path: belay`,
      `${iso()} [DEBUG] Loaded 1 directory-loaded plugins`,
      `${iso()} [DEBUG] Checking plugin belay: skillsPath=none, skillsPaths=0 paths`,
    ] : []),
    ...(process.env.FAKE_OTHER_PLUGIN === '1' ? [`${iso()} [DEBUG] --plugin-dir C:/elsewhere/other is one plugin: .claude-plugin at its top marks it`] : []),
    ...(leak ? [] : [`${iso()} [DEBUG] No CLAUDE.md/rules files found`]),
    `${iso()} [DEBUG] Loaded plugins - Enabled: 4, Disabled: 4, Commands: 0, Agents: ${leak ? 1 : 0}, Errors: 0`,
    `${iso()} [DEBUG] Total plugin agents loaded: ${leak ? 1 : 0}`,
    `${iso()} [DEBUG] $.fs.ancestors (cc-plugin-agents-md): project memory is off`,
    ...(leak ? [`${iso()} [DEBUG] Loaded instruction file C:\\Home\\stub\\CLAUDE.md (123 bytes)`] : []),
    `${iso()} [DEBUG] attribution header x-anthropic-billing-header: cc_version=${version}.d9e; cc_entrypoint=cli; cch=00000;`,
    `${iso()} [DEBUG] MCP server "belay": Successfully connected (transport: stdio) in 969ms`,
    ...(leak ? [`${iso()} [DEBUG] MCP server "intruder": Successfully connected (transport: stdio) in 12ms`] : []),
    `${iso()} [DEBUG] [MCP] Server "belay" connected with subscribe=false`,
    ...(process.env.FAKE_NO_FIRST === '1' || process.env.FAKE_NO_DEBUG_PROMPT === '1' ? [] : [`${iso()} [DEBUG] attribution header x-anthropic-billing-header: cc_version=${version}.21b; cc_entrypoint=cli; cc_turn_origin=human; cc_prompt_index=1;`]),
    '',
  ];
  fs.mkdirSync(path.dirname(debugFile), { recursive: true });
  fs.writeFileSync(debugFile, process.env.FAKE_EMPTY_DEBUG === '1' ? '' : lines.join('\n'));
}

function writeSession() {
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (!cfg || !sessionId || process.env.FAKE_NO_SESSION === '1' || process.env.FAKE_NO_FIRST === '1') return; // no first message: claude has not written its session file yet
  const dir = path.join(cfg, 'projects', encodeCwd(process.cwd()));
  fs.mkdirSync(dir, { recursive: true });
  const common = { sessionId, cwd: process.cwd(), version };
  const common0 = { cwd: process.cwd() };
  const lines = [
    { type: 'mode', mode: 'normal', sessionId },
    { type: 'permission-mode', permissionMode, sessionId },
    { type: 'atis-latch', atis: '', sessionId },
    // The first batch of attachments a real session writes: the model identity and the environment (what the gate's
    // model and no-instructions checks wait for). No instructions or memory attachment, unless FAKE_LEAK says so.
    { type: 'attachment', attachment: { type: 'model', identity: { modelId: model } }, sessionId, ...common0 },
    { type: 'attachment', attachment: { type: 'environment' }, sessionId, ...common0 },
    ...(process.env.FAKE_LEAK === '1' ? [{ type: 'attachment', attachment: { type: 'instructions', files: [{ type: 'Project', path: 'CLAUDE.md' }] }, sessionId, ...common0 }] : []),
    ...(process.env.FAKE_NO_FIRST === '1' ? [] : [{ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: 'hello' }, uuid: '00000000-0000-4000-8000-000000000001', timestamp: iso(), permissionMode, ...(process.env.FAKE_NO_ORIGIN === '1' ? {} : { origin: { kind: 'human' } }), ...common }]),
    ...(process.env.FAKE_NO_FIRST === '1' || process.env.FAKE_NO_ASSISTANT === '1' ? [] : [{ parentUuid: '00000000-0000-4000-8000-000000000001', isSidechain: false, type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] }, uuid: '00000000-0000-4000-8000-000000000002', timestamp: iso(), ...(effort ? { effort } : {}), ...common }]),
  ];
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}
setTimeout(writeSession, Number(process.env.FAKE_SESSION_DELAY_MS || 200));

if (process.env.FAKE_EXIT_FILE) {
  // A quit on demand: exits with FAKE_EXIT_CODE (default 0) once the named file exists, like an operator's /exit.
  setInterval(() => { if (fs.existsSync(process.env.FAKE_EXIT_FILE)) process.exit(Number(process.env.FAKE_EXIT_CODE || 0)); }, 100);
} else if (process.env.FAKE_NEVER_EXIT === '1') {
  setInterval(() => {}, 1000);
  // FAKE_FALLBACK_EXIT_MS: a never-exiting stub that still leaves by itself after this long (a test must not hang on a regression).
  if (process.env.FAKE_FALLBACK_EXIT_MS) setTimeout(() => process.exit(0), Number(process.env.FAKE_FALLBACK_EXIT_MS));
} else {
  setTimeout(() => {
    if (tamper === 'late') doTamper();
    // FAKE_LATE_LEAK=1: a leak line lands in the same breath as the exit, past any poll (only finalize can see it).
    if (process.env.FAKE_LATE_LEAK === '1' && debugFile) fs.appendFileSync(debugFile, `${iso()} [DEBUG] Loaded 3 unique skills (0 unconditional)\n`);
    process.exit(Number(process.env.FAKE_EXIT_CODE || 0));
  }, Number(process.env.FAKE_HOLD_MS || 1000));
}
