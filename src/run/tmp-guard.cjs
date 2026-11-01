'use strict';
// tmp-guard.cjs — the matcher behind the rooted-temp hook (proposed record, beside ADR 0024 amendment 7). Git Bash maps
// `/tmp` only in its own argument conversion. A native program a worker runs (node, python, the Write tool) that opens the
// literal `/tmp/x` gets the root of the current drive, `C:\tmp\x`, which is the operator's folder and not the session's
// temp dir. `refusal(payload, tempDir)` returns the one-line refusal for a PreToolUse payload that would do that, or null.
// Two checks: Write, Edit, MultiEdit and NotebookEdit by exact path, and a Bash command by a textual scan of its heredoc
// bodies and inline scripts (`node -e`, `python -c`). The Bash check is a safety net, not a parser: a path built at run
// time out of pieces escapes it, and a heredoc that only mentions `/tmp` in prose is refused. Plain node, no requires
// beyond os: the hook process is spawned for every Write, Edit and Bash call.
const os = require('node:os');
const path = require('node:path');

const FILE_TOOLS = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };
const MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash';

// The reason goes into the model's context (invariant 9: at most 400 bytes injected per hook event), so the whole deny JSON is
// held under MAX_JSON bytes: a long temp-dir path is cut from its front, the rule is kept whole.
const MAX_JSON = 380;
const RULE_HEAD = 'Do not write to /tmp or <drive>:\\tmp: it is the root of the current drive, not a temp folder. Use ';
const RULE_TAIL = ' (os.tmpdir(), tempfile, $TEMP) or a path in your worktree.';
function message(tempDir) {
  let dir = String(tempDir || os.tmpdir());
  while (dir.length > 8 && Buffer.byteLength(denyOutput(RULE_HEAD + dir + RULE_TAIL), 'utf8') > MAX_JSON) dir = dir.replace(/^(?:\.\.\.)?[\s\S]{1,10}/, '...');
  return RULE_HEAD + dir + RULE_TAIL;
}

// A rooted tmp path: slashes unified, `.` and `..` resolved, case folded, and a trailing dot or space dropped from each segment
// (Win32 strips them: `C:/tmp./x` and `C:/tmp /x` are `C:\tmp\x`). `/tmp`, `\tmp`, `c:/tmp`, the MSYS `/c/tmp` and the
// `//?/c:/tmp` device prefix all name a tmp folder at a drive root; `tmp/x`, `./tmp/x` and `C:/repo/tmp` do not.
const ROOTED = [/^(?:[a-z]:)?\/tmp(?:\/|$)/, /^\/[a-z]\/tmp(?:\/|$)/, /^\/[?.]\/[a-z]:\/tmp(?:\/|$)/, /^\/[a-z]:\/tmp(?:\/|$)/];
function rootedTmp(p) {
  if (typeof p !== 'string' || !p) return false;
  const segs = p.replace(/\\/g, '/').toLowerCase().split('/').map((s) => (/^[. ]*$/.test(s) ? s : s.replace(/[. ]+$/, '')));
  return ROOTED.some((re) => re.test(path.posix.normalize(segs.join('/'))));
}

// A path literal inside script text: `/tmp` or `\tmp` (also `\\tmp`, `c:/tmp`) that does not continue a longer path or name.
// The character before must not be a word character, `.`, `-`, `/`, `$`, `~` or `}`, so `src/tmp`, `./tmp`, `$TMPDIR/tmp`,
// `${TEMP}/tmp` and `http://host/tmp` pass; the character after must not extend the name, so `/tmpfoo` passes.
const LITERAL = /(?:^|[^\w.\-/$~}])(?:[a-z]:)?[\\/]{1,2}tmp(?![\w-])/i;
// An inline-script flag directly after the interpreter and its own option flags (so `python run.py -c /tmp/x` and `node a.js -p`
// are the script's arguments, not the interpreter's). `-c` only after python or a shell, `-p` only after node, never `perl -c`.
const flag = (exe, flags) => new RegExp(String.raw`(?<![\w.\-])(?:${exe})(?:\.exe)?\b(?:\s+-\S+)*?\s+(?:${flags})(?=[\s"'=]|$)`, 'gi');
const INLINE = [flag('node(?:js)?|bun|deno', '-e|--eval|-p|--print'), flag('python[\\d.]*|py', '-c'), flag('perl|ruby', '-e'), flag('pwsh|powershell', '-c|-command')];
const HEREDOC = /(?<!<)<<(-?)\s*(["']?)([A-Za-z_][\w.-]*)\2/;

// The interpreter's own script argument from `text` (just after the flag): a quoted string up to its closing quote, or one bare
// word. What follows (`&& cat /tmp/out`) is the shell's again and is not scanned.
function scriptArg(text) {
  const s = text.replace(/^\s+/, '');
  const q = s[0];
  if (q !== '"' && q !== "'") return s.split(/\s/, 1)[0];
  for (let i = 1; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') i++;
    else if (s[i] === q) return s.slice(1, i);
  }
  return s.slice(1);
}

// The text of the command that a native interpreter will read as a script: every heredoc body, and each interpreter's
// inline-script argument.
function scriptRegions(command) {
  const regions = [];
  for (const re of INLINE) for (const m of command.matchAll(re)) regions.push(scriptArg(command.slice(m.index + m[0].length)));
  const lines = command.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = HEREDOC.exec(lines[i]);
    if (!m) continue;
    const body = [];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== m[3]) body.push(lines[j++]);
    regions.push(body.join('\n'));
    i = j;
  }
  return regions;
}

function refusal(payload, tempDir) {
  if (!payload || typeof payload !== 'object' || !payload.tool_input || typeof payload.tool_input !== 'object') return null;
  const tool = payload.tool_name;
  const input = payload.tool_input;
  if (Object.prototype.hasOwnProperty.call(FILE_TOOLS, tool)) return rootedTmp(input[FILE_TOOLS[tool]]) ? message(tempDir) : null;
  if (tool === 'Bash' && typeof input.command === 'string' && input.command) {
    if (scriptRegions(input.command).some((r) => LITERAL.test(r))) return message(tempDir);
  }
  return null;
}

// The PreToolUse deny, in Claude Code's documented hook output.
function denyOutput(reason) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

// The hooks block for a worker's or headless orchestrator's settings file.
function hooksBlock() {
  const fwd = (p) => p.split(path.sep).join('/');
  return { PreToolUse: [{ matcher: MATCHER, hooks: [{ type: 'command', command: `"${fwd(process.execPath)}" "${fwd(path.join(__dirname, 'tmp-hook.cjs'))}"`, timeout: 5 }] }] };
}

module.exports = { refusal, denyOutput, hooksBlock, rootedTmp, message, MATCHER };
