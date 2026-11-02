'use strict';
// guard.cjs — the one PreToolUse hook for a worker's tool calls (ADR 0024 amendment 7 and ADR 0084). The kill-by-name check
// (kill-guard.cjs) and the drive-root `\tmp` check (tmp-guard.cjs) keep their own rules; this module runs both in one hook
// process, so a Bash call starts one node process where it started two. `decide(payload, tempDir)` returns the refusal text, or
// null. The kill check comes first: one deny carries one reason, which keeps the injected bytes within invariant 9's bound.
// Plain node: the hook process is spawned for every Bash, PowerShell, Write and Edit call.
const path = require('node:path');
const KG = require('./kill-guard.cjs');
const TG = require('./tmp-guard.cjs');

const MATCHER = 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit';

function decide(payload, tempDir) {
  if (!payload || typeof payload !== 'object' || !payload.tool_input || typeof payload.tool_input !== 'object') return null;
  return KG.refusal(payload.tool_input.command) || TG.refusal(payload, tempDir);
}

// The hooks block for a worker's or headless orchestrator's settings file.
function hooksBlock() {
  const fwd = (p) => p.split(path.sep).join('/');
  return { PreToolUse: [{ matcher: MATCHER, hooks: [{ type: 'command', command: `"${fwd(process.execPath)}" "${fwd(path.join(__dirname, 'guard-hook.cjs'))}"`, timeout: 5 }] }] };
}

module.exports = { decide, hooksBlock, denyOutput: TG.denyOutput, MATCHER };
