'use strict';
// Argument checks for RunManager.spawn, moved verbatim out of manager.cjs (the 500-line rule, ADR 0030).
// Every refusal here happens before any row is written or any file created.

const L = require('./launch.cjs');
const { fail } = require('./errors.cjs');

function validateSpawnArgs({ substrate, worktree, prompt, permission_prompt, permit_wait_ms, effort, worker_id }) {
  if (substrate !== 'claude-code' && substrate !== 'codex') fail('E_ARGS', 'substrate must be claude-code or codex', { substrate });
  if (!worktree) fail('E_ARGS', 'spawn needs a worktree');
  if (typeof prompt !== 'string' || !prompt) fail('E_ARGS', 'spawn needs a prompt');
  if (typeof permission_prompt !== 'boolean') fail('E_ARGS', 'spawn permission_prompt must be a boolean', { permission_prompt });
  if (!Number.isInteger(permit_wait_ms) || permit_wait_ms <= 0) fail('E_ARGS', 'spawn permit_wait_ms must be a positive integer', { permit_wait_ms });
  if (effort !== null && !L.EFFORT_LEVELS.includes(effort)) fail('E_ARGS', `spawn effort must be one of ${L.EFFORT_LEVELS.join(', ')} (ADR 0028)`, { effort });
  if (effort !== null && substrate === 'codex') fail('E_SUBSTRATE', 'codex effort is not measured, so spawn refuses it (ADR 0028 decision 6)', { substrate, effort });
  // ADR 0020 decision 1: Codex has no permission channel (approval_policy="never", MCP tools
  // pre-approved, ADR 0001 §1) — refused before any row is written or any file created.
  if (permission_prompt && substrate === 'codex') {
    fail('E_SUBSTRATE', 'codex has no permission channel: codex exec runs under approval_policy="never" with MCP tools pre-approved (ADR 0001 §1)', { substrate, worker_id: worker_id || null });
  }
}

module.exports = { validateSpawnArgs };
