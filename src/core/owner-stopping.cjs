'use strict';
// owner-stopping.cjs — what a write does after an owner refused it, before it re-runs (ADR 0033): wait out a stopping owner,
// and charge that wait to memory.store's limit. Moved out of index.cjs unchanged.

const { err } = require('./errors.cjs');
const { readOwnerLock, waitOwnerGone } = require('./lock.cjs');
const { MIN_RERUN_LEFT_MS } = require('./call-limits.cjs');

const STOP_WAIT_MS = 15000; // how long a refused write waits for the stopping owner to finish

// A stopping owner keeps its pipe open until its teardown ends, so a dial now would reach it again. Wait for the owner that
// refused (its pid and token ride on the refusal), never for whoever holds the lock after it.
async function awaitStopping(dataDir, method, e) {
  const d = e.detail || {};
  if (!d.owner_stopping) return;
  const held = d.owner_pid ? { pid: d.owner_pid, token: d.owner_token } : readOwnerLock(dataDir);
  if (held && !(await waitOwnerGone(dataDir, held, STOP_WAIT_MS))) {
    throw err('E_OWNER_LOST', `the store owner was still stopping after ${STOP_WAIT_MS} ms, so ${method} was not run and was not re-run`, { method, sent: false, rerun: 'skipped', owner_stopping: true, waited_ms: STOP_WAIT_MS });
  }
}

// memory.store: both attempts share one limit. What is left of it for the re-run, or the refusal when too little is; undefined for
// any other method.
function rerunLeft(method, notSent, timeoutMs, t0) {
  if (method !== 'memory.store') return undefined;
  const left = timeoutMs - (Date.now() - t0);
  if (left < MIN_RERUN_LEFT_MS) {
    if (notSent) throw err('E_OWNER_LOST', `the owner was lost before ${method} was sent and too little of its limit was left to re-run it`, { method, sent: false, rerun: 'skipped', left_ms: left });
    throw err('E_OWNER_LOST', `the owner was lost after ${method} was sent; too little of its limit was left to re-run it, so re-read before retrying`, { method, sent: true, may_have_committed: true, outcome: 'unknown', rerun: 'skipped', left_ms: left });
  }
  return left;
}

module.exports = { awaitStopping, rerunLeft, STOP_WAIT_MS };
