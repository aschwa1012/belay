#!/usr/bin/env node
// belay-mcp.cjs — the MCP stdio adapter, one process per orchestrator session and one per worker.
// Identity is built from argv once, at startup, into `caller`, and handed to openCore. Nothing in any
// request can change it (ADR 0010 §1, invariant 3). `initialize` is answered without touching the
// store, because Claude Code and Codex block on it; the core is opened lazily on the first tool call
// and the run manager is created lazily on the first worker tool. An orchestrator adapter settles the
// epoch with run.attach before it answers its first tool call about a store that already exists, so
// `status` never reports the previous epoch's rows as current (see settleEpoch).
//
// Usage: node belay-mcp.cjs --role orchestrator|worker --run <id> --data <dir>
//                           [--worker-id <id>] [--no-embed] [--log <file>]
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { toolsFor, routeOf, allows, roleOf, validateArgs, PERMIT_TOOL } = require('./tools.cjs');
const { createPermit } = require('./permit.cjs');
const { createLogWriter } = require('./log-writer.cjs');
// build step 6c: the worker adapter's own pipe, always the real implementation (never swapped by
// BELAY_FAKE_CORE, which only ever stands in for src/core and src/run/manager.cjs) — it touches
// nothing but net and src/core/lock.cjs, so it costs a worker-role adapter nothing on its own read
// path either.
const { createWorkerControl } = require('../run/control.cjs');
const { createKnowledgeGate } = require('./knowledge-gate.cjs');
const { withDataNotice } = require('./data-notice.cjs'); // invariant 8: a result that holds a note names itself data
const { parseArgv, die } = require('./argv.cjs'); // identity from argv only; moved out to keep this file short

const SERVER_NAME = 'belay';
const SERVER_VERSION = '0.2.0';
const DEFAULT_PROTOCOL = '2025-06-18';

const opts = parseArgv(process.argv.slice(2));
const CALLER = Object.freeze({
  role: opts.role,
  ...(opts.workerId ? { worker_id: opts.workerId } : {}),
  run_id: opts.runId,
  pid: process.pid,
});

// ---------------------------------------------------------------- wire log

const wlog = createLogWriter(opts.logFile); // bounded, asynchronous: src/mcp/log-writer.cjs


const send = (o) => {
  const s = JSON.stringify(o);
  wlog('>>', s);
  process.stdout.write(`${s}\n`);
};

// ---------------------------------------------------------------- lazy core and run manager

// BELAY_FAKE_CORE is honoured only when set, and only names a module exporting the same shape as
// src/core/index.cjs (openCore, and optionally createRunManager). It exists so the tool routing can be
// driven without a store; nothing reads it in production.
const REPO_TESTS = `${path.resolve(__dirname, '..', '..').split('\\').join('/')}/tests/`;

// Test-only injection points, both resolved at module load so a bad value fails before a client ever
// connects, and neither able to change role, worker id or run id. BELAY_FAKE_CORE is additionally
// confined to this repo's own tests/ directory: the variable is inherited by every child process, so
// without the guard a stray value anywhere up the tree would silently replace src/core in a
// production worker adapter.
const fakePath = (() => {
  const raw = process.env.BELAY_FAKE_CORE;
  if (!raw) return null;
  const resolved = path.resolve(raw).split('\\').join('/');
  if (!resolved.startsWith(REPO_TESTS)) die(`BELAY_FAKE_CORE must name a fixture under ${REPO_TESTS}, got ${resolved}`);
  return resolved;
})();

const FAKE_PATHS = (() => {
  const raw = process.env.BELAY_FAKE_PATHS;
  if (!raw) return {};
  let v;
  try { v = JSON.parse(raw); } catch (e) { return die(`BELAY_FAKE_PATHS is not valid JSON: ${e.message}`); }
  // A scalar or an array parses but would spread into nothing, so the run manager would silently get
  // the host binaries instead of the fixtures a test named. Both malformed shapes fail at startup.
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return die(`BELAY_FAKE_PATHS must be a JSON object of path overrides, got ${Array.isArray(v) ? 'an array' : typeof v}`);
  }
  return v;
})();
const coreModule = () => (fakePath ? require(path.resolve(fakePath)) : require('../core/index.cjs'));
const runModule = () => {
  if (fakePath) {
    const m = require(path.resolve(fakePath));
    if (m.createRunManager) return m;
  }
  return require('../run/index.cjs');
};

let core = null;
let corePromise = null;
let runManager = null;
let workerControl = null;
let runPromise = null;
let attachPromise = null;
let ATTACH = null;

