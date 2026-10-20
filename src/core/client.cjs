'use strict';
// client.cjs — a client of the owner's pipe. Lifted from prototypes/memstore/client.cjs with two
// defects fixed.
//
// 1. Every call now carries a deadline. The prototype's `call()` registered a pending promise and
//    waited forever: an owner wedged on its single event loop left the caller hung with no error, which
//    is the same failure ADR 0005 §4 found in a bare-connect liveness check. A call that outlives its
//    deadline rejects with E_TIMEOUT naming the method and the budget.
// 2. Election is a choice, not a default. A worker-role caller must never elect (api.md §1); with
//    `elect: false` this client takes no lock, creates no data dir, and fails E_NO_OWNER.

const net = require('node:net');
const { err } = require('./errors.cjs');
const { pipeName } = require('./lock.cjs');
const { WRITE_METHODS } = require('./engine.cjs'); // the method table only; nothing here opens a store

const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

// Embeddings travel as base64 float32, not as a JSON array of decimals: a 384-d vector is ~1.5 KB of
// bytes against ~3.5-4 KB of comma-separated text, and it parses as one string instead of 384 elements.
function floatsToB64(arr) {
  const f = arr instanceof Float32Array ? arr : Float32Array.from(arr, Number);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
}

function encodeWire(params) {
  if (!params) return params;
  let out = params;
  if (Array.isArray(out.embedding)) { out = { ...out, embedding_b64: floatsToB64(out.embedding) }; delete out.embedding; }
  if (Array.isArray(out.query_embedding)) { out = { ...out, query_embedding_b64: floatsToB64(out.query_embedding) }; delete out.query_embedding; }
  if (Array.isArray(out.query_embeddings)) out = { ...out, query_embeddings: out.query_embeddings.map((q) => (q && Array.isArray(q.vector) ? { ...q, vector: undefined, vector_b64: floatsToB64(q.vector) } : q)) };
  return out;
}

class Client {
  constructor(dataDir, opts = {}) {
    this.dataDir = dataDir;
    this.opts = {
      elect: true, retryMs: 200, dialTimeoutMs: 1000, callTimeoutMs: 30000,
      connectRetries: opts.elect === false ? 1 : 25, ...opts,
    };
    // build step 6c: opts.pipe overrides the pipe name (the worker adapter's own, never the owner's);
    // election belongs to the owner's pipe alone, so a caller that names both is refused.
    if (opts.pipe && this.opts.elect) throw err('E_ARGS', 'a client built with an explicit pipe may not also elect', { pipe: opts.pipe });
    this.pipe = opts.pipe || pipeName(dataDir);
    this.pending = new Map();
    this.nextId = 1;
    this.sock = null;
    this.owner = null;
    this.becameOwner = false;
    this.reelections = 0;
  }

  get connected() { return !!this.sock && !this.sock.destroyed; }

  async connect() {
    for (let i = 0; i < this.opts.connectRetries; i++) {
      try { await this._dial(this.opts.dialTimeoutMs); return this; }
      catch { /* no owner answered; maybe elect, maybe wait for whoever is starting */ }
      if (this.opts.elect) {
        const { Owner } = require('./owner.cjs');
        const o = new Owner(this.dataDir, this.opts.ownerOpts);
        try {
          await o.start();
          // ADR 0029 amendment 4 (proposed): a process in the orchestrator role that wins the election over a run that has
          // already ended is a late adapter. It would be a stray owner that writes into the ended run, and the per-Core
          // E_SHUTDOWN guard cannot see it (another process shut the owner down). It gives the lock back and fails.
          const ended = this._endedRun(o);
          if (ended) { await o.stop(); throw err('E_SHUTDOWN', `run ${ended.id} has already ended; this orchestrator-role process was not made the store owner`, { run_id: ended.id, ended_at: ended.ended_at, data_dir: this.dataDir }); }
          this.owner = o; this.becameOwner = true; return this;
        }
        catch (e) { if (e.code !== 'E_LOCKED') throw e; } // someone else is the owner; dial again
      }
      if (i < this.opts.connectRetries - 1) await sleep(this.opts.retryMs);
    }
    throw err('E_NO_OWNER', `no owner answered at ${this.pipe} and this caller may not elect one`, { data_dir: this.dataDir, pipe: this.pipe, elect: !!this.opts.elect });
  }

