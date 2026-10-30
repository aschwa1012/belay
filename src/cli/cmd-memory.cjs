'use strict';
// cmd-memory.cjs — `belay memory search|list|show|timeline|verify|stats|export|import` (ADR 0040 §5, ADR 0043 §3).
// The read verbs, `export` among them, are mode R: they read state without writing anything and never
// `mkdir owner.lock`. `verify`, `import` and `embed` are mode W (they write rows, electing an owner on demand and
// shutting it down again; `embed --dry-run` only reads). Parsing and text
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
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('./config.cjs');
const { openCore } = require('../core/index.cjs');
const R = require('./memory-render.cjs');
const { SCHEMA_VERSION } = require('../core/schema-stamp.cjs');

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

// ---- export and import (ADR 0043 section 3) ----------------------------------------------------------------

const PAGE = 500; // memory.list's own page limit
const CHUNK = 50; // memory.get_many's id limit
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// Every row of list's pages, oldest first. The full view carries status, ttl_at and supersedes (its text is cut,
// which does not matter here: get_many gives each exported row whole).
async function listAll(core, args) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await core.memory.list({ ...args, order: 'oldest', limit: PAGE, offset });
    out.push(...page.rows);
    if (page.rows.length < PAGE || out.length >= page.total) break;
  }
  return out;
}

// The rows of the chosen namespaces, oldest first, in full and without vectors. By default only live rows go:
// a refuted, superseded or expired row is left out and counted, because an import writes every row it reads as
// a new unverified row with no supersedes link, which would bring a dead claim back as a live one. `--all`
// exports them too; import then skips the refuted and superseded ones itself.
async function exportRows(core, args, all) {
  const listed = await listAll(core, args);
  const skipped = { refuted: 0, superseded: 0, expired: 0 };
  let keep = listed;
  if (!all) {
    // Superseded by any row of its namespace, whether or not the filter selects the newer row.
    const every = args.filter ? await listAll(core, { ...args, filter: undefined }) : listed;
    const dead = new Set(every.filter(r => r.supersedes).map(r => `${r.namespace}\0${r.supersedes}`));
    const now = Date.now();
    keep = listed.filter((r) => {
      const why = r.status === 'refuted' ? 'refuted' : dead.has(`${r.namespace}\0${r.id}`) ? 'superseded' : r.ttl_at != null && r.ttl_at < now ? 'expired' : null;
      if (why) skipped[why] += 1;
      return !why;
    });
  }
  const ids = keep.map(r => r.id);
  const rows = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const got = await need(core, 'memory', 'get_many')({ ids: ids.slice(i, i + CHUNK) });
    for (const r of got.rows) {
      if (!r.found) continue; // deleted between the two calls
      const { found, has_embedding: _vec, ...row } = r;
      rows.push(row);
    }
  }
  return { rows, skipped };
}

async function doExport(core, parsed, ctx) {
  const { opts } = parsed;
  const { runId } = await resolveRunId(core, parsed.positional[0]);
  const args = namespaceArgs(opts, runId);
  const filter = R.filterOf(opts);
  if (Object.keys(filter).length) args.filter = filter;
  const { rows, skipped } = await exportRows(core, args, !!opts.all);
  // No clock in the header: the same rows export to the same bytes, so a seed file's hash is stable.
  const header = { export: 1, written_by: 'operator', schema_version: SCHEMA_VERSION, rows: opts.all ? 'all' : 'live', count: rows.length };
  const body = `${[header, ...rows].map(r => JSON.stringify(r)).join('\n')}\n`;
  if (!opts.out) return { code: 0, text: body, json: { header, rows, ...(opts.all ? {} : { skipped }) } };
  const out = path.resolve(ctx.cwd, opts.out);
  try {
    fs.writeFileSync(out, body, { flag: 'wx' }); // an export never overwrites a file
  } catch (e) {
    const exists = e.code === 'EEXIST';
    const message = exists ? `${out} exists; export never overwrites` : `cannot write ${out}: ${e.code || e.message}`;
    return { code: 1, text: `belay memory export: ${message}\n`, json: { error: { code: exists ? 'E_EXISTS' : e.code || 'E_INTERNAL', message } } };
  }
  const receipt = { out, count: rows.length, bytes: Buffer.byteLength(body), sha256: sha256(body), header, ...(opts.all ? {} : { skipped }) };
  const left = opts.all ? 0 : skipped.refuted + skipped.superseded + skipped.expired;
  const leftText = left ? `\nleft out ${left} row${left === 1 ? '' : 's'} that ${left === 1 ? 'is' : 'are'} not live: refuted ${skipped.refuted}, superseded ${skipped.superseded}, expired ${skipped.expired} (--all exports them)` : '';
  return { code: 0, text: `exported ${rows.length} row${rows.length === 1 ? '' : 's'} to ${out}  bytes: ${receipt.bytes}  sha256: ${receipt.sha256.slice(0, 12)}${leftText}\n`, json: receipt };
}

