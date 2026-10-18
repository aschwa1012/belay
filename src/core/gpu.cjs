'use strict';
// gpu.cjs — owner-side client of the GPU child (ADR 0049 decision 3), the sibling of embedder.cjs. The public
// face is IPC messages to a CHILD PROCESS (gpu-worker.cjs, forked here and known by its exact handle), so a model
// load or a rerank never blocks the owner's event loop (invariant 7) and a native crash or a driver reset takes
// down only that child. Nothing here reaches node-llama-cpp; this module is for the store owner alone and no
// read path may require it (invariant 9, tests/core/gpu-import-graph.test.cjs).
//
//   Liveness   ping() is a bounded request and response with a read timeout (invariant 7). It resolves
//              { ok, ms, ... } and never throws: ok:false names why (no answer, dead, closed).
//   Stopping   close() sends `close`, waits at most 2,000 ms for the child to exit, then kills it by its exact
//              child handle (ADR 0039; never a command-line match). The child also ends by itself when the IPC
//              channel closes, so it cannot outlive its owner. The channel is unref'd while nothing is in flight.
//   Failures   Every failure is a coded error carrying detail.gpu === true and detail.cause (the tier fallback of
//              ADR 0050 decision 6 reports the cause):
//                absent      E_MODEL_ABSENT  the runtime or a model file is missing or wrong
//                dead        E_MODEL_ABSENT  the child exited or its channel broke (exit code or signal in detail)
//                timeout     E_EMBEDDER_TIMEOUT  the child sent nothing at all for a whole bound; it is treated as
//                            hung and every later op fails at once, until close() and a new start()
//                load_failed / op_failed   E_INTERNAL  the child answered with an error of its own
//              A refusal the child computed from a bad input (E_ARGS) is not a GPU failure and keeps its code.
//              Nothing waits forever and nothing is restarted by itself: a dead child stays dead.
//
// Contract: new GpuClient({ runtimeDir?, cacheDir?, opBoundMs?, loadBoundMs?, pingBoundMs? }); start();
// load(modelId, { gpu, contextSize?, batchSize?, chunk?, chunkTokens? }); embed(modelId, text, { as });
// rank(modelId, query, docs, { chunk?, chunkTokens? });
// vram(); ping(); close(). `pid` is the child's pid. Test seams (BELAY_TEST_MODE=1 alone): `workerPath` forks that
// script instead (a fake with no GPU), `workerOpts` is merged into the child's argv JSON, `table` replaces the model table.

const path = require('node:path');
const { fork } = require('node:child_process');
const { err, CODES } = require('./errors.cjs');
const { ggufFor } = require('./gguf-models.cjs');
const K = require('./model-cache.cjs');
const R = require('./gpu-runtime.cjs');
const { killPid } = require('./process.cjs');

const OP_BOUND_MS = 60000;
const LOAD_BACKSTOP_MS = 600000; // a hung load only: a cold 8B load has been measured at 5 s, a first Vulkan shader build longer
const PING_BOUND_MS = 1000;
const CLOSE_GRACE_MS = 2000;
// Exactly what the GPU child may see of the owner's environment: the cache roots and the Windows basics a
// Vulkan loader needs. An allow-list, never a scrubbed copy (the owner holds every secret).
const CHILD_ENV = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOME', 'XDG_CACHE_HOME', 'BELAY_MODEL_CACHE', 'BELAY_GPU_RUNTIME', 'BELAY_TEST_MODE'];

const gpu = (cause, extra) => ({ gpu: true, cause, ...(extra || {}) });

class GpuClient {
  constructor(opts = {}) {
    this.runtimeDir = opts.runtimeDir || null;
    this.cacheDir = opts.cacheDir || K.cacheRoot();
    this.opBoundMs = opts.opBoundMs || OP_BOUND_MS;
    this.loadBoundMs = opts.loadBoundMs || LOAD_BACKSTOP_MS;
    this.pingBoundMs = opts.pingBoundMs || PING_BOUND_MS;
    const test = process.env.BELAY_TEST_MODE === '1';
    this.fake = test && !!opts.workerPath; // a fake child needs no installed runtime
    this.workerPath = this.fake ? opts.workerPath : path.join(__dirname, 'gpu-worker.cjs');
    this.workerOpts = (test && opts.workerOpts) || {};
    this.table = (test && opts.table) || undefined; // a test's own model table
    this.child = null; this.pid = null; this.exit = null; this.closed = false; this.hung = null;
    this.onExit = null; this.onWarning = null; this.pending = new Map(); this.seq = 0; this.models = new Map();
  }

