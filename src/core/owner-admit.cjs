'use strict';
// owner-admit.cjs — who is calling, settled before a request reaches a method (ADR 0045 decisions 2 and 3), and the owner's bind
// verbs. Split from owner.cjs to keep that file under its line budget; each function takes the owner it serves.

const { METHODS } = require('./engine.cjs');
const { err } = require('./errors.cjs');

// ADR 0045 decisions 2 and 3: who is calling, settled before the request reaches a method. Returns null (admitted, with
// req.params.caller now the identity belay established), a refusal, or a promise of either. The request's own `caller`
// is never what a keyed call runs as; it supplies only a pid (for retirement's liveness check) and a channel request.
function admit(owner, c, req) {
  if (!req.params || typeof req.params !== 'object') req.params = {};
  const params = req.params;
  const sent = params.caller && typeof params.caller === 'object' ? params.caller : {};
  if (req.key !== undefined) {
    const entry = owner.binds.lookup(req.key);
    if (!entry) return { code: 'E_UNBOUND', message: 'the request carried a key this owner does not hold (revoked, expired with its owner, or issued by another); a role is taken from a bound process, never from a request', detail: { reason: 'key', method: req.method } };
    const caller = { ...entry.identity };
    if (Number.isInteger(sent.pid)) caller.pid = sent.pid;
    if (sent.channel === 'tool') caller.channel = 'tool';
    else if (sent.channel === 'harness') {
      // Only an orchestrator's bind admits the harness channel (the run manager); a worker's admits neither it nor any other role.
      if (entry.identity.role !== 'orchestrator') return { code: 'E_UNBOUND', message: `a ${entry.identity.role} bind does not admit the harness channel`, detail: { reason: 'channel', method: req.method, role: entry.identity.role } };
      caller.channel = 'harness';
    }
    params.caller = caller;
    c.belayVia = 'bound';
    c.belayBindId = entry.id;
    return null;
  }
  // bound mode, no key from here on
  if (req.method === 'ping') {
    // a keyless operator on the loopback port asks to be checked now (client.cjs _verifyOperator), so the check's cost is not its first call's
    if (params.verify_operator === true && sent.role === 'operator' && c.belayTransport === 'tcp' && typeof owner.opts.operatorCheck === 'function') {
      return Promise.resolve(owner.opts.operatorCheck({ conn: c, caller: sent, method: 'ping' })).then((v) => { c.belayVerified = !!(v && v.ok === true); return null; }, () => null);
    }
    return null;
  }
  const spec = METHODS[req.method];
  // A read open to every role is served to an unverified caller as `anonymous`: a worker-shaped caller no worker owns. The run id the
  // request names rides along as a selector (a read with no id asks for "the caller's run"); it grants nothing, since these reads are
  // open to every role. A read restricted to the orchestrator or the operator is not open: it takes the operator check below.
  const open = !!spec && spec.kind === 'read' && Array.isArray(spec.roles) && spec.roles.includes('worker');
  const anonymous = () => {
    params.caller = { role: 'worker', run_id: typeof sent.run_id === 'string' && sent.run_id ? sent.run_id : 'anonymous', worker_id: 'anonymous', ...(Number.isInteger(sent.pid) ? { pid: sent.pid } : {}) };
    c.belayVia = 'anonymous';
    return null;
  };
  const refuse = (reason, message) => ({ code: 'E_UNBOUND', message, detail: { reason, method: req.method, role: sent.role === undefined ? null : sent.role } });
  const checks = sent.role === 'operator' && typeof owner.opts.operatorCheck === 'function' && c.belayTransport === 'tcp';
  // The operator's own reads (a search of another run's namespace) need the operator, so a claim on the loopback port is checked first;
  // a refused claim on an open read falls back to anonymous rather than to a refusal, which is all an unverified caller could have had.
  // An unverified claim on an open read is not checked here: the check costs a second and two host tools, and an open read needs none
  // of it. The client asks for the check (a ping with verify_operator) when a call needs the operator; a verified connection is served as one.
  if (open && (!checks || !c.belayPeer)) return anonymous();
  if (sent.role !== 'operator') return refuse('unbound', `${req.method} needs a bound caller on this owner (it serves bound callers): a role is taken from a bound process or from the operator check, never from a request`);
  if (typeof owner.opts.operatorCheck !== 'function') return refuse('unverifiable', `${req.method} claims the operator, and this owner has no check that can vouch for a pipe client, so it fails closed`);
  return Promise.resolve(owner.opts.operatorCheck({ conn: c, caller: sent, method: req.method })).then((v) => {
    if (!v || v.ok !== true) return open ? anonymous() : refuse('operator_check', `${req.method}: the operator check refused this connection${v && v.reason ? ` (${v.reason})` : ''}`);
    c.belayVia = v.via || 'peer';
    const { peer_pid: forged, ...rest } = sent; // the checked peer's pid is the owner's finding, never the request's
    params.caller = { ...rest, role: 'operator', ...(v.peer && Number.isInteger(v.peer.pid) ? { peer_pid: v.peer.pid } : {}) };
    return null;
  });
}

// ADR 0045 decision 2: open, read or revoke a bind. The operator (the run process, or an owner's own in-process call) may bind
// an orchestrator or a worker; an orchestrator, a worker of its own run and nothing else; no other role may touch a bind. `caller`
// is the bound identity on a keyed request, the believed one on a claimed owner (the limit ADR 0012 decision 3 states).
async function bindCall(owner, method, params, caller) {
  const role = caller && caller.role;
  if (role !== 'operator' && role !== 'orchestrator') {
    throw err('E_ROLE', `${method} is available to operator and orchestrator, and this call came from role ${JSON.stringify(role === undefined ? null : role)}`, { method, role: role === undefined ? null : role, allowed: ['operator', 'orchestrator'] });
  }
  const ownRun = (runId) => role === 'operator' || runId === caller.run_id;
  if (method === 'bind.open') {
    const want = params.identity || {};
    if (role === 'orchestrator' && !(want.role === 'worker' && want.run_id === caller.run_id)) {
      throw err('E_ROLE', 'an orchestrator may open a bind only for a worker of its own run', { method, requested: { role: want.role === undefined ? null : want.role, run_id: want.run_id === undefined ? null : want.run_id }, run_id: caller.run_id });
    }
    if (params.no_expiry !== undefined && params.no_expiry !== true) throw err('E_ARGS', 'bind.open no_expiry is true or absent', { field: 'no_expiry' });
    if (params.no_expiry === true && role !== 'operator') throw err('E_ROLE', 'a bind that does not expire is opened by the operator (the run process) only', { method, role });
    const r = await owner.binds.open(want, { openedBy: role === 'operator' ? 'operator' : `orchestrator:${caller.run_id}`, noExpiry: params.no_expiry === true });
    return { bind_id: r.id, pipe: r.name, caller: r.caller, expires_in_ms: r.expires_in_ms };
  }
  const bindId = params.bind_id;
  const who = typeof bindId === 'string' ? owner.binds.peek(bindId) : null;
  if (!who) throw err('E_NOT_FOUND', `no bind ${JSON.stringify(bindId === undefined ? null : bindId)}`, { method, bind_id: bindId === undefined ? null : bindId });
  if (!ownRun(who.run_id)) throw err('E_ROLE', `${method}: that bind belongs to another run`, { method, bind_id: bindId });
  return method === 'bind.status' ? owner.binds.status(bindId) : owner.binds.revoke(bindId);
}

module.exports = { admit, bindCall };
