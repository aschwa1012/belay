'use strict';
// rerank-cpu.cjs — owner-side client of the CPU reranker child (ADR 0050 decision 5), the sibling of gpu.cjs. The
// public face is IPC messages to a CHILD PROCESS (rerank-worker.cjs, forked here and known by its exact handle), so
// a model load or a rerank never blocks the owner's event loop (invariant 7) and a native crash takes down only that
// child. Nothing here reaches the embedding library; this module is for the store owner alone and no read path may
// require it (invariant 9, tests/core/rerank-cpu-import-graph.test.cjs).
//
//   Liveness   ping() is a bounded request and response with a read timeout (invariant 7). It resolves
//              { ok, ms, ... } and never throws: ok:false names why (no answer, dead, closed). A ping never sets hung.
//   Stopping   close() sends `close`, waits at most 2,000 ms for the child to exit, then kills it by its exact child
//              handle (ADR 0039; never a command-line match). The child also ends by itself when the IPC channel
//              closes, so it cannot outlive its owner. The channel is unref'd while nothing is in flight.
//   Failures   Every failure is a coded error carrying detail.reranker === true and detail.cause:
//                absent      E_MODEL_ABSENT  the package or a model file is missing or wrong
//                dead        E_MODEL_ABSENT  the child exited or its channel broke (exit code or signal in detail)
//                timeout     E_EMBEDDER_TIMEOUT  the child sent nothing at all for a whole bound (the silence clock
//                            below); it is treated as hung and every later op fails at once, until close() and a new start()
//                load_failed / op_failed   E_INTERNAL  the child answered with an error of its own
//              A refusal the child computed from a bad input (E_ARGS) is not a reranker failure and keeps its code.
//              Nothing waits forever and nothing is restarted by itself: a dead child stays dead.
//   Silence    A request is hung when the child sends nothing about THAT request (or one queued ahead of it) for a
//              whole bound, counted from the call or from the last progress line. A rank sends one line per chunk and a
//              load a heartbeat, so a long rank never trips it; answers to a ping do not count.
//
// Contract: new CpuRerankClient({ pkg?, cacheDir?, opBoundMs?, loadBoundMs?, pingBoundMs? }); start();
// load(modelId); rank(modelId, query, docs: [string], { chunk?, maxLength? }); ping(); close().
// `pid` is the child's pid. Test seams (BELAY_TEST_MODE=1 alone): `workerPath` forks that script instead, `workerOpts`
// is merged into the child's argv JSON, `table` replaces the reranker table.
//
// cpuRerankProvider(opts) is the function the rerank provider registry takes (see its comment): it owns one client,
// starts and loads it on the first call, and answers { scores, model, device: 'cpu', ms, warnings? }.

const path = require('node:path');
const { fork } = require('node:child_process');
const { err, CODES } = require('./errors.cjs');
const { rerankerFor } = require('./onnx-rerankers.cjs');
const K = require('./model-cache.cjs');
const { killPid } = require('./process.cjs');

const OP_BOUND_MS = 60000;
const LOAD_BACKSTOP_MS = 600000; // a hung load only: the base model's cold load is measured in seconds
const PING_BOUND_MS = 1000;
const CLOSE_GRACE_MS = 2000;
// Exactly what the child may see of the owner's environment: the cache roots, the package override and the Windows
// basics. An allow-list, never a scrubbed copy (the owner holds every secret).
const CHILD_ENV = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOME', 'XDG_CACHE_HOME', 'BELAY_MODEL_CACHE', 'BELAY_TRANSFORMERS_PKG', 'BELAY_TEST_MODE'];

const rr = (cause, extra) => ({ reranker: true, cause, ...(extra || {}) });

class CpuRerankClient {
  constructor(opts = {}) {
    this.pkg = opts.pkg || null;
    this.cacheDir = opts.cacheDir || K.cacheRoot();
    this.opBoundMs = opts.opBoundMs || OP_BOUND_MS;
    this.loadBoundMs = opts.loadBoundMs || LOAD_BACKSTOP_MS;
    this.pingBoundMs = opts.pingBoundMs || PING_BOUND_MS;
    const test = process.env.BELAY_TEST_MODE === '1';
    this.fake = test && !!opts.workerPath;
    this.workerPath = this.fake ? opts.workerPath : path.join(__dirname, 'rerank-worker.cjs');
    this.workerOpts = (test && opts.workerOpts) || {};
    this.table = (test && opts.table) || undefined;
    this.child = null; this.pid = null; this.exit = null; this.closed = false; this.hung = null;
    this.onExit = null; this.pending = new Map(); this.seq = 0; this.models = new Map();
  }

