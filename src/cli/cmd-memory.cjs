'use strict';
// cmd-memory.cjs — `belay memory search|list|show|timeline|verify|stats` (ADR 0040 §5). The read verbs
// are mode R: they read state without writing anything and never `mkdir owner.lock`. `verify` is mode W
// (it sets a row's status, electing an owner on demand and shutting it down again). Parsing and text
// rendering live in memory-render.cjs; this file makes the core calls and maps outcomes to exit codes.
//
// A semantic or hybrid search needs a live owner to embed the query (api.md §3, invariant 9: "no read
// path may import the embedding library"). A keyword search needs no embedder and answers from the copy
// when there is no owner. A search that cannot run in the mode asked for says so: nothing here turns a
// refusal into an empty result.
//
// Exit codes: 0 when the verb did what it was asked, even partly (a hybrid search whose semantic half
// failed); 1 when no search mode ran, an id is missing, or the core refused; 2 for a usage error.

const fs = require('node:fs');
const C = require('./config.cjs');
const { openCore } = require('../core/index.cjs');
const R = require('./memory-render.cjs');

function usageError(message) {
  return { code: 2, text: `belay memory: ${message}\n\n${R.usageText()}`, json: { error: message } };
}

async function resolveRunId(core, argRunId) {
  if (argRunId) return { runId: argRunId, runIdSource: 'argument' };
  const { runs } = await core.run.list({});
  if (!runs.length) return { runId: null, runIdSource: 'none' };
  const chosen = runs.find(r => r.alive) || runs[0];
  return { runId: chosen.id, runIdSource: 'run.list' };
}

// Namespaces default exactly as the core would default them (run/<run_id>), for the chosen run; a
// --namespace flag, repeatable, replaces the default.
function namespaceArgs(opts, runId) {
  if (opts.namespaces && opts.namespaces.length === 1) return { namespace: opts.namespaces[0] };
  if (opts.namespaces) return { namespaces: opts.namespaces };
  return runId ? { namespace: `run/${runId}` } : {};
}

// Method names that a build without this ADR's core work does not have yet fail by name, not as a
// TypeError.
function need(core, group, name) {
  if (!core[group] || typeof core[group][name] !== 'function') {
    const e = new Error(`this build's core has no ${group}.${name}`);
    e.code = 'E_INTERNAL';
    throw e;
  }
  return core[group][name];
}

async function doSearch(core, parsed) {
  const { opts } = parsed;
  const { runId, runIdSource } = await resolveRunId(core, parsed.positional[1]);
  const args = { query: parsed.positional[0], ...namespaceArgs(opts, runId) };
  if (opts.k != null) args.k = opts.k;
  if (opts.mode) args.mode = opts.mode;
  if (opts.index) args.view = 'index';
  const filter = R.filterOf(opts);
  if (Object.keys(filter).length) args.filter = filter;
  const result = await core.memory.search(args);
  // The warning stays the first key of the JSON, as the core put it first in its result.
  const { warning, ...rest } = result;
  const json = { ...(warning !== undefined ? { warning } : {}), run_id: runId, run_id_source: runIdSource, ...rest };
  const noneRan = Array.isArray(result.modes_run) && result.modes_run.length === 0;
  return { code: noneRan ? 1 : 0, text: R.renderSearchText(result, opts.index ? 'index' : 'full'), json };
}

async function doList(core, parsed) {
  const { opts } = parsed;
  const { runId, runIdSource } = await resolveRunId(core, parsed.positional[0]);
  const args = { ...namespaceArgs(opts, runId) };
  if (opts.limit != null) args.limit = opts.limit;
  if (opts.offset != null) args.offset = opts.offset;
  if (opts.index) args.view = 'index';
  const filter = R.filterOf(opts);
  if (Object.keys(filter).length) args.filter = filter;
  const result = await core.memory.list(args);
  return { code: 0, text: R.renderListText(result, opts.index ? 'index' : 'full'), json: { run_id: runId, run_id_source: runIdSource, ...result } };
}

