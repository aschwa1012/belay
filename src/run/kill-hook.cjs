'use strict';
// kill-hook.cjs — PreToolUse hook on the shell tools (ADR 0024 amendment 7, proposed). Reads Claude Code's hook payload
// from stdin; a command that kills processes by name or pattern is answered with a deny, anything else with nothing.
// A payload that cannot be read is allowed: the hook never fails a tool call by itself.
const { refusal, denyOutput } = require('./kill-guard.cjs');

let raw = '';
let done = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
function finish() {
  if (done) return;
  done = true;
  let command = null;
  try { command = JSON.parse(raw).tool_input.command; } catch { /* unreadable: allow */ }
  if (refusal(command)) process.stdout.write(denyOutput());
  process.exit(0);
}
process.stdin.on('end', finish);
setTimeout(finish, 3000).unref();