// ADR 0045 decision 2: the session key the owner handed this adapter at its bind. Memory only: never a file, the environment, a log or argv.
let BIND_KEY = null;

function openCoreOnce() {
  if (!corePromise) {
    corePromise = Promise.resolve()
      .then(() => coreModule().openCore({ dataDir: opts.dataDir, caller: CALLER, embed: opts.embed, ...(BIND_KEY ? { key: BIND_KEY } : {}) }))
      .then((c) => { core = c; return c; })
      .catch((e) => { corePromise = null; throw e; });
  }
  return corePromise;
}

// build step 6d, ADR 0020 decision 1: only when launched with --permit; otherwise 'permit' is refused.
const permit = opts.permit ? createPermit({ openCore: openCoreOnce, caller: CALLER, waitMs: opts.permitWaitMs, log: wlog }) : null;

const ownCreatedNow = opts.role !== 'worker' ? require('../core/proc-identity.cjs').ownCreatedProbe(process.pid) : async () => null; // ADR 0039
function attachOnce(c) {
  if (!attachPromise) {
    attachPromise = ownCreatedNow().then((adapter_pid_created) => c.run.attach({ adapter_pid: process.pid, adapter_pid_created, orchestrator_pid: process.ppid }))
      .then((att) => {
        // Invariant 5 applied to the adapter's own calls: attach can declare workers dead, and a
        // reattach that did so silently would be a state change nobody can see. Recorded on both
        // channels, and kept for status to carry.
        ATTACH = att;
        const dead = (att && att.workers_marked_dead) || [];
        const line = `run.attach epoch=${att && att.epoch} reattached=${att && att.reattached} `
          + `workers_marked_dead=${dead.length}${dead.length ? ` [${dead.join(', ')}]` : ''}`;
        wlog('##', line);
        process.stderr.write(`belay-mcp: ${line}\n`);
        return att;
      })
      .catch((e) => { attachPromise = null; throw e; });
  }
  return attachPromise;
}

const storeExists = () => {
  try { return fs.statSync(`${opts.dataDir}/memory.db`).isFile(); } catch { return false; }
};
// ADR 0043 decision 1: knowledge_ask is listed only when the run's knowledge_agent lever is on.
// ADR 0041/0043: the run row this adapter's own run.attach returned carries the memory levers, so neither the
// gate (once attached) nor the run manager reads them again: a run at the defaults makes no extra core call.
const attachedRun = () => (ATTACH && ATTACH.run) || null;
const knowledgeListed = createKnowledgeGate({ role: opts.role, runId: opts.runId, storeExists, openCore: openCoreOnce, log: wlog, attachedRun });

// ADR 0009 promises that a new orchestrator session reconstructs the run from the store, and
// `run.attach` is that reconstruction: it opens the next epoch and supersedes every worker row the
// previous epoch left in starting or running whose pid is gone (ADR 0011 §1, methods-run.cjs). While
// it has not run, `status` answers out of the previous epoch: honest, because every such worker
// carries `pid_alive: false`, but not reconciled, and with no `attach` for the session to notice by.
// Attaching only when a worker tool was called meant the reconstruction waited on a call the session
// might never make, so the first thing an operator asks showed last session's rows as current.
//
// The rule now: the orchestrator adapter settles the epoch before it answers anything about a store
// that already exists, and never brings a store into being to answer a question about one that is not
// there. A read against an absent data dir still writes nothing and still answers `stopped`
// (invariant 6, api.md §4). Best effort on the read path: a store that cannot be attached to must not
// take `status` down with it, because a dead system is a valid answer (ADR 0010 §2). A call that
// genuinely needs the run manager attaches unconditionally and propagates the real error.
async function settleEpoch(c) {
  if (opts.role !== 'orchestrator' || ATTACH || !storeExists()) return c;
  try {
    await attachOnce(c);
  } catch (e) {
    const line = `run.attach failed, so the epoch is not settled: ${e && e.message}`;
    wlog('!!', line);
    process.stderr.write(`belay-mcp: ${line}\n`);
  }
  return c;
}

