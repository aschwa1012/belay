'use strict';
// Argument checks for RunManager.spawn, moved verbatim out of manager.cjs (the 500-line rule, ADR 0030).
// Every refusal here happens before any row is written or any file created.

const fs = require('node:fs');
const path = require('node:path');
const L = require('./launch.cjs');
const { fail } = require('./errors.cjs');
const { isJobId } = require('../core/job-ids.cjs');
const { WORKER_STATES } = require('../core/schema.cjs');
const { isPathId, pathIdMessage } = require('../core/path-id.cjs'); // pure

// A caller-named worker id becomes a directory under the data dir: refused before any file or row is written.
function checkWorkerId(worker_id) {
  if (worker_id !== null && worker_id !== undefined && !isPathId(worker_id)) fail('E_ARGS', `spawn ${pathIdMessage('worker_id', worker_id)}`, { field: 'worker_id' });
}

// memory_queries: up to 4 situation lines the orchestrator writes for the worker's memory index (each a `when`-shaped task line, at
// most 160 bytes). Returns them trimmed, or [] when none were given.
const MQ = require('../core/memory-queries.cjs');
const { QUERIES_MAX, QUERY_BYTES_MAX } = MQ;
const checkMemoryQueries = (list) => MQ.check(list, 'spawn', fail);

// NTFS is case-insensitive, so W1 and w1 share one directory, and another run's row of the same id would be restated. A caller-named id is fresh only when no row in the
// store has it (any state, any run, compared without case) and no directory holds it. A restart, resume or adopt of the same row never comes through spawn.
// A job or knowledge worker's id is the harness's: the model cannot name one (tools.cjs refuses the prefixes), and the harness makes the worker's directory (the corpus, the stage files) before the spawn.
const harnessOwned = (id) => isJobId(id) || id.startsWith('knowledge-');
// One exception: this run's own stopped or dead worker of the exact same id has no live process, and the product re-spawns such an id in place (the row is restated, the directory reused).
// Returns true when it made the id's directory: a fresh named id is reserved the same way a generated one is, so a named spawn and a generated one cannot both take it.
async function checkIdFree(core, dataDir, id, runId) {
  const lower = id.toLowerCase();
  const same = (r) => r.id === id && r.run_id === runId && (r.state === 'stopped' || r.state === 'dead');
  const hits = ((await core.worker.list({ states: WORKER_STATES })).workers || []).filter((r) => String(r.id).toLowerCase() === lower);
  const taken = hits.find((r) => !same(r));
  if (taken) fail('E_ARGS', `worker_id ${JSON.stringify(id)} is taken: the store has a worker row ${JSON.stringify(taken.id)} (run ${taken.run_id}, ${taken.state}); choose another id`, { worker_id: id, existing_id: taken.id, existing_run_id: taken.run_id });
  if (hits.length || harnessOwned(id)) return false;
  const taken_dir = () => fail('E_ARGS', `worker_id ${JSON.stringify(id)} is taken: its worker directory exists with no row; choose another id`, { worker_id: id });
  fs.mkdirSync(path.dirname(L.workerDir(dataDir, id)), { recursive: true });
  try { fs.mkdirSync(L.workerDir(dataDir, id)); } catch (e) { if (e && e.code === 'EEXIST') taken_dir(); throw e; }
  return true;
}

