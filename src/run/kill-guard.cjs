'use strict';
// kill-guard.cjs — the matcher behind the kill-by-name hook (ADR 0024 amendment 7). A headless worker's or
// orchestrator's shell command that stops processes by name or pattern instead of by exact pid would reach every
// process on the machine, including the store owner and the operator's other sessions. `refusal(command)` returns the
// one-line refusal for such a command, or null. The match is textual and looks through wrappers (`cmd /c`,
// `powershell -Command`, `bash -c`) by scanning the whole string; it is a safety net, not a parser, and a command built
// at run time out of pieces escapes it. Plain node, no requires: guard.cjs runs it in the one hook process spawned for every Bash call.
const MESSAGE = 'Stop a process only by its exact pid; other processes on this machine are not yours.';

const STOP = String.raw`(?:stop-process|spps)`; // the PowerShell cmdlet and its alias; `kill` is handled below, it is also a shell builtin
const NAME_PARAM = String.raw`(?:^|\s)-(?:n(?:a(?:m(?:e)?)?)?|processname)(?=$|[\s:=])`;

// Segments are split at ; && || & and newlines; pipes stay inside a segment so `Get-Process x | Stop-Process` is one.
function segments(s) { return s.split(/;|&&|\|\||&|\r?\n/).map((x) => x.trim()).filter(Boolean); }

function segmentRefused(seg) {
  // taskkill: any image-name form (/IM, //IM, -IM, /im:name) or a filter that is not a pid.
  if (/\btaskkill(?:\.exe)?\b/.test(seg)) {
    if (/(?:^|\s)[/-]{1,2}im(?=$|[\s:="'])/.test(seg)) return true;
    if (/(?:^|\s)[/-]{1,2}fi(?=$|[\s:="'])/.test(seg) && !/\bpid\s+eq\b/.test(seg)) return true;
  }
  if (/\btskill(?:\.exe)?\s+(?!\d+\b)\S/.test(seg)) return true;
  if (/\b(?:pkill|killall5?)\b/.test(seg)) return true;
  // PowerShell: Stop-Process / spps / kill with -Name, or fed from a pipe that is not a pid lookup.
  const ps = new RegExp(String.raw`\b${STOP}\b`).test(seg);
  const k = /(?:^|[\s(|])kill\s+-/.test(seg) || /\|\s*kill\b/.test(seg);
  if (ps || k) {
    if (ps && new RegExp(NAME_PARAM).test(seg)) return true;
    if (k && new RegExp(NAME_PARAM + String.raw`\s*[^\d\s-]`).test(seg)) return true; // bash `kill -n 9 pid` is a signal, not a name
    const piped = new RegExp(String.raw`\|\s*(?:${STOP}|kill)\b`).exec(seg);
    if (piped) { const up = seg.slice(0, piped.index); if (!(/\s-id\s+\d/.test(up) && !new RegExp(NAME_PARAM).test(up))) return true; }
  }
  // bash: kill fed by a process lookup.
  if (/\bkill\b/.test(seg) && /(?:\$\(|`)\s*(?:pgrep|pidof|ps|tasklist)\b/.test(seg)) return true;
  if (/\bxargs\b[^|]*\bkill\b/.test(seg)) return true;
  // wmic / CIM: terminate or delete a process selected by anything but a processid.
  if (/\bwmic\b/.test(seg) && /\bprocess\b/.test(seg) && /\b(?:delete|terminate)\b/.test(seg)) {
    if (!/processid\s*=\s*\d+/.test(seg) || /\b(?:name|commandline|executablepath|caption)\s*(?:=|like)/.test(seg)) return true;
  }
  if (/win32_process/.test(seg) && /\bterminate\b|remove-ciminstance|remove-wmiobject/.test(seg) && /\b(?:name|commandline|executablepath)\b/.test(seg)) return true;
  return false;
}

function normalize(command, quote, unescape) {
  const t = String(command).toLowerCase().replace(/["']/g, quote);
  return unescape ? t.replace(/[\^`]/g, '') : t; // cmd `^` and PowerShell backtick escapes; bash keeps its backticks
}

// A line continuation joins the lines in some shells (bash backslash-newline, PowerShell backtick-newline, cmd caret-newline) and not in
// others (a PowerShell or cmd path ends in a backslash: `Set-Location C:\<NL>git push` is two commands). The tool is not known here, so a
// command is matched both ways, as the quote variants are: as written, and with every continuation joined.
const forms = (s) => [s, s.replace(/[\\`^]\r?\n/g, '')];

function refusal(rawCommand) {
  if (typeof rawCommand !== 'string' || !rawCommand) return null;
  for (const command of forms(rawCommand)) {
    for (const [quote, unescape] of [[' ', false], ['', false], [' ', true], ['', true]]) { // `t"ask"kill` joins, `cmd /c"taskkill` splits: try both
      const n = normalize(command, quote, unescape);
      if (segments(n).some(segmentRefused)) return MESSAGE;
      // Stop-Process fed by a name lookup in an earlier segment of the same command.
      if (/\bgetprocessesbyname\b/.test(n) && /\.kill\s*\(/.test(n)) return MESSAGE;
      // A taskkill whose pid is a variable, in a loop over a process lookup.
      if (/\btaskkill(?:\.exe)?\b[^;]*(?:^|\s)[/-]{1,2}pid\s+["']?[$%]/.test(n) && /(?:\$\(|`)\s*(?:tasklist|pgrep|pidof|ps|get-process|gps)\b/.test(n)) return MESSAGE;
      if (new RegExp(String.raw`\b${STOP}\b`).test(n) || /\.kill\s*\(/.test(n) || (/(?:^|[\s;|&(])kill\s+-/.test(n) && /powershell|pwsh/.test(n))) {
        for (const m of n.matchAll(/\b(?:get-process|gps)\b([^;|&)\n]*)/g)) if (!/\s-(?:id|pid)\s+\d/.test(m[1])) return MESSAGE;
      }
    }
  }
  return null;
}

// The PreToolUse deny, in Claude Code's documented hook output.
function denyOutput() {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: MESSAGE } });
}

module.exports = { refusal, denyOutput, MESSAGE };