// build step 6c, design item 1: the control is created right after createRunManager resolves and its
// listen() is awaited before this promise resolves, so a listen() rejection rejects openRunManagerOnce
// itself — the tool call that needed the manager fails naming it, and no worker is ever spawned that
// the operator could not reach (`r.spawn` runs only after a caller already has the manager in hand).
function openRunManagerOnce() {
  if (!runPromise) {
    runPromise = openCoreOnce()
      .then((c) => attachOnce(c).then(() => c))
      .then((c) => runModule().createRunManager({
        // ADR 0044 decision 6: the run manager writes memory on the harness channel, the tool router on the tool one.
        // A fixture core has no channel to give.
        core: typeof c.harness === 'function' ? c.harness() : c,
        dataDir: opts.dataDir,
        runId: opts.runId,
        // api.md §1: paths = { mcpBinary? }, defaulting to src/mcp/belay-mcp.cjs resolved from src/run.
        // This process is that binary, so its own path is the authoritative answer and keeps working
        // if belay is installed or run from another checkout, where the default would guess wrong.
        // BELAY_FAKE_PATHS, honoured only when set, merges over it so a test can point the run
        // manager at a fake substrate binary without touching the environment the workers inherit.
        agentDefaults: opts.agentDefaults || null, // the config's agents block, resolved by belay run
        compactAtTokens: opts.compactAt, worktree: opts.worktree || null, // ADR 0007 decision 3; ADR 0043 decision 1
        memoryLevers: attachedRun() ? require('../run/memory-levers.cjs').leversOfRow(attachedRun()) : null,
        paths: { mcpBinary: __filename.split(path.sep).join('/'), ...FAKE_PATHS },
      }))
      .then(async (r) => {
        const control = createWorkerControl({ dataDir: opts.dataDir, manager: r });
        await control.listen();
        runManager = r;
        workerControl = control;
        const line = `worker control pipe=${control.pipe} pid=${process.pid}`;
        wlog('##', line);
        process.stderr.write(`belay-mcp: ${line}\n`);
        return r;
      })
      .catch((e) => { runPromise = null; throw e; });
  }
  return runPromise;
}

// The contract names Core methods with dots. Whether the module hangs them off nested namespaces
// (core.memory.store), flat dotted keys or camelCase is not stated, so all three are accepted and a
// method that is genuinely absent fails loudly with E_INTERNAL naming it.
function resolveCoreMethod(c, dotted) {
  const parts = dotted.split('.');
  let owner = c;
  let cur = c;
  for (const p of parts) {
    if (cur == null) { cur = undefined; break; }
    owner = cur;
    cur = cur[p];
  }
  if (typeof cur === 'function') return cur.bind(owner);
  if (typeof c[dotted] === 'function') return c[dotted].bind(c);
  const camel = parts[0] + parts.slice(1).map((s) => s[0].toUpperCase() + s.slice(1)).join('');
  if (typeof c[camel] === 'function') return c[camel].bind(c);
  return null;
}

const fail = (code, message, detail) => {
  const e = new Error(message);
  e.code = code;
  if (detail !== undefined) e.detail = detail;
  return e;
};

async function callCore(dotted, args) {
  const c = await settleEpoch(await openCoreOnce());
  const fn = resolveCoreMethod(c, dotted);
  if (!fn) throw fail('E_INTERNAL', `the core exposes no method ${dotted}`, { method: dotted });
  return fn(args);
}

async function callTool(name, args) {
  const route = routeOf(name);
  if (!route) throw fail('E_ARGS', `no such tool ${name}`, { tool: name });
  let notesOn = opts.role === 'worker' ? !!opts.notes : false;
  // Only these two tools differ in a notes run; any other call must not cause the read of the run row (the attach row answers once the manager has attached).
  if (opts.role === 'orchestrator' && (name === 'memory_verify' || name === 'memory_store')) { await knowledgeListed(); notesOn = knowledgeListed.notes(); }
  if (opts.role === 'orchestrator' && notesOn && name === 'memory_verify') {
    throw fail('E_ROLE', 'memory_verify is not available in a notes run: dispute a note with memory_report (it holds the note for the archive review)', { tool: name, role: opts.role });
  }
  if (!allows(opts.role, name, opts.workerId, { notes: notesOn })) {
    throw fail('E_ROLE', `${name} is not available in ${opts.role} role; it belongs to ${roleOf(name)}`, { tool: name, role: opts.role });
  }
  validateArgs(name, args, { notes: notesOn, role: opts.role });
  // ADR 0057 decision 1: a model's search answers the compact view unless it asks for debug or index; the Core API's default stays full.
  if (name === 'memory_search' && args && typeof args === 'object' && args.view === undefined) args = { ...args, view: 'compact' };
  if (route.via === 'core') {
    const row = withDataNotice(route.method, await callCore(route.method, args));
    // The one place the adapter adds to a row, and it is additive: every field of the core's
    // status.get row (api.md §4) passes through untouched. run.attach happens inside the adapter, so
    // its result reaches no tool of its own, and a reattach that declared workers dead would
    // otherwise be invisible to the session that caused it. Absent until the adapter has attached,
    // so its presence is itself the fact that an attach happened.
    if (name === 'status' && ATTACH && row && typeof row === 'object' && !Array.isArray(row)) {
      return { ...row, attach: { reattached: ATTACH.reattached, workers_marked_dead: ATTACH.workers_marked_dead } };
    }
    return row;
  }
  if (route.via === 'briefing') {
    const [line, doc] = await Promise.all([callCore('continuity.resumeLine', args), callCore('continuity.resumeDoc', args)]);
    return { line, doc };
  }
  if (route.via === 'run') {
    const r = await openRunManagerOnce();
    if (typeof r[route.method] !== 'function') throw fail('E_INTERNAL', `the run manager exposes no method ${route.method}`, { method: route.method });
    // ADR 0048: a restart must answer inside MCP_TOOL_TIMEOUT (120 s); it may spend 100 s, then returns early (manager.restart).
    if (name === 'worker_restart') return r[route.method]({ ...args, mcp_budget_ms: RESTART_MCP_BUDGET_MS });
    return r[route.method](args);
  }
  throw fail('E_INTERNAL', `tool ${name} has no route`, { tool: name });
}

