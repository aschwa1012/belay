'use strict';
// compact-hook.cjs <label> <worker dir> — the three harness hooks of ADR 0007 decision 3, wired into a worker's
// --settings file by compaction.cjs only when the `compact_at_tokens` lever is on.
//   pre   : PreCompact. Prints the steering text; Claude Code turns non-empty stdout into the summariser's instructions.
//   post  : PostCompact. Records only.
//   start : SessionStart matcher `compact`. Prints the resume line from compact-resume.txt as additionalContext.
// Every invocation appends one line to <worker dir>/compact-hooks.jsonl; nothing else is written. No store, no embedder.
const fs = require('node:fs');
const path = require('node:path');
const C = require('./compaction.cjs');

const [label, dir] = process.argv.slice(2);
let raw = '';
let done = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
function finish() {
  if (done) return;
  done = true;
  let payload = null;
  try { payload = JSON.parse(raw); } catch { /* an unparseable payload is recorded as no trigger */ }
  let out = '';
  if (label === 'pre') out = C.STEER;
  if (label === 'start') {
    let line = '';
    try { line = fs.readFileSync(path.join(dir, C.RESUME_FILE), 'utf8'); } catch { /* no line, nothing injected */ }
    out = C.startOutput(line);
  }
  const rec = { t: Date.now(), label, trigger: (payload && payload.trigger) || null, payload_bytes: Buffer.byteLength(raw), emitted_bytes: Buffer.byteLength(out) };
  try { fs.appendFileSync(path.join(dir, C.HOOKS_LOG), JSON.stringify(rec) + '\n'); } catch { /* the hook must never fail the compaction */ }
  if (out) process.stdout.write(out);
  process.exit(0);
}
process.stdin.on('end', finish);
setTimeout(finish, 3000).unref();
