'use strict';
// embedder.cjs — owner-side embedding (ADR 0003 §3, amended by ADR 0027). The public face of the
// embedder: load, embed and tokenCount are IPC messages to a CHILD PROCESS (embed-worker.cjs, forked
// here and known by its pid) that holds the pipeline, so a model load or an embed never blocks the
// owner's event loop (invariant 7) and native onnx code can never take the owner down with it. Each
// message carries a bound. close() sends `close`, waits at most 2,000 ms for the child to exit, then
// kills it by its exact pid; the child also exits by itself when the IPC channel closes, so it cannot
// outlive its owner. The channel is unref'd while nothing is in flight, so it never keeps a process alive.
//
// A load is WAITED ON, not bounded by a fixed number that turns a slow host into a failure (build 12b E2):
// the only bound is a backstop for a hung child (LOAD_BACKSTOP_MS, 10 min); a child that dies rejects at
// once. The caller's own limit (index.cjs, 100 s) ends the CALL, never the load; the owner keeps one load
// promise (owner.cjs getEmbedder), so a later call waits on the same load, and a load that failed is
// reported with its cause once and then to every later call promptly until the owner restarts.
// Every failure carries detail.embedder === true and detail.cause: absent | dead | timeout | load_failed | op_failed | canary (api.md §6).
//
// Contract: new Embedder({ model, pkg, cacheDir, loadBoundMs? }); load(stored) resolves the identity it loaded;
// embed(text, { as }) resolves { embedding, embedding_model, embedding_revision, dim, tokens };
// tokenCount(text) is async; close() is async; `pid` is the child's pid. Refusals are E_MODEL_ABSENT,
// E_MODEL_CHANGED, E_TOO_LONG, E_ARGS. A child that dies after a load makes later calls E_MODEL_ABSENT
// saying the embedder process exited, with its code; nothing reloads it (the outcome is sticky).
//
// This module must never be reachable from a read path: it costs 13.5 s on first import and 664 ms warm
// (ADR 0005 §9), and status.get has a 100 ms budget. It is `require`d lazily, only by the owner as it
// loads a vector call, and tests/core/import-graph.test.cjs asserts that on require.cache.

const path = require('node:path');
const { fork } = require('node:child_process');
const { err, CODES } = require('./errors.cjs');
const { DEFAULT_MODEL, modelFor } = require('./models.cjs');
const K = require('./model-cache.cjs');
const I = require('./embed-identity.cjs');
const { preflight } = require('./embedder-core.cjs');
const { killPid } = require('./process.cjs');

const { CANARY } = I;
const LOAD_BACKSTOP_MS = 600000; // a hung child only: a cold load of the 243 MB model has been measured at 32 s and over 90 s under contention
const OP_BOUND_MS = 60000;
const CLOSE_GRACE_MS = 2000;
// Exactly what the embedder child may see of the owner's environment (Windows names first, then the
// POSIX ones the cache root needs, then belay's own overrides).
const CHILD_ENV = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOME', 'XDG_CACHE_HOME', 'BELAY_MODEL_CACHE', 'BELAY_TRANSFORMERS_PKG', 'BELAY_TEST_MODE'];

// The canonical cause set (api.md §6). A refusal the embedder itself computed (a bad input) is not an
// embedder failure; a missing model, a changed one or an internal fault is.
const EMBEDDER_CAUSES = ['absent', 'dead', 'timeout', 'load_failed', 'op_failed', 'canary'];
const CAUSES = { E_MODEL_ABSENT: 'absent', E_MODEL_CHANGED: 'canary' };
function flag(code, detail, op) {
  const cause = code === 'E_INTERNAL' ? (op === 'load' ? 'load_failed' : 'op_failed') : CAUSES[code];
  return cause ? { ...(detail || {}), cause, embedder: true } : detail;
}