// The file, read and split before any store is opened: a file that cannot be read or is not an export
// elects no owner. A first line with an `export` key and no `text` is the header; a hand-written seed
// file has none.
function readImport(ctx, parsed) {
  const file = path.resolve(ctx.cwd, parsed.positional[0]);
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) {
    const message = `cannot read ${file}: ${e.code || e.message}`;
    return { fail: { code: 1, text: `belay memory import: ${message}\n`, json: { error: { code: e.code === 'ENOENT' ? 'E_NOT_FOUND' : e.code || 'E_INTERNAL', message } } } };
  }
  const items = [], refused = [];
  let header = null, lines = 0;
  const raw = buf.toString('utf8').split(/\r?\n/);
  for (let i = 0; i < raw.length; i += 1) {
    if (!raw[i].trim()) continue;
    const line = i + 1;
    let row;
    try { row = JSON.parse(raw[i]); } catch (e) { lines += 1; refused.push({ line, code: 'E_PARSE', message: e.message }); continue; }
    if (!header && !lines && row && typeof row === 'object' && row.export !== undefined && row.text === undefined) { header = row; continue; }
    lines += 1;
    items.push({ line, row });
  }
  const unnamed = unnamedNamespaces(items, parsed.opts);
  const bad = header && header.export !== 1 ? `unsupported export version ${JSON.stringify(header.export)}; this build reads 1`
    : header && header.schema_version > SCHEMA_VERSION ? `written at schema ${header.schema_version}, newer than this build's ${SCHEMA_VERSION}; upgrade belay`
      : unnamed.length ? `the file names namespace${unnamed.length === 1 ? '' : 's'} ${unnamed.join(', ')}, which no --namespace-map entry or --namespace names; an import writes only where the operator says (--namespace-map <from>=<to>)` : null;
  const fail = bad ? { code: 1, text: `belay memory import: ${file}: ${bad}\n`, json: { error: { code: 'E_ARGS', message: bad } } }
    : !lines ? { code: 1, text: `belay memory import: ${file} holds no rows\n`, json: { error: { code: 'E_ARGS', message: 'the file holds no rows' } } } : null;
  return { file, sha256: sha256(buf), header, items, refused, lines, fail };
}

const isStr = v => typeof v === 'string' && v.length > 0;

// Every namespace a line names must be named by the operator: by a --namespace-map entry (exactly, or as a prefix
// ending at a slash) or by --namespace itself. A file is a stranger's words, so it does not get to choose a live
// run's namespace or a project's on its own (ADR 0043 §3). Returns the namespaces nobody named, sorted.
function unnamedNamespaces(items, opts) {
  const map = opts.nsMap || new Map();
  const named = ns => (opts.namespaces || []).includes(ns) || map.has(ns) || [...map.keys()].some(from => ns.startsWith(`${from}/`));
  const out = new Set();
  for (const { row } of items) if (row && typeof row === 'object' && isStr(row.namespace) && !named(row.namespace)) out.add(row.namespace);
  return [...out].sort();
}

