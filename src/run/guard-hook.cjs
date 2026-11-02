'use strict';
// guard-hook.cjs — the PreToolUse hook process (ADR 0024 amendment 7, ADR 0084). Reads Claude Code's hook payload from stdin;
// a call that kills processes by name, or writes the root of the current drive's `\tmp`, is answered with a deny, anything else
// with nothing. A payload that cannot be read is allowed: the hook never fails a tool call by itself.
const { decide, denyOutput } = require('./guard.cjs');

let raw = '';
let done = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
function finish() {
  if (done) return;
  done = true;
  let reason = null;
  try { reason = decide(JSON.parse(raw), process.env.TEMP || process.env.TMP || process.env.TMPDIR || null); } catch { /* unreadable: allow */ }
  if (reason) process.stdout.write(denyOutput(reason));
  process.exit(0);
}
process.stdin.on('end', finish);
setTimeout(finish, 3000).unref();
