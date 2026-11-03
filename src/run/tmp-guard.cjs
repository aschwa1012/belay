'use strict';
// tmp-guard.cjs — the matcher behind the rooted-temp hook (ADR 0084, beside ADR 0024 amendment 7). Git Bash maps
// `/tmp` only in its own argument conversion. A native program a worker runs (node, python, the Write tool) that opens the
// literal `/tmp/x` gets the root of the current drive, `C:\tmp\x`, which is the operator's folder and not the session's
// temp dir. `refusal(payload, tempDir)` returns the one-line refusal for a PreToolUse payload that would do that, or null.
// Two checks: Write, Edit, MultiEdit and NotebookEdit by exact path, and a Bash command by a textual scan of its heredoc
// bodies and inline scripts (`node -e`, `python -c`). The Bash check is a safety net, not a parser: a path built at run
// time out of pieces escapes it, and a heredoc that only mentions `/tmp` in prose is refused. Plain node, no requires
// beyond os: guard.cjs runs it in the one hook process spawned for every Write, Edit and Bash call.
const os = require('node:os');
const path = require('node:path');

const FILE_TOOLS = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

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
// An inline-script flag directly after the interpreter (its path may be quoted: `"C:/Program Files/nodejs/node.exe"`) and its
// own options. Only an option known to take a separate value word may be followed by one (`node -r dotenv/config`, `python -X utf8`);
// any other word ends the interpreter's options. So `python run.py -c /tmp/x`, `python -u run.py -c /tmp/x`, `python -m x -c /tmp/y`
// and `node --inspect app.js -p /tmp/x` are the script's arguments, not the interpreter's. `-c` only after python or pwsh, `-p`
// only after node, never `perl -c`. An option not listed here that takes a separate value hides a following flag (fails open).
const flag = (exe, flags, withValue) => new RegExp(String.raw`(?<![\w.\-])(?:${exe})(?:\.exe)?(?![\w.\-])["']?(?:\s+(?:-(?:${withValue})(?=\s)\s+[^-\s"']\S*|-\S+))*?\s+(?:${flags})(?=[\s"'=]|$)`, 'gi');
const INLINE = [
  flag('node(?:js)?|bun|deno', '-e|--eval|-p|--print', 'r|C|-require|-import|-loader|-experimental-loader|-conditions|-env-file|-input-type|-preload|-cwd|-config'),
  flag('python[\\d.]*|py', '-c', 'X|W'),
  flag('perl', '-e', 'I'),
  flag('ruby', '-e', 'I|r|C'),
  flag('pwsh|powershell', '-c|-command', 'executionpolicy|ep|workingdirectory|wd|configurationname|config|outputformat|o|of|inputformat|in|if|windowstyle|w'),
];
const HEREDOC = /(?<!<)<<(-?)\s*(["']?)([A-Za-z_][\w.-]*)\2/;

// The interpreter's own script argument from `text` (just after the flag): the whole shell word, as written. Adjacent quoted
// pieces join into one word (`'it'\''s'`, `'a'"b"`, `"$(f "x")"`), so the word ends only at whitespace or `; & | < > )`
// outside quotes. What follows (`&& cat /tmp/out`) is the shell's again and is not scanned.
function scriptArg(text) {
  const s = text.replace(/^\s+/, '');
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = null; } else if (c === '\\') i++;
    else if (q === '"') { if (c === '"') q = null; } else if (c === '"' || c === "'") q = c;
    else if (/[\s;&|<>)]/.test(c)) return s.slice(0, i);
  }
  return s;
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

module.exports = { refusal, denyOutput, rootedTmp, message };