// One row's store arguments, or the reason it cannot be one. Status, ids, times, supersedes, ttl and the
// export's provenance fields are not carried: an imported row is a new row of this store, unverified until
// it is verified here. Its type is always 'imported' (the file's own type is kept in body.imported_type) and its
// source 'import', so no line of a file reaches the index or the corpus as a decision or a summary until someone
// verifies it here (ADR 0043 §3).
function importArgs(row, line, opts, sha) {
  const bad = (field, why) => ({ error: { code: 'E_ARGS', message: `${field} ${why}` } });
  if (!row || typeof row !== 'object' || Array.isArray(row)) return bad('the line', 'is not a JSON object');
  if (!isStr(row.text) || !row.text.trim()) return bad('text', 'must be a non-empty string');
  const ns = isStr(row.namespace) ? row.namespace : opts.namespaces && opts.namespaces[0];
  if (!ns) return bad('namespace', 'is missing and no --namespace default was given');
  if (row.type !== undefined && !isStr(row.type)) return bad('type', 'must be a non-empty string');
  if (row.title !== undefined && row.title !== null && typeof row.title !== 'string') return bad('title', 'must be a string');
  if (row.tags !== undefined && row.tags !== null && !(Array.isArray(row.tags) && row.tags.every(isStr))) return bad('tags', 'must be an array of strings');
  if (row.body !== undefined && row.body !== null && (typeof row.body !== 'object' || Array.isArray(row.body))) return bad('body', 'must be an object');
  const ref = isStr(row.id) && /^[A-Za-z0-9_.:-]{1,128}$/.test(row.id) ? row.id : `line-${line}`;
  const args = { namespace: R.mapNamespace(ns, opts.nsMap), text: row.text, type: 'imported', source: 'import', provenance: `import:${sha.slice(0, 12)}:${ref}` };
  for (const k of ['title', 'tags', 'body']) if (row[k] !== undefined && row[k] !== null) args[k] = row[k];
  if (row.type !== undefined) args.body = { ...(args.body || {}), imported_type: row.type };
  // The store now scrubs tags too, but an import file is untrusted input and the operator's import has no run lever. Each tag is
  // scrubbed here whatever the run lever, and a tag that held a secret is dropped rather than kept with a placeholder in it.
  if (args.tags) {
    const { redact } = require('../core/redact.cjs');
    args.tags = args.tags.map((t) => redact(t)).filter((r) => !Object.keys(r.redactions).length).map((r) => r.text);
    if (!args.tags.length) delete args.tags;
  }
  if (opts.noEmbed) args.embed = false;
  return { args };
}

// The rows of the file that are not live: refuted, or superseded by another row of the file in the same
// namespace. An imported row carries no status and no supersedes link, so either would come back live.
function deadInFile(items, opts) {
  const nsOf = row => (isStr(row.namespace) ? row.namespace : (opts.namespaces && opts.namespaces[0]) || '');
  const superseded = new Set();
  for (const { row } of items) if (row && isStr(row.supersedes)) superseded.add(`${nsOf(row)}\0${row.supersedes}`);
  return (row) => {
    if (!row || typeof row !== 'object') return null;
    if (row.status === 'refuted') return 'refuted';
    return isStr(row.id) && superseded.has(`${nsOf(row)}\0${row.id}`) ? 'superseded' : null;
  };
}

async function doImport(core, parsed, read) {
  const { opts } = parsed;
  const refused = [...read.refused];
  const rows = [];
  const skipped = { refuted: 0, superseded: 0 };
  let inserted = 0, updated = 0, unchanged = 0, statusIgnored = 0;
  const store = need(core, 'memory', 'store');
  const dead = deadInFile(read.items, opts);
  for (const { line, row } of read.items) {
    const why = dead(row);
    if (why) { skipped[why] += 1; continue; }
    const built = importArgs(row, line, opts, read.sha256);
    if (built.error) { refused.push({ line, ...built.error }); continue; }
    if (row.status && row.status !== 'unverified') statusIgnored += 1; // a status that would have meant something
    try {
      const stored = await store(built.args);
      if (stored.action === 'updated') updated += 1; else if (stored.action === 'unchanged') unchanged += 1; else inserted += 1;
      rows.push({ line, id: stored.id, action: stored.action, namespace: stored.namespace });
    } catch (e) {
      refused.push({ line, code: e.code || 'E_INTERNAL', message: e.message });
    }
  }
  refused.sort((a, b) => a.line - b.line);
  const result = { file: read.file, sha256: read.sha256, lines: read.lines, inserted, updated, unchanged, refused, skipped, status_ignored: statusIgnored, rows };
  return { code: refused.length ? 1 : 0, text: R.renderImportText(result), json: result };
}

