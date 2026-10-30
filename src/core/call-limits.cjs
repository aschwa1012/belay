'use strict';
// call-limits.cjs — the bounds a Core call waits under, and the lock re-reads, split out of index.cjs to keep it readable. No
// sqlite, no embedder, nothing that starts a process: index.cjs (and so status.get) loads it.

const { readOwnerLock } = require('./lock.cjs');

const ELECTION_PING_TIMEOUT_MS = 300; // 5a-3: becomeOwner()'s refusal ping
const READ_TIMEOUT_MS = 300;       // api.md §1: the bounded round trip before falling back to a copy
const EMBEDDING_READ_TIMEOUT_MS = 100000; // a call that needs a vector: the first pays a cold load (a load is waited on, never bounded by a fixed 90 s); inside the 120 s MCP tool timeout
const WRITE_TIMEOUT_MS = 30000;
const REPING_BEFORE_LOST_MS = 2000; // E2: a live pid that missed the first ping gets one longer chance (a fork on its loop stalls it 80-365 ms)
const PING_BEFORE_VECTOR_MS = 300; // MF3-1: the liveness ping a vector call sends before waiting its long bound
const EVALUATE_TIMEOUT_MS = 600000; // task.evaluate runs the acceptance commands inside the owner
const RELEASE_EVALUATE_TIMEOUT_MS = 12 * 3600000; // a release evaluation may queue for a slot without bound (max_parallel_evaluations), then runs its own budget
const WORKTREE_TIMEOUT_MS = 300000; // ADR 0053: a checkout of a large tree, its junctions, and the row

// 5a-3 fix round (blocking): owner.json is rewritten non-atomically at the moment a loser's connect
// can succeed, so one un-retried read can return null while the owner is live; a few immediate
// re-reads ride out that sub-ms window at no cost to the common case, where the first read succeeds.
function rereadOwnerPid(dataDir, attempts = 5) {
  for (let i = 0; i < attempts; i++) { const lock = readOwnerLock(dataDir); if (lock && Number.isFinite(lock.pid)) return lock.pid; }
  return null;
}

// 5c-2 design item 3: the same ride-out, but for `control`'s missing-vs-unreadable distinction, which
// needs the lock object itself (not just a pid) once the directory is confirmed present.
function rereadOwnerLock(dataDir, attempts = 5) {
  for (let i = 0; i < attempts; i++) { const lock = readOwnerLock(dataDir); if (lock) return lock; }
  return null;
}

// ADR 0040 §2, routing: a keyword search needs no vector, and a supplied vector needs no embedder, so both take
// the ordinary bound and may fall back to the copy. Semantic and hybrid with no vector wait on the owner's embedder.
function readTimeoutFor(method, params) {
  if (method !== 'memory.search' || params.mode === 'keyword') return READ_TIMEOUT_MS;
  if (params.query_embedding || params.query_embedding_b64) return READ_TIMEOUT_MS;
  return EMBEDDING_READ_TIMEOUT_MS;
}

// memory.warm({ wait }) may be given a longer limit for a cold cache (timeout_ms, at most 600,000 ms).
const warmLimit = params => Math.min(Number.isInteger(params.timeout_ms) && params.timeout_ms > 0 ? params.timeout_ms : EMBEDDING_READ_TIMEOUT_MS, 600000);

// The limit a vector call has, whether it goes over the pipe or runs in this process; 0 for any other call.
function vectorLimit(method, params) {
  if (method === 'memory.warm') return params.wait ? warmLimit(params) : 0;
  const t = method === 'memory.search' ? readTimeoutFor(method, params) : method === 'memory.store' || method === 'lease.release' || method === 'memory.embedQuery' || method === 'memory.embedNote' ? writeTimeoutFor(method, params) : 0;
  return t === EMBEDDING_READ_TIMEOUT_MS ? t : 0;
}

function writeTimeoutFor(method, params) {
  if (method === 'task.evaluate' && params && params.trigger === 'release') return RELEASE_EVALUATE_TIMEOUT_MS;
  if (method === 'task.evaluate' || method === 'integration.merge') return EVALUATE_TIMEOUT_MS; // ADR 0053: a merge re-runs acceptance commands
  if (method === 'task.worktreeCreate' || method === 'task.worktreeRemove' || method === 'task.worktreeSweep' || method === 'integration.remove') return WORKTREE_TIMEOUT_MS;
  if (method === 'memory.embedQuery') return EMBEDDING_READ_TIMEOUT_MS; // one embed of the query, bounded like a search's
  if (method === 'memory.embedNote') return EMBEDDING_READ_TIMEOUT_MS; // one note's embed and its comparison
  if (method === 'memory.store' && params.embed !== false && !params.embedding && !params.embedding_b64) return EMBEDDING_READ_TIMEOUT_MS; // embed: false needs no vector (ADR 0040)
  // ADR 0047: a hand-back carrying notes embeds each one, so it has the vector limit; one without notes does not.
  if (method === 'lease.release' && Array.isArray(params.notes) && params.notes.length) return EMBEDDING_READ_TIMEOUT_MS;
  if (method === 'memory.warm' && params.wait) return warmLimit(params) + 5000; // the engine's own limit, plus the round trip
  // build step 6d: permission.wait's own deadline is the caller's timeout_ms plus a 5,000 ms margin
  // for the round trip itself, so the client never times out before the engine's own bound would.
  if (method === 'permission.wait') return (params.timeout_ms || 25000) + 5000;
  return WRITE_TIMEOUT_MS;
}

// ADR 0033: the only writes Core re-runs after an owner was lost with the call already sent.
// memory.store converges by dedup inside BEGIN IMMEDIATE (ADR 0002 C4); permission.wait writes nothing.
// A method joins only through a decision record that shows it converges.
const RERUN_SAFE_AFTER_SEND = new Set(['memory.store', 'permission.wait']);
const MIN_RERUN_LEFT_MS = 1000; // a memory.store re-run needs at least this much of its first limit left, or it is not re-run

module.exports = { ELECTION_PING_TIMEOUT_MS, READ_TIMEOUT_MS, EMBEDDING_READ_TIMEOUT_MS, WRITE_TIMEOUT_MS, REPING_BEFORE_LOST_MS, PING_BEFORE_VECTOR_MS, EVALUATE_TIMEOUT_MS, RELEASE_EVALUATE_TIMEOUT_MS, rereadOwnerPid, rereadOwnerLock, readTimeoutFor, warmLimit, vectorLimit, writeTimeoutFor, RERUN_SAFE_AFTER_SEND, MIN_RERUN_LEFT_MS };
