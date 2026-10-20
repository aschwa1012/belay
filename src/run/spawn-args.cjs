'use strict';
// Argument checks for RunManager.spawn, moved verbatim out of manager.cjs (the 500-line rule, ADR 0030).
// Every refusal here happens before any row is written or any file created.

const fs = require('node:fs');
const L = require('./launch.cjs');
const { fail } = require('./errors.cjs');

// memory_queries: up to 4 situation lines the orchestrator writes for the worker's memory index (each a `when`-shaped task line, at
// most 160 bytes). Returns them trimmed, or [] when none were given.
const QUERIES_MAX = 4, QUERY_BYTES_MAX = 160;
function checkMemoryQueries(list) {
  if (list === null || list === undefined) return [];
  if (!Array.isArray(list) || list.length > QUERIES_MAX) fail('E_ARGS', `spawn memory_queries must be an array of at most ${QUERIES_MAX} task lines`, { field: 'memory_queries' });
  return list.map((q, i) => {
    const t = typeof q === 'string' ? q.replace(/\s+/g, ' ').trim() : '';
    if (!t) fail('E_ARGS', `spawn memory_queries[${i}] must be a non-empty string`, { field: 'memory_queries', index: i });
    if (Buffer.byteLength(t) > QUERY_BYTES_MAX) fail('E_ARGS', `spawn memory_queries[${i}] is ${Buffer.byteLength(t)} bytes and the limit is ${QUERY_BYTES_MAX}; word the task line shorter`, { field: 'memory_queries', index: i, max: QUERY_BYTES_MAX });
    return t;
  });
}

function validateSpawnArgs({ substrate, worktree, prompt, permission_prompt, permit_wait_ms, effort, worker_id, native_memory = null }) {
  if (substrate !== 'claude-code' && substrate !== 'codex') fail('E_ARGS', 'substrate must be claude-code or codex', { substrate });
  if (!worktree) fail('E_ARGS', 'spawn needs a worktree');
  if (typeof prompt !== 'string' || !prompt) fail('E_ARGS', 'spawn needs a prompt');
  if (typeof permission_prompt !== 'boolean') fail('E_ARGS', 'spawn permission_prompt must be a boolean', { permission_prompt });
  if (!Number.isInteger(permit_wait_ms) || permit_wait_ms <= 0) fail('E_ARGS', 'spawn permit_wait_ms must be a positive integer', { permit_wait_ms });
  if (effort !== null && !L.EFFORT_LEVELS.includes(effort)) fail('E_ARGS', `spawn effort must be one of ${L.EFFORT_LEVELS.join(', ')} (ADR 0028)`, { effort });
  if (effort !== null && substrate === 'codex') fail('E_SUBSTRATE', 'codex effort is not measured, so spawn refuses it (ADR 0028 decision 6)', { substrate, effort });
  // ADR 0024 amendment 3 (proposed): the eval-only native-memory folder; a Claude Code launch only, absolute.
  if (native_memory !== null) {
    if (substrate === 'codex') fail('E_SUBSTRATE', 'native_memory is Claude Code auto-memory, and codex has none', { substrate, native_memory });
    // The string form, then the real path (a junction into the config directory), then that the folder is a directory or absent, so a refusal leaves no worker directory and the id free.
    try { require('./native-memory.cjs').checkFolder(native_memory); } catch (e) { fail('E_ARGS', e.message, e.detail); }
  }
  // ADR 0020 decision 1: Codex has no permission channel (approval_policy="never", MCP tools
  // pre-approved, ADR 0001 §1) — refused before any row is written or any file created.
  if (permission_prompt && substrate === 'codex') {
    fail('E_SUBSTRATE', 'codex has no permission channel: codex exec runs under approval_policy="never" with MCP tools pre-approved (ADR 0001 §1)', { substrate, worker_id: worker_id || null });
  }
}

// A spawn that failed while writing the worker's files, before any row or process: forget the record and remove the directory this
// spawn created, so no phantom starting worker is left holding the id. A directory that existed before the spawn is left alone.
function discardUnstarted(workers, w, dirExisted) {
  workers.delete(w.id);
  if (!dirExisted) { try { fs.rmSync(w.dir, { recursive: true, force: true }); } catch { /* the original error is the one to report */ } }
}

module.exports = { discardUnstarted, validateSpawnArgs, checkMemoryQueries, QUERIES_MAX, QUERY_BYTES_MAX };