  // Forks the child. The package is checked first: a missing or wrong one is E_MODEL_ABSENT naming the fix.
  start() {
    if (this.child && !this.exit) return this;
    let pkgDir = this.pkg;
    if (!this.fake) {
      const info = K.packageInfo(this.pkg);
      const where = this.pkg || process.env.BELAY_TRANSFORMERS_PKG || null;
      if (!info) throw err('E_MODEL_ABSENT', `the transformers package ${K.PKG_NAME} is not loadable${where ? ` at ${where}` : " from belay's node_modules"}; run npm install in the belay directory`, rr('absent', { pkg: where }));
      if (info.version !== K.PKG_VERSION) throw err('E_MODEL_ABSENT', `the transformers package at ${info.dir} is version ${info.version} and belay pins ${K.PKG_VERSION}; run npm install in the belay directory`, rr('absent', { pkg: info.dir, found: info.version, pinned: K.PKG_VERSION }));
      pkgDir = info.dir;
    }
    const env = {};
    for (const k of CHILD_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
    const c = fork(this.workerPath, [JSON.stringify({ pkg: pkgDir, ...this.workerOpts })], {
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
      if (!p) return; // a ping answer, or a request already settled, proves nothing about any other request
      this._settle(m.id);
      if (m.ok) return p.resolve(m.result);
      const known = CODES.has(m.error.code);
      const code = known ? m.error.code : 'E_INTERNAL';
      const cause = code === 'E_MODEL_ABSENT' ? 'absent' : code === 'E_ARGS' ? null : p.op === 'load' ? 'load_failed' : 'op_failed';
      const detail = known ? m.error.detail : { ...(m.error.detail || {}), raw_code: m.error.code === undefined ? null : String(m.error.code) };
      p.reject(err(code, m.error.message, cause ? { ...(detail || {}), ...rr(cause) } : detail));
    });
    c.on('error', () => { /* a spawn or IPC failure also ends in 'exit' or a bound */ });
    c.on('exit', (code, signal) => {
      if (this.child !== c) return;
      this.exit = { code, signal };
      const why = `the rerank process (pid ${c.pid}) exited${code !== null ? ` with exit code ${code}` : ` on signal ${signal}`}`;
      for (const id of [...this.pending.keys()]) { const p = this.pending.get(id); this._settle(id); p.reject(err('E_MODEL_ABSENT', why, rr('dead', { pid: c.pid, exit_code: code, signal }))); }
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
    if (this.exit) return `the rerank process (pid ${this.pid}) exited${this.exit.code !== null ? ` with exit code ${this.exit.code}` : ` on signal ${this.exit.signal}`}; it is not restarted within this owner`;
    return 'the rerank process is not running; start() has not been called or close() was called';
  }

  _call(msg, boundMs) {
    if (!this.child || this.exit) return Promise.reject(err('E_MODEL_ABSENT', this._deadReason(), rr('dead', { pid: this.pid })));
    if (this.hung) return Promise.reject(this.hung);
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const sentAt = Date.now();
      const arm = (ms) => setTimeout(() => {
        const p = this.pending.get(id);
        if (!p) return;
        const silent = Date.now() - Math.max(p.heard, sentAt);
        if (silent < boundMs) { p.timer = arm(boundMs - silent); return; }
        this._settle(id);
        const e = err('E_EMBEDDER_TIMEOUT', `the rerank process (pid ${this.pid}) did not answer ${msg.op} within ${boundMs} ms and is treated as hung`, rr('timeout', { op: msg.op, timeout_ms: boundMs, pid: this.pid }));
        this.hung = e;
        reject(e);
      }, ms);
      this.pending.set(id, { resolve, reject, timer: arm(boundMs), op: msg.op, heard: sentAt });
      if (this.child.channel) this.child.channel.ref();
      try { this.child.send({ id, ...msg }); }
      catch (e) { this._settle(id); reject(err('E_MODEL_ABSENT', `the rerank process (pid ${this.pid}) could not be reached: ${e.message}`, rr('dead', { pid: this.pid }))); }
    });
  }

  // A request with its own short bound that never marks the child hung and leaves nothing pending when the bound
  // passes (a late answer is dropped): { ok:true, ms, result } or { ok:false, ms, reason }.
  _quick(msg, timeoutMs) {
    const t0 = Date.now();
    if (!this.child || this.exit) return Promise.resolve({ ok: false, ms: 0, reason: this._deadReason() });
    return new Promise((resolve) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this._settle(id); resolve({ ok: false, ms: Date.now() - t0, reason: `the rerank process (pid ${this.pid}) did not answer a ${timeoutMs} ms ${msg.op}` }); }, timeoutMs);
      this.pending.set(id, {
        timer, op: msg.op, heard: t0,
        resolve: (result) => resolve({ ok: true, ms: Date.now() - t0, result }),
        reject: (e) => resolve({ ok: false, ms: Date.now() - t0, reason: e.message }),
      });
      if (this.child.channel) this.child.channel.ref();
      try { this.child.send({ id, ...msg }); } catch (e) { this._settle(id); resolve({ ok: false, ms: Date.now() - t0, reason: `the rerank process could not be reached: ${e.message}` }); }
    });
  }

  // A bounded request and response (invariant 7): { ok:true, ms, pid, models } when the child answered within
  // `timeoutMs`, else { ok:false, ms, reason }. An unanswered ping does not mark the child hung.
  async ping(timeoutMs = this.pingBoundMs) {
    const r = await this._quick({ op: 'ping' }, timeoutMs);
    return r.ok ? { ok: true, ms: r.ms, pid: r.result.pid, models: r.result.models } : { ok: false, ms: r.ms, reason: r.reason };
  }

  // Loads one pinned reranker into the child. Its files must be in the cache (a stat, never a hash).
  async load(modelId) {
    const entry = rerankerFor(modelId, this.table);
    const chk = K.checkPresent(entry, this.cacheDir);
    if (!chk.present) {
      const command = `belay embedder fetch --reranker ${entry.id}`;
      throw err('E_MODEL_ABSENT', `the CPU reranker ${entry.id} is not fetched or is wrong (${[...chk.missing, ...chk.wrong_size].join(', ')}); fetch it with \`${command}\``, rr('absent', { model: entry.id, command }));
    }
    const info = await this._call({ op: 'load', model: entry.id, dir: chk.dir, dtype: entry.dtype, maxLength: entry.max_length }, this.loadBoundMs);
    this.models.set(entry.id, { max_length: entry.max_length });
    return info;
  }

  // Scores each doc (a string) against the query: { scores, logits, chunks, truncated, max_length, ms }. The child
  // cuts the pairs into chunks of `chunk` (default 10) and sends a progress line after each.
  rank(modelId, query, docs, { chunk, maxLength } = {}) {
    if (typeof query !== 'string') throw err('E_ARGS', 'rank needs a query string', { query: typeof query });
    if (!Array.isArray(docs) || !docs.length) throw err('E_ARGS', 'rank needs a non-empty list of docs', { docs: Array.isArray(docs) ? 0 : typeof docs });
    if (docs.some(d => typeof d !== 'string')) throw err('E_ARGS', 'rank takes document strings', {});
    return this._call({ op: 'rank', model: modelId, query, docs, chunk, maxLength }, this.opBoundMs);
  }

  // Ends the child: `close` over IPC, at most 2,000 ms of grace, then a kill by its exact child handle. Safe to
  // call twice, after a failed load, and mid-op.
  async close() {
    const c = this.child;
    this.closed = true; this.models.clear();
    for (const id of [...this.pending.keys()]) { const p = this.pending.get(id); clearTimeout(p.timer); this.pending.delete(id); p.reject(err('E_INTERNAL', 'the rerank process was closed', rr('dead'))); }
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

// The provider the rerank registry takes: `async rerank({ query, docs: [{ id, text }], depth, boundMs })` resolving
// { scores: [{ id, score }], model, device: 'cpu', ms, warnings? }.
//   - The first `depth` docs are scored (all of them when depth is absent); scores come back best first, ties in
//     input order, each a 0..1 sigmoid of the model's logit.
//   - The first call starts the child and loads the model, and that load is waited on: a `boundMs` that passes during
//     the load throws the coded timeout but leaves the load running, so a later call finds the model ready.
//   - `boundMs` passing during the rerank throws E_EMBEDDER_TIMEOUT (detail.cause 'timeout', detail.bound_ms) and
//     closes the child in the background, because it is still busy with the abandoned work; the next call starts and
//     loads a fresh one.
//   - A pair that reached the model's max_length (cut there if longer) is reported as warnings: [{ code: 'RERANK_TRUNCATED', ... }].
// opts: { model, client?, pkg?, cacheDir?, chunk?, opBoundMs?, ... } (any other key goes to CpuRerankClient).
function cpuRerankProvider(opts = {}) {
  const { model, client: given, chunk, ...clientOpts } = opts;
  if (typeof model !== 'string') throw err('E_ARGS', 'cpuRerankProvider needs a model id', { model: typeof model });
  // A given client is the first child's owner; a replacement after an abandoned rerank is built from the same settings.
  const settings = given ? { pkg: given.pkg, cacheDir: given.cacheDir, table: given.table, opBoundMs: given.opBoundMs, loadBoundMs: given.loadBoundMs, pingBoundMs: given.pingBoundMs, workerPath: given.fake ? given.workerPath : undefined, workerOpts: given.workerOpts } : clientOpts;
  let c = given || null;
  rerankerFor(model, process.env.BELAY_TEST_MODE === '1' ? settings.table : undefined); // an unknown id fails here, not on the first search
  let loaded = null; // the load promise of c, kept while it is pending or succeeded
  const closing = [];

  const ensure = () => {
    if (!c) c = new CpuRerankClient(settings);
    c.start();
    if (!loaded) {
      const mine = c;
      loaded = mine.load(model).catch((e) => { if (c === mine) loaded = null; throw e; });
    }
    return loaded;
  };
  const abandon = () => {
    const old = c;
    c = null; loaded = null;
    if (old) closing.push(old.close().catch(() => {}));
  };
  const timeout = (boundMs, phase) => err('E_EMBEDDER_TIMEOUT', `the CPU rerank did not finish ${phase} within ${boundMs} ms`, rr('timeout', { bound_ms: boundMs, phase }));
  const within = (promise, boundMs, phase, onTimeout) => {
    if (!boundMs) return promise;
    let timer = null;
    // The clock rejects first and only then abandons the child, so the race ends on the timeout and not on the close of the abandoned rank.
    const clock = new Promise((_, rej) => { timer = setTimeout(() => { rej(timeout(boundMs, phase)); if (onTimeout) onTimeout(); }, boundMs); });
    promise.catch(() => {}); // a late failure after the bound is not unhandled
    return Promise.race([promise, clock]).finally(() => clearTimeout(timer));
  };

  async function rerank({ query, docs, depth, boundMs } = {}) {
    if (typeof query !== 'string') throw err('E_ARGS', 'rerank needs a query string', { query: typeof query });
    if (!Array.isArray(docs) || docs.some(d => !d || typeof d.text !== 'string')) throw err('E_ARGS', 'rerank needs docs as [{ id, text }]', {});
    if (depth !== undefined && depth !== null && (!Number.isInteger(depth) || depth < 1)) throw err('E_ARGS', `rerank depth must be a positive integer, not ${JSON.stringify(depth)}`, { depth });
    if (boundMs !== undefined && boundMs !== null && !(Number.isFinite(boundMs) && boundMs > 0)) throw err('E_ARGS', `rerank boundMs must be a positive number, not ${JSON.stringify(boundMs)}`, { boundMs });
    const t0 = Date.now();
    const take = docs.slice(0, depth || docs.length);
    if (!take.length) return { scores: [], model, device: 'cpu', ms: 0 };
    const bound = boundMs || null;
    await within(ensure(), bound, 'loading the model', null);
    const mine = c;
    const left = bound ? Math.max(1, bound - (Date.now() - t0)) : null;
    const r = await within(mine.rank(model, query, take.map(d => d.text), { chunk }), left, 'ranking', () => { if (c === mine) abandon(); });
    const scores = take.map((d, i) => ({ id: d.id, score: r.scores[i], i })).sort((a, b) => b.score - a.score || a.i - b.i).map(({ id, score }) => ({ id, score }));
    const out = { scores, model, device: 'cpu', ms: Date.now() - t0 };
    if (r.truncated > 0) out.warnings = [{ code: 'RERANK_TRUNCATED', message: `${r.truncated} of ${take.length} pairs reached the model's ${r.max_length}-token limit (a longer pair is cut there)`, truncated: r.truncated, max_length: r.max_length }];
    return out;
  }
  rerank.model = model;
  rerank.close = async () => { abandon(); await Promise.all(closing); };
  return rerank;
}

module.exports = { CpuRerankClient, cpuRerankProvider, CHILD_ENV };
