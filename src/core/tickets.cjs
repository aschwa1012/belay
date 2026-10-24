'use strict';
// tickets.cjs — ADR 0045 decision 5: a worker adapter's control pipe acts only on an owner-issued ticket. The operator (the CLI, after
// the owner's operator check on a bound owner) asks the owner for a ticket naming { run_id, worker_id, verb }; the adapter redeems it
// with the owner over its own connection before it acts. A ticket is single use, lives 30 s, and is held only in the owner's memory,
// so it never outlives the owner that issued it. A same-user process that dials the pipe with no ticket, a used one, an expired one or
// one for another worker, verb or run is refused `E_ROLE` with `reason: 'ticket'`.
//
// What it rests on: on a bound owner, only a caller the operator check vouches for is the operator; on a claimed owner the role is
// believed, as it is for every other call there (ADR 0045 "What this does not stop").

const crypto = require('node:crypto');
const { err } = require('./errors.cjs');

const TTL_MS = 30000;
const MAX_LIVE = 1000;
const VERBS = Object.freeze(['message', 'stop', 'restart', 'pause', 'resume']);
const str = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;

function createTickets({ now = Date.now, ttlMs = TTL_MS } = {}) {
  const live = new Map();
  const prune = (t) => { for (const [k, v] of live) if (v.expires_at <= t) live.delete(k); };

  function issue(caller, params) {
    const role = caller && caller.role;
    if (role !== 'operator') throw err('E_ROLE', `ticket.issue is available to operator, and this call came from role ${JSON.stringify(role === undefined ? null : role)}`, { method: 'ticket.issue', role: role === undefined ? null : role, allowed: ['operator'] });
    const { run_id, worker_id, verb } = params || {};
    if (!str(run_id) || !str(worker_id)) throw err('E_ARGS', 'ticket.issue needs run_id and worker_id as strings', { method: 'ticket.issue' });
    if (!VERBS.includes(verb)) throw err('E_ARGS', `ticket.issue verb must be one of ${VERBS.join(', ')}`, { method: 'ticket.issue', verb: verb === undefined ? null : verb });
    const t = now();
    prune(t);
    if (live.size >= MAX_LIVE) throw err('E_BUSY', `ticket.issue: ${MAX_LIVE} tickets are live; retry once some expire`, { method: 'ticket.issue', live: live.size });
    const ticket = crypto.randomBytes(24).toString('hex');
    const by = Number.isInteger(caller.peer_pid) ? caller.peer_pid : Number.isInteger(caller.pid) ? caller.pid : null;
    live.set(ticket, { run_id, worker_id, verb, issued_at: t, expires_at: t + ttlMs, issued_to: by });
    return { ticket, run_id, worker_id, verb, expires_in_ms: ttlMs };
  }

  // Consumed on the first redeem whatever the outcome, so a guessed or stolen ticket cannot be tried against a second worker or verb.
  function redeem(caller, params) {
    const role = caller && caller.role;
    if (role !== 'orchestrator') throw err('E_ROLE', `ticket.redeem is available to orchestrator (the adapter that serves the control pipe), and this call came from role ${JSON.stringify(role === undefined ? null : role)}`, { method: 'ticket.redeem', role: role === undefined ? null : role, allowed: ['orchestrator'] });
    const { ticket, worker_id, verb } = params || {};
    const refuse = (why, extra = {}) => err('E_ROLE', `the control pipe needs an owner-issued ticket for this worker and verb: ${why}`, { reason: 'ticket', worker_id: worker_id === undefined ? null : worker_id, verb: verb === undefined ? null : verb, ...extra });
    if (!str(ticket)) throw refuse('the request carried none');
    const entry = live.get(ticket);
    live.delete(ticket);
    const t = now();
    if (!entry) throw refuse('it is unknown (the owner may have restarted since it was issued) or already used');
    if (entry.expires_at <= t) throw refuse(`it expired ${t - entry.expires_at} ms ago`);
    if (entry.run_id !== caller.run_id) throw refuse(`it was issued for run ${entry.run_id}, and this adapter serves run ${caller.run_id}`);
    if (entry.worker_id !== worker_id || entry.verb !== verb) throw refuse(`it was issued for ${entry.verb} of ${entry.worker_id}`);
    return { redeemed: true, run_id: entry.run_id, worker_id, verb, issued_to: entry.issued_to, age_ms: t - entry.issued_at };
  }

  return { issue, redeem, size: () => live.size };
}

module.exports = { createTickets, TTL_MS, VERBS };
