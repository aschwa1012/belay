'use strict';
// bind.cjs — ADR 0045 decision 2: a spawned adapter is bound, not believed. The owner opens a one-shot pipe for an identity
// the spawner named ({ role, run_id, worker_id? }); the adapter dials it before it answers MCP `initialize` and is handed a
// fresh 256-bit session key and that identity; from then on the owner takes the caller of every keyed request from the bind
// and ignores whatever the request says. The pipe accepts exactly one connection, then its listener closes.
//
// What a bind is: ordering plus a secret held in the adapter's memory. The key never touches a file, the environment, a log or
// argv. What it is not: a boundary against a same-user process that reads that memory or writes store.db directly (ADR 0045
// "What this does not stop"). The registry holds nothing durable: an owner that dies takes its keys with it, and the adapters
// that held them fail E_UNBOUND on their next call, never a quiet fall back to a claim.

const net = require('node:net');
const crypto = require('node:crypto');
const { err } = require('./errors.cjs');
const { bindPipeName } = require('./lock.cjs');

const BIND_TTL_MS = 60000; // an unclaimed bind closes after this long; the spawner opens a new one for a new launch

function identityOf(raw) {
  const r = raw || {};
  if (r.role !== 'orchestrator' && r.role !== 'worker') throw err('E_ARGS', `a bind is for an orchestrator or a worker, and this one named ${JSON.stringify(r.role)}`, { field: 'role' });
  if (typeof r.run_id !== 'string' || !r.run_id) throw err('E_ARGS', 'a bind needs the run id the process is launched with', { field: 'run_id' });
  if (r.role === 'worker' && (typeof r.worker_id !== 'string' || !r.worker_id)) throw err('E_ARGS', 'a worker bind needs the worker id the process is launched with', { field: 'worker_id' });
  if (r.role === 'orchestrator' && r.worker_id !== undefined && r.worker_id !== null) throw err('E_ARGS', 'an orchestrator bind carries no worker id', { field: 'worker_id' });
  return Object.freeze({ role: r.role, run_id: r.run_id, ...(r.role === 'worker' ? { worker_id: r.worker_id } : {}) });
}

class BindRegistry {
  constructor(dataDir, { ttlMs = BIND_TTL_MS } = {}) {
    this.dataDir = dataDir;
    this.ttlMs = ttlMs;
    this.byId = new Map(); // id -> { id, identity, state, key, server, timer, opened_by }
    this.byKey = new Map(); // key -> id
  }