class Embedder {
  // opts: { model: id in the table, pkg: package directory, cacheDir: cache root }
  constructor(opts = {}) {
    this.entry = modelFor(opts.model || DEFAULT_MODEL);
    this.model = this.entry.id;
    this.pkg = opts.pkg || null;
    this.cacheDir = opts.cacheDir || K.cacheRoot();
    this.dim = this.entry.dims;
    this.loadBoundMs = opts.loadBoundMs || LOAD_BACKSTOP_MS;
    // Test-only (the worker honours it under BELAY_TEST_MODE=1 alone): hold the child's load this long.
    this.testLoadDelayMs = process.env.BELAY_TEST_MODE === '1' ? opts.testLoadDelayMs || 0 : 0;
    this.pipe = null; this.library = null;
    this.child = null; this.pid = null; this.exit = null; this.closed = false;
    this.opBoundMs = opts.opBoundMs || OP_BOUND_MS; this.hung = null; this.onHung = null;
    this.onExit = null; this.pending = new Map(); this.seq = 0;
  }

  _start() {
    // The child runs third-party npm code and needs almost nothing: an allow-list, never a scrubbed copy of
    // the owner's environment (which carries every secret the owner holds), and no inherited execArgv
    // (--inspect, test-runner flags) or NODE_OPTIONS.
    const env = {};
    for (const k of CHILD_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
    const c = fork(path.join(__dirname, 'embed-worker.cjs'), [JSON.stringify({ model: this.model, pkg: this.pkg, cacheDir: this.cacheDir })], {
      env, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    this.child = c; this.pid = c.pid; this.exit = null; this.closed = false;
    c.unref(); if (c.channel) c.channel.unref();
    this.lastHeard = Date.now();
    c.on('message', (m) => {
      this.lastHeard = Date.now(); // any word from the child proves it is alive and working through its queue
      const p = this.pending.get(m.id);
      if (!p) return;
      this._settle(m.id);
      if (m.ok) p.resolve(m.result);
      else {
        // Flag on the RESOLVED code: a codeless or Node-coded child error (an onnxruntime failure mid-embed) is an
        // E_INTERNAL embedder failure too, its raw code kept in detail.raw_code (build 12b E2 review 1, B1).
        const known = CODES.has(m.error.code);
        const code = known ? m.error.code : 'E_INTERNAL';
        const detail = known ? m.error.detail : { ...(m.error.detail || {}), raw_code: m.error.code === undefined ? null : String(m.error.code) };
        p.reject(err(code, m.error.message, flag(code, detail, p.op)));
      }
    });
    c.on('error', () => { /* a spawn or IPC failure also ends in 'exit' or a bound */ });
    c.on('exit', (code, signal) => {
      if (this.child !== c) return;
      this.exit = { code, signal };
      this.pipe = null;
      const why = `the embedder process (pid ${c.pid}) exited${code !== null ? ` with exit code ${code}` : ` on signal ${signal}`}`;
      for (const id of [...this.pending.keys()]) { const p = this.pending.get(id); this._settle(id); p.reject(err('E_MODEL_ABSENT', why, { embedder: true, cause: 'dead', pid: c.pid, exit_code: code, signal })); }
      if (!this.closed && this.onExit) { try { this.onExit(why, this.exit); } catch { /* the owner records it */ } }
    });
  }

  _settle(id) {
    const p = this.pending.get(id);
    if (p) clearTimeout(p.timer);
    this.pending.delete(id);
    if (!this.pending.size && this.child && this.child.channel) this.child.channel.unref();
  }

  _call(msg, boundMs) {
    if (!this.child || this.exit) return Promise.reject(err('E_MODEL_ABSENT', this._deadReason(), { embedder: true, cause: 'dead' }));
    // An op that timed out leaves a hung child: later ops fail at once with the same cause (no second 60 s wait)
    // until memory.warm({ reload: true }) closes it by its exact pid and loads afresh.
    if (this.hung && msg.op !== 'load') return Promise.reject(this.hung);
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      // Hung means SILENT: the child has sent nothing at all for the whole bound, counted from this call or the
      // child's last message, whichever is later. Time queued behind other ops that are being answered does not
      // count, so a burst of slow but steady ops never marks a healthy embedder failed (review 3, SF3).
      const sentAt = Date.now();
      const arm = (ms) => setTimeout(() => {
        const p = this.pending.get(id);
        if (!p) return;
        const silent = Date.now() - Math.max(this.lastHeard || 0, sentAt);
        if (silent < boundMs) { p.timer = arm(boundMs - silent); return; }
        this._settle(id);
        // Not E_TIMEOUT: that is a transport code a read swallows and a caller retries as "still loading".
        // This child is hung (a live load never reaches it), and the cause says which op.
        const e = err('E_EMBEDDER_TIMEOUT', `the embedder process (pid ${this.pid}) did not answer ${msg.op} within ${boundMs} ms and is treated as hung`, { embedder: true, cause: 'timeout', phase: msg.op === 'load' ? 'load' : 'op', op: msg.op, timeout_ms: boundMs, pid: this.pid });
        if (msg.op !== 'load') { this.hung = e; if (this.onHung) { try { this.onHung(e); } catch { /* the owner records it */ } } }
        reject(e);
      }, ms);
      this.pending.set(id, { resolve, reject, timer: arm(boundMs), op: msg.op });
      if (this.child.channel) this.child.channel.ref();
      try { this.child.send({ id, ...msg }); }
      catch (e) { this._settle(id); reject(err('E_MODEL_ABSENT', `the embedder process (pid ${this.pid}) could not be reached: ${e.message}`, { embedder: true, cause: 'dead', pid: this.pid })); }
    });
  }

  _deadReason() {
    if (this.exit) return `the embedder process (pid ${this.pid}) exited${this.exit.code !== null ? ` with exit code ${this.exit.code}` : ` on signal ${this.exit.signal}`}; it is not restarted within this owner`;
    return 'the embedder process is not running; load() has not succeeded or close() was called';
  }

  // `stored` is the store's recorded identity (embed-identity.cjs META_KEYS), any key absent. Returns the
  // identity it loaded: model, sha, dtype, pooling, dim, library, canary_vector, canary_sha256, load_ms,
  // and the two flags the owner acts on: adopted_canary and library_changed.
  async load(stored) {
    I.checkIdentity(this.entry, stored);           // refused before any process or file is touched
    preflight(this.entry, this.pkg, this.cacheDir);
    await this.close();
    this.hung = null;
    this._start();
    try {
      const info = await this._call({ op: 'load', stored: stored || null, testDelayMs: this.testLoadDelayMs || undefined }, this.loadBoundMs);
      this.library = info.library;
      this.pipe = { process: this.pid };
      return info;
    } catch (e) { await this.close(); throw e; }
  }

  async tokenCount(text) {
    if (!this.pipe) throw err('E_MODEL_ABSENT', this.exit ? this._deadReason() : 'the embedder was asked for a token count before it finished loading');
    return this._call({ op: 'tokenCount', text }, this.opBoundMs);
  }

  async embed(text, { as = 'document' } = {}) {
    if (as !== 'document' && as !== 'query') throw err('E_ARGS', `embed: as must be 'document' or 'query', not ${JSON.stringify(as)}`, { as });
    if (!this.pipe) throw err('E_MODEL_ABSENT', this.exit ? this._deadReason() : 'the embedder was asked to embed before it finished loading');
    return this._call({ op: 'embed', text, as }, this.opBoundMs);
  }

  // Ends the child: `close` over IPC, at most 2,000 ms of grace, then a kill by its exact pid. Safe to
  // call twice, after a failed load, and mid-load or mid-embed.
  async close() {
    const c = this.child;
    this.closed = true; this.pipe = null;
    for (const id of [...this.pending.keys()]) { const p = this.pending.get(id); clearTimeout(p.timer); this.pending.delete(id); p.reject(err('E_INTERNAL', 'the embedder process was closed', { embedder: true, cause: 'dead' })); }
    if (!c) return;
    this.child = null;
    if (c.exitCode !== null || c.signalCode !== null) return;
    const gone = new Promise(res => c.once('exit', res));
    try { c.send({ op: 'close' }); } catch { /* the channel is already gone */ }
    let timer = null;
    const exited = await Promise.race([gone.then(() => true), new Promise(res => { timer = setTimeout(() => res(false), CLOSE_GRACE_MS); })]);
    clearTimeout(timer);
    if (!exited) {
      killPid(c); // ADR 0039: by the live child handle (exitCode checked above)
      await Promise.race([gone, new Promise(res => setTimeout(res, 3000).unref())]);
    }
    try { c.disconnect(); } catch { /* already closed */ }
  }
}

module.exports = { Embedder, CANARY, EMBEDDER_CAUSES };
