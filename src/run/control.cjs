'use strict';
// control.cjs — build step 6c, design item 1, ADR 0019
// decisions 2-5 and amendment 1, extended by build step 6e (ADR 0023 decision 4) with worker.pause and
// worker.resume. The worker adapter's own pipe: opened when the RunManager is created, closed with it,
// serving exactly five methods (worker.message, worker.stop, worker.restart, worker.pause,
// worker.resume) as direct calls of the manager method of the same name, answering with that method's
// own receipt or error verbatim. NDJSON framing copied from src/core/owner.cjs's `_conn` (MAX_LINE_BYTES
// 1 MiB, a peer that overflows it destroyed).

const net = require('node:net');
const fs = require('node:fs');
const { adapterPipeName } = require('../core/lock.cjs');

const MAX_LINE_BYTES = 1024 * 1024;
const METHODS = ['worker.message', 'worker.stop', 'worker.restart', 'worker.pause', 'worker.resume'];

// `redeem` (ADR 0045 decision 5): ({ ticket, worker_id, verb }) => a promise that rejects unless the owner redeems that ticket; the
// adapter passes its core's ticketRedeem. `null` serves without tickets (tests that drive the manager directly); there is no default,
// so a control that forgot it cannot be created.
function createWorkerControl({ dataDir, manager, pid = process.pid, redeem }) {
  if (redeem !== null && typeof redeem !== 'function') throw Object.assign(new Error('createWorkerControl needs redeem: the ticket check, or null to serve without one'), { code: 'E_ARGS' });
  const pipe = adapterPipeName(dataDir, pid);
  let server = null;
  const conns = new Set();
  const inFlight = new Set();

  // One reply write, tracked so `close()` can wait for it to flush before tearing down the server.
  function write(c, payload) {
    const p = new Promise((resolve) => { if (c.destroyed) resolve(); else c.write(payload, resolve); });
    inFlight.add(p);
    p.then(() => inFlight.delete(p));
    return p;
  }

  // Dispatch, in this order (design item 1): not-JSON -> E_ARGS id:null; caller.role !== 'operator' ->
  // E_ROLE naming the method, the role sent, allowed: ['operator']; a method other than the five ->
  // E_NOT_FOUND naming the method and detail.methods; otherwise manager[method] with caller stripped,
  // its resolved receipt or rejected error written back verbatim. No ping, nothing that touches the
  // store. build step 6e, ADR 0023 decision 4: worker.pause and worker.resume take `by` from the
  // request's own caller, never from the arguments (the caller names itself on the pipe).
  function dispatch(c, line) {
    let req;
    try { req = JSON.parse(line); }
    catch {
      write(c, JSON.stringify({ id: null, error: { code: 'E_ARGS', message: 'the request line was not valid JSON' } }) + '\n');
      return;
    }
    const role = req.params && req.params.caller && req.params.caller.role;
    if (role !== 'operator') {
      write(c, JSON.stringify({
        id: req.id,
        error: {
          code: 'E_ROLE',
          message: `${req.method} is available to operator and this call came from role ${JSON.stringify(role === undefined ? null : role)}`,
          detail: { method: req.method, role: role === undefined ? null : role, allowed: ['operator'] },
        },
      }) + '\n');
      return;
    }
    if (!METHODS.includes(req.method)) {
      write(c, JSON.stringify({
        id: req.id,
        error: {
          code: 'E_NOT_FOUND',
          message: `${req.method} is not served over the adapter's pipe; it serves ${METHODS.join(', ')}`,
          detail: { method: req.method, methods: METHODS },
        },
      }) + '\n');
      return;
    }
    const fnName = req.method.slice('worker.'.length);
    const { caller, ticket, ...params } = req.params || {};
    if (fnName === 'pause' || fnName === 'resume') {
      params.by = `${caller.role}:${caller.pid}${fnName === 'pause' && typeof params.reason === 'string' && params.reason ? ` [${params.reason}]` : ''}`; // ADR 0034: the run pause's cause
      delete params.reason;
    }
    // Fix round, should-fix finding: tracked from here, not from the reply write alone, so close()
    // actually waits out a manager call in flight (a stop still running its graceful close) instead
    // of returning at once because nothing had reached `write()` yet.
    // The ticket is redeemed before the manager is called, so a refused one has done nothing.
    const p = Promise.resolve()
      .then(() => (redeem ? redeem({ ticket, worker_id: params.worker_id, verb: fnName }) : null))
      .then(() => manager[fnName](params))
      .then((result) => write(c, JSON.stringify({ id: req.id, result }) + '\n'))
      .catch((e) => write(c, JSON.stringify({ id: req.id, error: { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail } }) + '\n'));
    inFlight.add(p);
    p.then(() => inFlight.delete(p));
  }

  function onConn(c) {
    conns.add(c);
    let buf = '';
    c.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.length > MAX_LINE_BYTES) { buf = ''; c.destroy(); return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) dispatch(c, line);
      }
    });
    c.on('close', () => conns.delete(c));
    c.on('error', () => conns.delete(c));
  }

  function listen() {
    return new Promise((resolve, reject) => {
      // POSIX only: a stale socket file of this exact name (this adapter pid never reused a live
      // socket) is unlinked before binding, as owner.cjs's own pipe does not need to because Windows
      // named pipes carry no such file.
      if (process.platform !== 'win32') { try { fs.unlinkSync(pipe); } catch { /* not present */ } }
      server = net.createServer(onConn);
      server.once('error', reject);
      server.listen(pipe, () => resolve({ pipe, pid }));
    });
  }

  // Bounded at 5,000 ms as Owner.stop() is, then every connection is destroyed and the server closed.
  // Idempotent: a second close() on an already-closed control resolves at once.
  async function close() {
    if (!server) return { pipe, pid, already: true };
    if (inFlight.size) {
      const pending = [...inFlight];
      await new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
        const timer = setTimeout(done, 5000);
        Promise.allSettled(pending).then(done);
      });
    }
    for (const c of conns) c.destroy();
    conns.clear();
    await new Promise((resolve) => { const s = server; server = null; s.close(() => resolve()); });
    return { pipe, pid };
  }

  return { pipe, listen, close };
}

module.exports = { createWorkerControl };