  // Resolves once the one-shot pipe is listening, so the name handed back can be dialled at once.
  // `noExpiry`: the bind waits for its claimant as long as the owner lives (an interactive orchestrator, whose MCP server Claude Code
  // starts only after the human answers the trust dialog). It is still single use, and the owner revokes it on stop.
  open(rawIdentity, { openedBy = null, noExpiry = false } = {}) {
    const identity = identityOf(rawIdentity);
    const id = crypto.randomBytes(8).toString('hex');
    const name = bindPipeName(this.dataDir, crypto.randomBytes(16).toString('hex'));
    const entry = { id, identity, state: 'open', key: null, server: null, timer: null, opened_by: openedBy, name };
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => {
        if (entry.state !== 'open') { sock.destroy(); return; }
        entry.state = 'claimed';
        entry.key = crypto.randomBytes(32).toString('hex');
        entry.claimedAt = Date.now();
        this.byKey.set(entry.key, id);
        clearTimeout(entry.timer);
        sock.on('error', () => { /* the adapter went away; the bind stays claimed and is revoked by its spawner */ });
        sock.end(JSON.stringify({ bind_id: id, key: entry.key, caller: identity }) + '\n');
        server.close(); // exactly one connection: a second dial finds no listener
      });
      entry.server = server;
      server.once('error', reject);
      server.listen(name, () => {
        server.removeListener('error', reject);
        server.on('error', () => { /* a listener that fails after listening cannot be repaired; the spawner sees an unclaimed bind */ });
        if (server.unref) server.unref(); // an unclaimed bind never keeps a process alive; its owner's own server does that
        if (!noExpiry) {
          entry.timer = setTimeout(() => { if (entry.state === 'open') this._end(entry, 'expired'); }, this.ttlMs);
          if (entry.timer.unref) entry.timer.unref();
        }
        this.byId.set(id, entry);
        resolve({ id, name, caller: identity, expires_in_ms: noExpiry ? null : this.ttlMs });
      });
    });
  }

  _end(entry, state) {
    entry.state = state;
    clearTimeout(entry.timer);
    if (entry.key) this.byKey.delete(entry.key);
    entry.key = null;
    try { entry.server.close(); } catch { /* already closed */ }
  }

  // The answer to "was the bind claimed": a fact of this registry, never the adapter's word.
  status(id) {
    const e = this.byId.get(id);
    if (!e) throw err('E_NOT_FOUND', `no bind ${id}`, { bind_id: id });
    return { bind_id: id, state: e.state, claimed: e.state === 'claimed', caller: e.identity, opened_by: e.opened_by };
  }

  // Idempotent on a revoked bind; the receipt names the state it ended from.
  revoke(id) {
    const e = this.byId.get(id);
    if (!e) throw err('E_NOT_FOUND', `no bind ${id}`, { bind_id: id });
    const was = e.state;
    if (was === 'open' || was === 'claimed') this._end(e, 'revoked');
    return { bind_id: id, was, state: e.state, caller: e.identity };
  }

  lookup(key) {
    if (typeof key !== 'string') return null;
    const id = this.byKey.get(key);
    const e = id ? this.byId.get(id) : null;
    return e && e.state === 'claimed' ? e : null;
  }

  openedBy(id) { const e = this.byId.get(id); return e ? e.opened_by : null; }

  // The identity a bind was opened for, whatever its state, or null: the gate on who may read or revoke it.
  peek(id) { const e = this.byId.get(id); return e ? e.identity : null; }

  close() { for (const e of this.byId.values()) if (e.state === 'open' || e.state === 'claimed') this._end(e, 'revoked'); }
}

// The adapter's side: dial the bind pipe once, read the line, return { bind_id, key, caller }. Rejects E_BIND on a missing
// listener, a closed pipe with no line, or the timeout; the caller exits before it answers `initialize` (fail closed).
function claimBind(name, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const fail = (why, detail) => { try { sock.destroy(); } catch { /* gone */ } reject(err('E_BIND', `the bind at ${name} could not be claimed: ${why}`, { pipe: name, ...detail })); };
    const sock = net.connect(name);
    let buf = '';
    const timer = setTimeout(() => fail(`no answer in ${timeoutMs} ms`, { timeout_ms: timeoutMs }), timeoutMs);
    timer.unref();
    sock.on('error', (e) => { clearTimeout(timer); fail(e.message, { raw_code: e.code || null }); });
    sock.on('data', (d) => { buf += d.toString('utf8'); });
    sock.on('end', () => {
      clearTimeout(timer);
      let msg;
      try { msg = JSON.parse(buf.trim()); } catch { return fail('the owner sent no usable line'); }
      if (!msg || typeof msg.key !== 'string' || !msg.caller) return fail('the owner sent no key');
      resolve(msg);
    });
  });
}

// The adapter's cross-check: the identity the owner handed back must be the one its own argv names, on all three fields. Argv alone
// keeps role and worker id together (an orchestrator takes no worker id), so a role mismatch implies a worker-id mismatch there; the
// clauses are still each checked, so a change to argv cannot loosen this one.
function identityMatchesArgv(caller, { role, runId, workerId }) {
  const c = caller || {};
  return c.role === role && c.run_id === runId && (c.worker_id || null) === (workerId || null);
}

module.exports = { BindRegistry, claimBind, identityOf, identityMatchesArgv, BIND_TTL_MS };