// ---------------------------------------------------------------- result envelope (ADR 0010 §6)

const text = (v) => ({ type: 'text', text: JSON.stringify(v) });

function okResult(row) {
  // Every row passes through unchanged. MCP requires structuredContent to be an object; the contract
  // returns an object from every method, so the guard below should never fire.
  const structured = (row !== null && typeof row === 'object' && !Array.isArray(row)) ? row : { result: row };
  return { content: [text(structured)], structuredContent: structured, isError: false };
}

// api.md §6. A code from this set passes through unchanged; anything else (a MODULE_NOT_FOUND, a
// TypeError) becomes E_INTERNAL, because the orchestrator is entitled to a code it can act on and the
// contract names the whole vocabulary. The set is the core's own, not a copy of it: a hand-kept copy
// here silently downgraded E_DEPENDENCY_OPEN to E_INTERNAL the day the core gained it, and A4 was the
// thing that caught it. `errors.cjs` imports nothing, so this costs the read path nothing (api.md §4).
const { CODES } = require('../core/errors.cjs');

function errResult(e) {
  const original = e && e.code;
  const code = CODES.has(original) ? original : 'E_INTERNAL';
  const body = { error: code, message: e && e.message ? e.message : String(e) };
  const mapped = code === 'E_INTERNAL' && original && original !== 'E_INTERNAL';
  if (mapped) {
    // The original code is the only thing that says what actually went wrong, so it survives every
    // branch: with no detail, with an object detail whose own fields are kept beside it, and with a
    // scalar or array detail, which is nested under `detail` because it has no fields to merge into.
    // `underlying_code` is written last so a detail carrying that name cannot displace the truth.
    const d = e && e.detail;
    const carried = d !== undefined && d !== null && typeof d === 'object' && !Array.isArray(d)
      ? d
      : (d !== undefined ? { detail: d } : {});
    body.detail = { ...carried, underlying_code: original };
  } else if (e && e.detail !== undefined) {
    body.detail = e.detail;
  }
  return { content: [text(body)], structuredContent: body, isError: true };
}

// ---------------------------------------------------------------- request loop

async function handle(msg) {
  const { id, method, params } = msg || {};
  if (method === 'initialize') {
    // Answered without opening the store: the client blocks here and the data dir must stay untouched.
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
  }
  // build step 6d: the substrate's own cancellation for an in-flight permit call, ahead of the
  // generic notifications/* passthrough below.
  if (method === 'notifications/cancelled' && permit) {
    const requestId = params && params.requestId;
    await permit.cancel(requestId);
    return undefined;
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) return undefined;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') {
    const knowledge = await knowledgeListed(); // the one read of the run row; the notes lever comes from it
    const list = toolsFor(opts.role, { knowledge, workerId: opts.workerId, notes: opts.role === 'worker' ? opts.notes : knowledgeListed.notes(), queries: knowledgeListed.queries() }).concat(opts.permit ? [PERMIT_TOOL] : []);
    return send({ jsonrpc: '2.0', id, result: { tools: list } });
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name === 'permit') {
      if (!permit) return send({ jsonrpc: '2.0', id, result: errResult(fail('E_ARGS', 'this adapter was not launched with --permit')) });
      // The permit's own answer is the measured shape, written as is, never through okResult. A null
      // answer means the call was cancelled; nothing is sent for it.
      const result = await permit.call(args, id);
      if (result === null) return undefined;
      return send({ jsonrpc: '2.0', id, result });
    }
    try {
      const row = await callTool(name, args);
      return send({ jsonrpc: '2.0', id, result: okResult(row) });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: errResult(e) });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  return undefined;
}