async function doShow(core, parsed) {
  const result = await need(core, 'memory', 'get_many')({ ids: parsed.positional });
  const missing = result.missing || [];
  const text = R.renderShowText(result);
  if (!missing.length) return { code: 0, text, json: result };
  const named = `belay memory show: ${missing.length} id${missing.length === 1 ? '' : 's'} not found: ${missing.join(', ')}\n`;
  return { code: 1, text: `${text}${named}`, json: result };
}

async function doTimeline(core, parsed) {
  const { opts } = parsed;
  const args = { anchor_id: parsed.positional[0] };
  if (opts.before != null) args.before = opts.before;
  if (opts.after != null) args.after = opts.after;
  if (opts.scope) args.scope = opts.scope;
  const result = await need(core, 'memory', 'timeline')(args);
  return { code: 0, text: R.renderTimelineText(result), json: result };
}

async function doVerify(core, parsed) {
  const { opts } = parsed;
  const args = { id: parsed.positional[0], status: opts.status };
  if (opts.receipt !== undefined) args.receipt = opts.receipt;
  const result = await need(core, 'memory', 'setStatus')(args);
  return { code: 0, text: R.renderVerifyText(result), json: result };
}

async function doStats(core) {
  const stats = await core.memory.stats({});
  // `ownerFact()` (src/core/engine.cjs) writes "this process holds the lock (in-process)" for the process
  // that is the owner. This CLI process never elects (mode R), so whenever a live owner answers
  // `memory.stats` over the pipe, that wording reaches a process it was never true for. Relabel it here
  // so the words this CLI prints are honest about what it observed.
  if (stats.owner && stats.owner.established_by === 'this process holds the lock (in-process)') {
    stats.owner = { ...stats.owner, established_by: `owner pid ${stats.owner.pid} answered this request over the pipe (this CLI process is not the owner)` };
  }
  return { code: 0, text: R.renderStatsText(stats), json: stats };
}

const VERB_FN = { search: doSearch, list: doList, show: doShow, timeline: doTimeline, verify: doVerify, stats: doStats };

function failure(sub, e) {
  const code = e.code || 'E_INTERNAL';
  if (sub === 'search' && code === 'E_NO_EMBEDDER') {
    const reason = 'memory search needs a live owner to embed the query; none answered, and a read never starts one';
    return { code: 1, text: `belay memory search: ${e.message}\n${reason}\n`, json: { error: { code, message: e.message }, reason } };
  }
  const detail = e.detail === undefined ? {} : { detail: e.detail };
  return { code: 1, text: `belay memory ${sub}: ${e.message} (${code})\n`, json: { error: { code, message: e.message, ...detail } } };
}

async function run(ctx) {
  const parsed = R.parseArgs(ctx.argv);
  if (parsed.error) return usageError(parsed.error);

  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);

  // Mode W for verify, as for `worker rm`: it never creates the data dir.
  if (parsed.sub === 'verify' && !fs.existsSync(dataDir)) {
    const message = `no such data dir: ${dataDir}`;
    return { code: 1, text: `belay memory verify: ${message}\n`, json: { error: { code: 'E_NOT_FOUND', message } } };
  }

  // A test may hand in a fake core. Production always uses the real one.
  const open = process.env.BELAY_TEST_MODE === '1' && typeof ctx.openCore === 'function' ? ctx.openCore : openCore;
  const core = await open({ dataDir, caller: { role: 'operator', run_id: 'cli', pid: process.pid } });
  try {
    return await VERB_FN[parsed.sub](core, parsed);
  } catch (e) {
    return failure(parsed.sub, e);
  } finally {
    // verify may have won the election; its owner is shut down here so no owner.lock and no node
    // process outlives the command. A read verb never elects, so this is a no-op on their paths.
    if (parsed.sub === 'verify' && typeof core.isOwner === 'function' && core.isOwner()) {
      try { await core.shutdownOwner(); } catch { /* best effort */ }
    }
    await core.close();
  }
}

module.exports = { run };
