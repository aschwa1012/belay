'use strict';
// methods-permission.cjs — build step 6d, design item 2,
// ADR 0020 decision 2. The permission table's four methods: request (a worker's pending row), list (a
// read, all roles), decide (operator/orchestrator allow|deny, a worker's own expire) and wait (a
// worker's own row, served only by the live owner through the engine's in-process waiters, api.md §1's
// new `wait` kind). Rows supersede, never mutate (api.md §1): decide and the adapter's own bound both
// append a verdict row rather than updating the request row in place.

const crypto = require('node:crypto');
const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const { pidAlive } = require('./lock.cjs');
const { PERMISSION_STATES } = require('./schema.cjs');

const MAX_INPUT_BYTES = 8192;

function currentOf(E, id) {
  return rows.current(E.store, 'permission', id);
}

function decorateRequest(row, now = Date.now()) {
  return { ...row, adapter_alive: pidAlive(row.adapter_pid), age_ms: now - row.requested_at };
}

// permission.request({ id, tool, input }) — worker only. Identity (worker_id, run_id, adapter_pid)
// comes from the caller the engine substituted, never from the arguments: an argument named
// worker_id, run_id or adapter_pid here is silently ignored, exactly as api.md §1 promises for every
// write. The input is capped at 8,192 bytes with a sha256 over the full text taken before the cut.
async function request(E, caller, args) {
  if (typeof args.id !== 'string' || !args.id) throw err('E_ARGS', 'permission.request needs id, the substrate\'s tool_use_id');
  if (typeof args.tool !== 'string' || !args.tool) throw err('E_ARGS', 'permission.request needs tool, the name the substrate is calling');
  if (currentOf(E, args.id)) throw err('E_ARGS', `a permission row with id ${args.id} already exists`, { id: args.id });

  const full = JSON.stringify(args.input === undefined ? null : args.input);
  const input_sha256 = crypto.createHash('sha256').update(full).digest('hex');
  const truncated = Buffer.byteLength(full, 'utf8') > MAX_INPUT_BYTES;
  const input = truncated ? Buffer.from(full, 'utf8').slice(0, MAX_INPUT_BYTES).toString('utf8') : full;

  const t = Date.now();
  const row = rows.append(E.store, 'permission', {
    id: args.id, run_id: caller.run_id, worker_id: caller.worker_id, adapter_pid: caller.pid,
    tool: args.tool, input, input_truncated: truncated ? 1 : 0, input_sha256,
    state: 'pending', verdict_by: null, reason: null, requested_at: t, decided_at: null,
  }, E.writtenBy(caller), t);
  E.noteWrite();
  return row;
}

// permission.list({ run_id?, states? = ['pending'] }) — all roles, a read: never writes, never touches
// the engine's waiters.
async function list(E, caller, args) {
  const states = args.states === undefined ? ['pending'] : args.states;
  if (!Array.isArray(states) || !states.length) throw err('E_ARGS', 'permission.list states must be a non-empty array');
  for (const s of states) {
    if (!PERMISSION_STATES.includes(s)) throw err('E_ARGS', `permission.list states named ${JSON.stringify(s)}, and must be one of ${PERMISSION_STATES.join(', ')}`);
  }
  const set = new Set(states);
  const now = Date.now();
  const all = rows.currentAll(E.store, 'permission')
    .filter((r) => (args.run_id ? r.run_id === args.run_id : true))
    .filter((r) => set.has(r.state))
    .sort((a, b) => a.requested_at - b.requested_at)
    .map((r) => decorateRequest(r, now));
  return { requests: all };
}

const VERDICT_TO_STATE = { allow: 'allowed', deny: 'denied', expire: 'expired' };

// permission.decide({ id, verdict, reason? }) — operator/orchestrator may allow or deny; a worker may
// only expire its own row. The role rule is checked before the row is even read (ADR 0020 decision 2).
function checkRole(caller, verdict, row) {
  if (caller.role === 'worker') {
    if (verdict !== 'expire') {
      throw err('E_ROLE', `a worker may only expire its own permission row, and this call asked to ${verdict}`, { verdict, role: caller.role, allowed: ['expire'] });
    }
    if (row && row.worker_id !== caller.worker_id) {
      throw err('E_ROLE', `a worker may only expire its own permission row; ${row.id} belongs to worker ${row.worker_id}`, { verdict, role: caller.role, worker_id: row.worker_id });
    }
    return;
  }
  if (verdict === 'expire') {
    throw err('E_ROLE', `${caller.role} may allow or deny a permission row, and only the adapter's own bound may expire one`, { verdict, role: caller.role, allowed: ['allow', 'deny'] });
  }
}