// BELAY_KEEPALIVE_TICK_MS (a positive integer) overrides the 60 s tick of the lease keepalive; a test hook (ADR 0026).
const keepalive = opts.role !== 'worker' ? null : require('./lease-keepalive.cjs').createKeepalive({
  call: callCore, workerId: opts.workerId, log: wlog, tickMs: Number(process.env.BELAY_KEEPALIVE_TICK_MS) });
let buf = '';
wlog('##', `start role=${opts.role} run=${opts.runId} worker=${opts.workerId || '-'} data=${opts.dataDir}`);

// ADR 0045 decision 2: with --bind the adapter claims its identity BEFORE it reads a byte of MCP, so `initialize` is answered only by a
// bound adapter. The bind pipe's answer must agree with argv; anything else (no listener, a second claim, a different identity) ends this
// process before the session sees a server, which Claude Code reports as belay not connected, and the launch is refused.
function startServing() {
  if (keepalive) keepalive.start();
  process.stdin.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    // Each request is handled as its own promise and never awaited here, so a worker_spawn that takes
    // seconds cannot stop the loop from answering status (ADR 0010 consequences).
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      wlog('<<', line);
      let m;
      try { m = JSON.parse(line); } catch { wlog('!!', 'unparseable line'); continue; }
      handle(m).catch((e) => process.stderr.write(`belay-mcp: handler error: ${e && e.message}\n`));
    }
  });
}

if (!opts.bind) startServing();
else {
  require('../core/bind.cjs').claimBind(opts.bind).then((b) => {
    const c = b.caller || {};
    if (!require('../core/bind.cjs').identityMatchesArgv(c, opts)) {
      throw Object.assign(new Error(`the bind names ${JSON.stringify(c)}, which is not this adapter's argv identity`), { code: 'E_BIND' });
    }
    BIND_KEY = b.key;
    wlog('##', `bound bind_id=${b.bind_id}`);
    startServing();
  }).catch((e) => {
    wlog('!!', `bind failed: ${e && e.message}`);
    process.stderr.write(`belay-mcp: ${e && e.code ? e.code + ': ' : ''}${e && e.message}\n`);
    wlog.flushSync();
    process.exit(3);
  });
}

let closing = false;
const RESTART_MCP_BUDGET_MS = 100000;

async function shutdown() {
  if (closing) return;
  closing = true;
  wlog('##', 'stdin end');
  if (keepalive) keepalive.stop();
  let failed = false;
  try {
    // A run manager still being created is about to own worker processes, so it is waited for rather
    // than skipped: taking the core-only branch here would exit while a spawn produces a worker
    // nobody will ever stop.
    if (runPromise && !runManager) {
      try { await runPromise; } catch { /* creation failed; there is nothing to stop */ }
    }
    if (runManager) {
      // build step 6c: the control closes first, so no worker.stop/restart/message verb can land
      // during teardown once the graceful stop of every worker below has begun.
      if (workerControl) {
        try { await workerControl.close(); } catch { /* best effort */ }
        workerControl = null;
      }
      // Graceful stop of every worker, then core.shutdownOwner(). Never a signal.
      const res = await runManager.shutdown({});
      const stopped = (res && res.stopped) || [];
      // A verdict drain that was cut off or failed is named here (the review tasks still pending and what became of the receipt), never dropped.
      const vd = res && res.verdict_drain;
      const drainText = vd ? ` verdict_drain=[pending ${(vd.pending || []).join(', ') || 'none'}; receipt ${vd.receipt === 'written' ? 'written' : (vd.receipt && vd.receipt.error) || 'none'}${vd.error ? `; error ${vd.error}` : ''}]` : '';
      const line = `shutdown stopped=${stopped.length}${stopped.length ? ` [${stopped.join(', ')}]` : ''} ms=${res && res.ms}${drainText}`;
      wlog('##', line);
      process.stderr.write(`belay-mcp: ${line}\n`);
    } else if (core) {
      if (typeof core.isOwner === 'function' && core.isOwner()) await core.shutdownOwner();
      await core.close();
    }
  } catch (e) {
    // A parent that could not stop its workers has not succeeded, and must not say it did.
    process.stderr.write(`belay-mcp: shutdown error: ${e && e.message}\n`);
    failed = true;
  }
  await wlog.drain(); // the append in flight must land before the process goes (src/mcp/log-writer.cjs)
  process.exit(failed ? 1 : 0);
}

process.stdin.on('end', () => { shutdown(); });
process.stdin.on('close', () => { shutdown(); });
process.on('exit', (c) => { wlog('##', `exit ${c}`); wlog.flushSync(); });
