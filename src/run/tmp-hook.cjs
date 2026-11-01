'use strict';
// tmp-hook.cjs — PreToolUse hook on Write, Edit and Bash (proposed record, beside the kill hook). Reads Claude Code's hook
// payload from stdin; a call that would write the root of the current drive's `\tmp` is answered with a deny that names the
// session's own temp dir, anything else with nothing. A payload that cannot be read is allowed: the hook never fails a tool
// call by itself.
const { refusal, denyOutput } = require('./tmp-guard.cjs');

let raw = '';
let done = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
function finish() {
  if (done) return;
  done = true;
  let reason = null;
  try { reason = refusal(JSON.parse(raw), process.env.TEMP || process.env.TMP || process.env.TMPDIR || null); } catch { /* unreadable: allow */ }
  if (reason) process.stdout.write(denyOutput(reason));
  process.exit(0);
}
process.stdin.on('end', finish);
setTimeout(finish, 3000).unref();