  // Forks the child. The runtime is checked first: a missing or wrong one is E_MODEL_ABSENT naming the command.
  start() {
    if (this.child && !this.exit) return this;
    if (!this.runtimeDir && !this.fake) this.runtimeDir = R.requireRuntime();
    const env = {};
    for (const k of CHILD_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
    const c = fork(this.workerPath, [JSON.stringify({ runtimeDir: this.runtimeDir, ...this.workerOpts })], {
      env, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    this.child = c; this.pid = c.pid; this.exit = null; this.closed = false; this.hung = null; this.models.clear();
    c.unref(); if (c.channel) c.channel.unref();
    c.on('message', (m) => {
      const p = this.pending.get(m.id);
      if (m.progress) { // proof of life for THIS request, and for those queued behind it (the child serves one at a time)
        const now = Date.now();
        for (const [id, q] of this.pending) if (id >= m.id) q.heard = now;
        return;
      }
      if (!p) return; // a ping or vram answer, or a request already settled, proves nothing about any other request
      this._settle(m.id);
      if (m.ok) return p.resolve(m.result);
      const known = CODES.has(m.error.code);
      const code = known ? m.error.code : 'E_INTERNAL';
      const cause = code === 'E_MODEL_ABSENT' ? 'absent' : code === 'E_ARGS' ? null : p.op === 'load' ? 'load_failed' : 'op_failed';
      const detail = known ? m.error.detail : { ...(m.error.detail || {}), raw_code: m.error.code === undefined ? null : String(m.error.code) };
      p.reject(err(code, m.error.message, cause ? { ...(detail || {}), ...gpu(cause) } : detail));
    });
    c.on('error', () => { /* a spawn or IPC failure also ends in 'exit' or a bound */ });
    c.on('exit', (code, signal) => {
      if (this.child !== c) return;
      this.exit = { code, signal };
      const why = `the GPU process (pid ${c.pid}) exited${code !== null ? ` with exit code ${code}` : ` on signal ${signal}`}`;
      for (const id of [...this.pending.keys()]) { const p = this.pending.get(id); this._settle(id); p.reject(err('E_MODEL_ABSENT', why, gpu('dead', { pid: c.pid, exit_code: code, signal }))); }
      if (!this.closed && this.onExit) { try { this.onExit(why, this.exit); } catch { /* the owner records it */ } }
    });
    return this;
  }

  _settle(id) {
    const p = this.pending.get(id);
    if (p) clearTimeout(p.timer);
    this.pending.delete(id);
    if (!this.pending.size && this.child && this.child.channel) this.child.channel.unref();
  }

  _deadReason() {
    if (this.exit) return `the GPU process (pid ${this.pid}) exited${this.exit.code !== null ? ` with exit code ${this.exit.code}` : ` on signal ${this.exit.signal}`}; it is not restarted within this owner`;
    return 'the GPU process is not running; start() has not been called or close() was called';
  }

  _call(msg, boundMs) {
    if (!this.child || this.exit) return Promise.reject(err('E_MODEL_ABSENT', this._deadReason(), gpu('dead', { pid: this.pid })));
    if (this.hung) return Promise.reject(this.hung);
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      // Hung means SILENT: nothing about THIS request for the whole bound, counted from the call or from the last
      // progress line for it (or for a request ahead of it in the child's queue). Answers to a ping or to vram
      // do not count: a wedged rank must still reject while the owner pings for liveness. A rank sends a line
      // per chunk, so a long rank never trips it.
      const sentAt = Date.now();
      const arm = (ms) => setTimeout(() => {
        const p = this.pending.get(id);
        if (!p) return;
        const silent = Date.now() - Math.max(p.heard, sentAt);
        if (silent < boundMs) { p.timer = arm(boundMs - silent); return; }
        this._settle(id);
        const e = err('E_EMBEDDER_TIMEOUT', `the GPU process (pid ${this.pid}) did not answer ${msg.op} within ${boundMs} ms and is treated as hung`, gpu('timeout', { op: msg.op, timeout_ms: boundMs, pid: this.pid }));
        this.hung = e;
        reject(e);
      }, ms);
      this.pending.set(id, { resolve, reject, timer: arm(boundMs), op: msg.op, heard: sentAt });
      if (this.child.channel) this.child.channel.ref();
      try { this.child.send({ id, ...msg }); }
      catch (e) { this._settle(id); reject(err('E_MODEL_ABSENT', `the GPU process (pid ${this.pid}) could not be reached: ${e.message}`, gpu('dead', { pid: this.pid }))); }
    });
  }

  // A request with its own short bound that never marks the child hung and leaves nothing pending when the bound
  // passes (a late answer is dropped): { ok:true, ms, result } or { ok:false, ms, reason }. ping and the probe's
  // samples use it; the caller decides what a miss means.
  _quick(msg, timeoutMs) {
    const t0 = Date.now();
    if (!this.child || this.exit) return Promise.resolve({ ok: false, ms: 0, reason: this._deadReason() });
    return new Promise((resolve) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this._settle(id); resolve({ ok: false, ms: Date.now() - t0, reason: `the GPU process (pid ${this.pid}) did not answer ${msg.op === 'ping' ? `a ${timeoutMs} ms ping` : `${msg.op} within ${timeoutMs} ms`}` }); }, timeoutMs);
      this.pending.set(id, {
        timer, op: msg.op, heard: t0,
        resolve: (result) => resolve({ ok: true, ms: Date.now() - t0, result }),
        reject: (e) => resolve({ ok: false, ms: Date.now() - t0, reason: e.message }),
      });
      if (this.child.channel) this.child.channel.ref();
      try { this.child.send({ id, ...msg }); } catch (e) { this._settle(id); resolve({ ok: false, ms: Date.now() - t0, reason: `the GPU process could not be reached: ${e.message}` }); }
    });
  }

  // A bounded request and response (invariant 7): { ok:true, ms, pid, models } when the child answered within
  // `timeoutMs`, else { ok:false, ms, reason }. A ping that goes unanswered does not mark the child hung; the
  // caller decides what an unanswered ping means.
  async ping(timeoutMs = this.pingBoundMs) {
    const r = await this._quick({ op: 'ping' }, timeoutMs);
    return r.ok ? { ok: true, ms: r.ms, pid: r.result.pid, models: r.result.models } : { ok: false, ms: r.ms, reason: r.reason };
  }

  // One memory sample for the probe: vram under its own short bound, never setting hung, never left pending.
  async vramSample(timeoutMs = 1500) {
    const r = await this._quick({ op: 'vram', gpu: 'vulkan' }, timeoutMs);
    if (!r.ok) throw new Error(r.reason);
    return r.result;
  }

  vram(opts = {}) { return this._call({ op: 'vram', gpu: opts.gpu }, this.opBoundMs); }

  // Loads one table model into the child. The model's file must be in the cache (a stat, never a hash).
  async load(modelId, { gpu: device = 'vulkan', contextSize, batchSize, chunk, chunkTokens } = {}) {
    const entry = ggufFor(modelId, this.table);
    const chk = K.checkPresent(entry, this.cacheDir);
    if (!chk.present) throw err('E_MODEL_ABSENT', `the GPU model ${entry.id} is not fetched or is wrong (${[...chk.missing, ...chk.wrong_size].join(', ')}); fetch it with \`belay embedder fetch --gpu --model ${entry.id}\``, gpu('absent', { model: entry.id, command: `belay embedder fetch --gpu --model ${entry.id}` }));
    const info = await this._call({
      op: 'load', model: entry.id, kind: entry.kind, path: path.join(chk.dir, entry.files[0].path).split('\\').join('/'), gpu: device,
      contextSize: contextSize || entry.context_size, batchSize, dims: entry.dims || undefined, queryPrompt: entry.query_prompt || undefined, chunk, chunkTokens,
    }, this.loadBoundMs);
    this.models.set(entry.id, { kind: entry.kind, gpu: device });
    return info;
  }

  embed(modelId, text, { as = 'document' } = {}) {
    if (as !== 'document' && as !== 'query') throw err('E_ARGS', `embed: as must be 'document' or 'query', not ${JSON.stringify(as)}`, { as });
    return this._call({ op: 'embed', model: modelId, text, as }, this.opBoundMs);
  }

  // Resolves the child's result. A chunk that took longer than the child's slow-chunk bound (1.5 s) is also reported
  // as result.warnings = [{ code: 'GPU_SLOW_CHUNK', message, slow_chunks: [{ index, ms }] }] and to `onWarning`.
  rank(modelId, query, docs, { chunk, chunkTokens } = {}) {
    if (!Array.isArray(docs) || !docs.length) throw err('E_ARGS', 'rank needs a non-empty list of docs', { docs: Array.isArray(docs) ? 0 : typeof docs });
    return this._call({ op: 'rank', model: modelId, query, docs, chunk, chunkTokens }, this.opBoundMs).then(r => this._warnSlow(r));
  }

  _warnSlow(r) {
    if (r.slow_chunks && r.slow_chunks.length) {
      const w = { code: 'GPU_SLOW_CHUNK', message: `${r.slow_chunks.length} rerank chunk(s) took over ${r.slow_chunk_ms} ms (the slowest ${Math.max(...r.slow_chunks.map(x => x.ms))} ms); one GPU submission may be near the Windows TDR limit`, slow_chunks: r.slow_chunks };
      r.warnings = [w];
      if (this.onWarning) { try { this.onWarning(w); } catch { /* the owner records it */ } }
    }
    return r;
  }

  // Ends the child: `close` over IPC, at most 2,000 ms of grace, then a kill by its exact child handle. Safe to
  // call twice, after a failed load, and mid-op.
  async close() {
    const c = this.child;
    this.closed = true; this.models.clear();
    for (const id of [...this.pending.keys()]) { const p = this.pending.get(id); clearTimeout(p.timer); this.pending.delete(id); p.reject(err('E_INTERNAL', 'the GPU process was closed', gpu('dead'))); }
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

module.exports = { GpuClient, CHILD_ENV };
