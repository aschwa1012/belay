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

function message(tempDir) {
  const dir = tempDir || os.tmpdir();
  return `Do not write to /tmp or <drive>:\\tmp: outside Git Bash's own commands that path is the root of the current drive, not a temp folder. Use ${dir} (os.tmpdir() or tempfile in a script, $TEMP in bash) or a path inside your worktree.`;
}

// A rooted tmp path: slashes unified, `.` and `..` resolved, case folded. `/tmp`, `\tmp`, `c:/tmp`, the MSYS `/c/tmp` and the
// `//?/c:/tmp` device prefix all name a tmp folder at a drive root; `tmp/x`, `./tmp/x` and `C:/repo/tmp` do not.
const ROOTED = [/^(?:[a-z]:)?\/tmp(?:\/|$)/, /^\/[a-z]\/tmp(?:\/|$)/, /^\/[?.]\/[a-z]:\/tmp(?:\/|$)/, /^\/[a-z]:\/tmp(?:\/|$)/];
function rootedTmp(p) {
  if (typeof p !== 'string' || !p) return false;
  const n = path.posix.normalize(p.replace(/\\/g, '/').toLowerCase());
  return ROOTED.some((re) => re.test(n));
}

// A path literal inside script text: `/tmp` or `\tmp` (also `\\tmp`, `c:/tmp`) that does not continue a longer path or name.
// The character before must not be a word character, `.`, `-`, `/`, `$`, `~` or `}`, so `src/tmp`, `./tmp`, `$TMPDIR/tmp`,
// `${TEMP}/tmp` and `http://host/tmp` pass; the character after must not extend the name, so `/tmpfoo` passes.
const LITERAL = /(?:^|[^\w.\-/$~}])(?:[a-z]:)?[\\/]{1,2}tmp(?![\w-])/i;
const INLINE = /\b(?:node(?:js)?|python[\d.]*|py|perl|ruby|deno|bun|pwsh|powershell)(?:\.exe)?\b[^\n;&|]*?\s(?:-e|--eval|-p|--print|-c|-command)(?=[\s"'=]|$)/i;
const HEREDOC = /(?<!<)<<(-?)\s*(["']?)([A-Za-z_][\w.-]*)\2/;

// The text of the command that a native interpreter will read as a script: every heredoc body, and everything after an
// interpreter's inline-script flag.
function scriptRegions(command) {
  const regions = [];
  const inline = INLINE.exec(command);
  if (inline) regions.push(command.slice(inline.index + inline[0].length));
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