  _endedRun(owner) {
    const caller = this.opts.caller;
    if (!caller || caller.role !== 'orchestrator' || !caller.run_id) return null;
    try {
      const row = require('./rows.cjs').current(owner.store, 'run', caller.run_id);
      return row && row.ended_at != null ? { id: caller.run_id, ended_at: row.ended_at } : null;
    } catch { return null; }
  }

  _dial(timeoutMs) {
    return new Promise((resolve, reject) => {
      const s = net.connect(this.pipe);
      let buf = '', settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; try { s.unref(); } catch { /* best effort */ } s.destroy(); reject(err('E_TIMEOUT', `connecting to ${this.pipe} took longer than ${timeoutMs} ms`)); } }, timeoutMs);
      timer.unref();
      s.once('connect', () => { if (settled) return; settled = true; clearTimeout(timer); this.sock = s; resolve(); });
      s.once('error', e => { clearTimeout(timer); if (!settled) { settled = true; reject(e); } else this._lost(e); });
      s.on('close', () => { if (settled && this.sock === s) this._lost(new Error('the owner closed the pipe')); });
      s.on('data', d => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(err(msg.error.code || 'E_INTERNAL', msg.error.message || 'the owner returned an error with no message', msg.error.detail));
          else p.resolve(msg.result);
        }
      });
    });
  }

  _lost(e) {
    if (!this.sock) return;
    this.sock = null;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(this._lostSent(p.method, `the owner went away mid-call: ${e.message}`, { call_id: id }));
    }
  }

  // ADR 0033: an E_OWNER_LOST names whether the request was handed to the socket. A sent write may
  // already be committed, so it carries the same may_have_committed advice as an E_TIMEOUT.
  _lostSent(method, message, detail) {
    const mayHaveCommitted = !!method && WRITE_METHODS.has(method);
    const advice = mayHaveCommitted ? '; the owner may already have committed it, so re-read before retrying' : '';
    const d = { ...detail, method, sent: true };
    if (mayHaveCommitted) d.may_have_committed = true;
    return err('E_OWNER_LOST', message + advice, d);
  }

  call(method, params, opts = {}) {
    if (!this.connected) return Promise.reject(err('E_OWNER_LOST', 'this client holds no connection to an owner', { method, sent: false }));
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs == null ? this.opts.callTimeoutMs : opts.timeoutMs;
    const wire = JSON.stringify({ id, method, params: encodeWire(params) }) + '\n';
    return new Promise((resolve, reject) => {
      // api.md §6: a deadline that fires says nothing about whether the owner ran the call. On a write
      // the owner may already have committed the row, and these tables are append-only, so a blind
      // retry would double it. The message says so, because the caller acts on the message.
      const mayHaveCommitted = WRITE_METHODS.has(method);
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        const advice = mayHaveCommitted
          ? '; the owner may already have committed it, so re-read before retrying'
          : '';
        reject(err('E_TIMEOUT', `the owner did not answer ${method} within ${timeoutMs} ms over ${this.pipe}${advice}`, { method, timeout_ms: timeoutMs, may_have_committed: mayHaveCommitted }));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.sock.write(wire); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(err('E_OWNER_LOST', `writing ${method} to the pipe failed: ${e.message}`, { method, sent: false })); }
    });
  }

  async close() {
    if (this.sock) { const s = this.sock; this.sock = null; s.destroy(); }
    for (const [id, p] of this.pending) { this.pending.delete(id); clearTimeout(p.timer); p.reject(this._lostSent(p.method, 'the client was closed with this call still outstanding', { call_id: id })); }
  }

  // The only sanctioned way to stop an owner (ADR 0002 §5): never a signal, because TerminateProcess on
  // Windows skips the owner's handlers and leaves the lock dir and WAL sidecars behind.
  async shutdown() {
    if (this.owner) { const r = await this.owner.stop(); this.owner = null; await this.close(); return { ...r, stopped: 'in-process' }; }
    if (this.connected) {
      let r = null;
      // The owner gates `shutdown` on the caller's role (api.md §6), so it travels with this client's
      // identity like every other call: from argv, never from anything a model said.
      try { r = await this.call('shutdown', { caller: this.opts.caller }, { timeoutMs: 5000 }); }
      catch (e) { if (e.code !== 'E_OWNER_LOST') throw e; }
      await this.close();
      return { ...(r || {}), stopped: 'remote' };
    }
    return { stopped: 'none' };
  }
}

module.exports = { Client, floatsToB64, encodeWire };