async function decide(E, caller, args) {
  const verdict = args.verdict;
  if (!['allow', 'deny', 'expire'].includes(verdict)) {
    throw err('E_ARGS', `permission.decide verdict must be allow, deny or expire, and this call carried ${JSON.stringify(verdict)}`);
  }
  if (typeof args.id !== 'string' || !args.id) throw err('E_ARGS', 'permission.decide needs id');
  // The role rule runs before the row is even read for a worker with no such row (api.md: the rule
  // itself does not need the row to reject an allow/deny from a worker), but a worker's own-row check
  // needs the row, so that half of the rule runs once the row is in hand, inside the transaction below.
  if (caller.role !== 'worker') checkRole(caller, verdict, null);

  const { request: reqRow, verdictRow } = E.store.tx(() => {
    const current = currentOf(E, args.id);
    if (!current) throw err('E_NOT_FOUND', `no permission row with id ${args.id}`, { id: args.id });
    if (caller.role === 'worker') checkRole(caller, verdict, current);
    if (current.state !== 'pending') {
      throw err('E_ARGS', `permission row ${args.id} is already ${current.state}, not pending`, { id: args.id, state: current.state, seq: current.seq });
    }
    const t = Date.now();
    const verdict_by = verdict === 'expire' ? `adapter-bound:${caller.pid}` : `${caller.role}:${caller.pid}`;
    const row = rows.append(E.store, 'permission', {
      ...current, state: VERDICT_TO_STATE[verdict], verdict_by,
      reason: args.reason == null ? null : String(args.reason), decided_at: t,
    }, E.writtenBy(caller), t);
    return { request: current, verdictRow: row };
  });
  E.noteWrite();
  // Only the live owner ever has waiters to resolve; a copy's engine has none (its `waiters` map is
  // freshly constructed and empty), so this call is harmless there too.
  E.resolveWaiters(args.id, verdictRow);
  return { request: reqRow, verdict: verdictRow, adapter_pid_alive: pidAlive(reqRow.adapter_pid) };
}

// permission.wait({ id, timeout_ms = 25000 }) — worker only, kind 'wait' (engine.cjs). Dispatched
// through the write path (index.cjs), so it only ever runs inside the live owner's engine: a copy
// asked to wait would have no way to be woken, and E_NO_OWNER (having created nothing) is the honest
// answer for a worker with no owner to ask.
async function wait(E, caller, args) {
  const timeout_ms = args.timeout_ms === undefined ? 25000 : args.timeout_ms;
  if (!Number.isInteger(timeout_ms) || timeout_ms < 1 || timeout_ms > 25000) {
    throw err('E_ARGS', 'permission.wait timeout_ms must be an integer from 1 to 25000', { timeout_ms });
  }
  if (typeof args.id !== 'string' || !args.id) throw err('E_ARGS', 'permission.wait needs id');
  const current = currentOf(E, args.id);
  if (!current) throw err('E_NOT_FOUND', `no permission row with id ${args.id}`, { id: args.id });
  if (current.worker_id !== caller.worker_id) {
    throw err('E_ROLE', `permission row ${args.id} belongs to worker ${current.worker_id}, not ${caller.worker_id}`, { id: args.id, worker_id: current.worker_id });
  }
  if (current.state !== 'pending') {
    return { request: current, timed_out: false, already: true, waited_ms: 0 };
  }
  const t0 = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); E.removeWaiter(args.id, resolve_); resolve(v); };
    // engine.cjs's resolveWaiters calls this with the verdict row; settleWaiters (the owner stopping)
    // calls it with null, because no verdict was ever written for this id.
    const resolve_ = (verdictRow) => (verdictRow === null
      ? finish({ request: null, timed_out: true, already: false, waited_ms: Date.now() - t0, settled_by: 'owner stopping' })
      : finish({ request: verdictRow, timed_out: false, already: false, waited_ms: Date.now() - t0 }));
    const timer = setTimeout(() => {
      const row = currentOf(E, args.id) || current;
      finish({ request: row, timed_out: true, already: false, waited_ms: Date.now() - t0 });
    }, timeout_ms);
    if (timer.unref) timer.unref();
    E.addWaiter(args.id, resolve_);
  });
}

module.exports = { request, list, decide, wait };