function validateSpawnArgs({ substrate, worktree, prompt, permission_prompt, permit_wait_ms, effort, worker_id, native_memory = null, task_id = null }) {
  checkWorkerId(worker_id);
  if (substrate !== 'claude-code' && substrate !== 'codex') fail('E_ARGS', 'substrate must be claude-code or codex', { substrate });
  if (!worktree) fail('E_ARGS', 'spawn needs a worktree');
  if (task_id ? prompt != null && typeof prompt !== 'string' : typeof prompt !== 'string' || !prompt) fail('E_ARGS', 'spawn needs a prompt (optional only with a task_id: belay sends the task\'s spec)');
  if (typeof permission_prompt !== 'boolean') fail('E_ARGS', 'spawn permission_prompt must be a boolean', { permission_prompt });
  if (!Number.isInteger(permit_wait_ms) || permit_wait_ms <= 0) fail('E_ARGS', 'spawn permit_wait_ms must be a positive integer', { permit_wait_ms });
  if (effort !== null && substrate === 'codex') { try { require('./codex-surface.cjs').checkEffort(effort); } catch (e) { fail('E_ARGS', e.message, e.detail); } } // a Codex level is from Codex's enum
  else if (effort !== null && !L.EFFORT_LEVELS.includes(effort)) fail('E_ARGS', `spawn effort must be one of ${L.EFFORT_LEVELS.join(', ')}`, { effort });
  // ADR 0024 amendment 3 (proposed): the eval-only native-memory folder; a Claude Code launch only, absolute.
  if (native_memory !== null) {
    if (substrate === 'codex') fail('E_SUBSTRATE', 'native_memory is Claude Code auto-memory, and codex has none', { substrate, native_memory });
    // The string form, then the real path (a junction into the config directory), then that the folder is a directory or absent, so a refusal leaves no worker directory and the id free.
    try { require('./native-memory.cjs').checkFolder(native_memory); } catch (e) { fail('E_ARGS', e.message, e.detail); }
  }
  // ADR 0020 decision 1: Codex has no permission channel (approval_policy="never", MCP tools
  // pre-approved, ADR 0001 §1) — refused before any row is written or any file created.
  if (permission_prompt && substrate === 'codex') {
    fail('E_SUBSTRATE', 'codex has no permission channel: codex exec runs under approval_policy="never" with MCP tools pre-approved', { substrate, worker_id: worker_id || null });
  }
}

// A spawn that failed before any process: while writing the worker's files (no row yet), or when a pause refused its assignment (the
// `starting` row is then written dead first). Forget the record and remove the directory this spawn created, so no phantom starting
// worker is left in the manager. A directory that existed before the spawn is left alone.
// The record's base-sha lookup (a git child with the worktree as its cwd) is awaited first: forgetting the record would take it off
// shutdown's drain list, and the run must not end with that child still running.
async function discardUnstarted(workers, w, dirExisted) {
  if (w.basePromise) await w.basePromise.catch(() => {});
  workers.delete(w.id);
  if (!dirExisted) { try { fs.rmSync(w.dir, { recursive: true, force: true }); } catch { /* the original error is the one to report */ } }
}

// The id a spawn gets when the caller names none: `<agent type or worker>-<n>`, n the lowest number no worker row (any run, any state, compared without case),
// no live record of this run and no worker directory holds. Ids are one namespace per data dir (the directory and the row key), so the number is store-wide, not per
// run. The directory is made here, atomically (a plain mkdir fails when it exists): two spawns, in this process or in another run's, can never take one number.
// The caller owns the empty directory it returns and removes it if the spawn fails before a row exists. A process that dies between the mkdir and the row leaves
// the empty directory, and that number is skipped from then on (the directory holds it); nothing else is lost.
async function freshWorkerId(core, dataDir, agentType, takenHere) {
  const prefix = agentType || 'worker';
  const used = new Set(((await core.worker.list({ states: WORKER_STATES })).workers || []).map((r) => String(r.id).toLowerCase()));
  fs.mkdirSync(path.dirname(L.workerDir(dataDir, prefix)), { recursive: true });
  for (let n = 1; ; n++) {
    const id = `${prefix}-${n}`;
    if (used.has(id) || takenHere(id)) continue;
    try { fs.mkdirSync(L.workerDir(dataDir, id)); } catch (e) { if (e && e.code === 'EEXIST') continue; throw e; }
    return id;
  }
}

module.exports = { freshWorkerId, checkWorkerId, checkIdFree, discardUnstarted, validateSpawnArgs, checkMemoryQueries, QUERIES_MAX, QUERY_BYTES_MAX };