const LC = require('./cmd-memory-lifecycle.cjs');
const VERB_FN = { ...LC.VERB_FN, embed: (...a) => require('./cmd-memory-embed.cjs').doEmbed(...a), export: doExport, import: doImport, search: doSearch, list: doList, show: doShow, timeline: doTimeline, verify: doVerify, stats: doStats };

function failure(sub, e) {
  const code = e.code || 'E_INTERNAL';
  if (sub === 'search' && code === 'E_NO_EMBEDDER') {
    const reason = 'memory search needs a live owner to embed the query; none answered, and a read never starts one';
    return { code: 1, text: `belay memory search: ${e.message}\n${reason}\n`, json: { error: { code, message: e.message }, reason } };
  }
  const detail = e.detail === undefined ? {} : { detail: e.detail };
  return { code: 1, text: `belay memory ${sub}: ${R.clean(e.message)} (${code})\n`, json: { error: { code, message: e.message, ...detail } } };
}

async function run(ctx) {
  const parsed = R.parseArgs(ctx.argv);
  if (parsed.error) return usageError(parsed.error);

  // An import reads its file first: a file that cannot be read, or is not an export, elects no owner.
  const read = parsed.sub === 'import' ? readImport(ctx, parsed) : null;
  if (read && read.fail) return read.fail;

  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);

  // Mode W for verify, as for `worker rm`: it never creates the data dir.
  if ((parsed.sub === 'verify' || parsed.sub === 'embed' || LC.writes(parsed)) && !fs.existsSync(dataDir)) {
    const message = `no such data dir: ${dataDir}`;
    return { code: 1, text: `belay memory ${parsed.sub}: ${message}\n`, json: { error: { code: 'E_NOT_FOUND', message } } };
  }
  // A verb that acts on rows already there finds none in a store that does not exist yet, so it is refused before an election would
  // create that store. import makes rows, and embed with nothing to embed is answered by the core. A test's injected core is its store.
  const injected = process.env.BELAY_TEST_MODE === '1' && typeof ctx.openCore === 'function';
  if (!injected && (parsed.sub === 'verify' || LC.writes(parsed)) && !fs.existsSync(path.join(dataDir, 'memory.db'))) {
    const message = `no store at ${dataDir}/memory.db, so there is no row to ${parsed.sub}; nothing was written`;
    return { code: 1, text: `belay memory ${parsed.sub}: ${message}\n`, json: { error: { code: 'E_NOT_FOUND', message } } };
  }

  // A test may hand in a fake core. Production always uses the real one.
  const open = injected ? ctx.openCore : openCore;
  const core = await open({ dataDir, caller: { role: 'operator', run_id: 'cli', pid: process.pid } });
  try {
    return await VERB_FN[parsed.sub](core, parsed, parsed.sub === 'import' ? read : ctx, found);
  } catch (e) {
    return failure(parsed.sub, e);
  } finally {
    // verify, import and embed may have won the election; the owner is shut down here so no owner.lock and no node
    // process outlives the command. A read verb never elects, so this is a no-op on their paths.
    if ((parsed.sub === 'verify' || parsed.sub === 'import' || parsed.sub === 'embed' || LC.writes(parsed)) && typeof core.isOwner === 'function' && core.isOwner()) {
      try { await require('./release-owner.cjs').releaseOwnerOf(core); } catch { /* best effort */ }
    }
    await core.close();
  }
}

module.exports = { run };
