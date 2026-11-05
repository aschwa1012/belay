'use strict';
// guard.cjs — the one PreToolUse hook for a worker's tool calls (ADR 0024 amendment 7 and ADR 0084). The kill-by-name check
// (kill-guard.cjs), the drive-root `\tmp` check (tmp-guard.cjs) and, for a worker, the push check (push-guard.cjs) and the stash check (stash-guard.cjs, ADR 0086) keep their
// own rules; this module runs them in one hook process, so a Bash call starts one node process. `decide(payload, tempDir, { push })`
// returns the refusal text, or null; `push` (the worker role: push and stash checks) is true only in a worker's settings (ADR 0085), never the orchestrator's. The kill
// check comes first, then the push check: one deny carries one reason, which keeps the injected bytes within invariant 9's bound.
// Plain node: the hook process is spawned for every Bash, PowerShell, Write and Edit call.
const path = require('node:path');
const KG = require('./kill-guard.cjs');
const TG = require('./tmp-guard.cjs');
const PG = require('./push-guard.cjs');
const SG = require('./stash-guard.cjs');

const MATCHER = 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit';

function decide(payload, tempDir, { push = false } = {}) {
  if (!payload || typeof payload !== 'object' || !payload.tool_input || typeof payload.tool_input !== 'object') return null;
  const command = payload.tool_input.command;
  return KG.refusal(command) || (push ? PG.refusal(command) || SG.refusal(command) : null) || TG.refusal(payload, tempDir);
}

// The hooks block for a worker's or headless orchestrator's settings file. `push` adds the push check through the hook's own command
// line: the role comes from an argument belay writes, never from a prompt (invariant 3).
function hooksBlock({ push = false } = {}) {
  const fwd = (p) => p.split(path.sep).join('/');
  return { PreToolUse: [{ matcher: MATCHER, hooks: [{ type: 'command', command: `"${fwd(process.execPath)}" "${fwd(path.join(__dirname, 'guard-hook.cjs'))}"${push ? ' --push' : ''}`, timeout: 5 }] }] };
}

module.exports = { decide, hooksBlock, denyOutput: TG.denyOutput, MATCHER };
