'use strict';
// cmd-memory.cjs — build step 4b, design item 2, amended by
// the brief's B2: the search table names the fields a result row has, and the three outcomes of a
// search. Mode R: read state without writing anything, never `mkdir owner.lock`.
//
// A search needs a live owner to embed the query (api.md §3, invariant 9: "no read path may import the
// embedding library"). The copy fallback has no embedder, so a search against a dead store is refused,
// honestly, rather than silently returning nothing — and this CLI process itself never embeds.

const C = require('./config.cjs');
const { openCore } = require('../core/index.cjs');

function usageError(message) {
  return {
    code: 2,
    text: `belay memory: ${message}\n\n`
      + 'usage: belay memory search <query> [--namespace <ns>] [-k <n>] [run-id] [--data <dir>] [--json]\n'
      + '       belay memory stats [run-id] [--data <dir>] [--json]\n',
    json: { error: message },
  };
}

function parseArgs(argv) {
  if (!argv.length) return { error: 'belay memory needs a subcommand: search or stats' };
  const sub = argv[0];
  if (sub !== 'search' && sub !== 'stats') return { error: `unknown memory subcommand ${sub}; expected search or stats` };
  const rest = argv.slice(1);
  let namespace = null, k = null;
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--namespace') { namespace = rest[i += 1]; if (namespace === undefined) return { error: '--namespace needs a value' }; continue; }
    if (a === '-k') {
      const v = rest[i += 1];
      if (v === undefined) return { error: '-k needs a value' };
      k = Number(v);
      if (!Number.isFinite(k)) return { error: '-k must be a number' };
      continue;
    }
    if (typeof a === 'string' && a.startsWith('-')) return { error: `unknown option ${a}` };
    positional.push(a);
  }
  if (sub === 'search') {
    if (!positional.length) return { error: 'belay memory search needs a query string' };
    if (positional.length > 2) return { error: `belay memory search takes a query and an optional run id; got ${positional.length} positional arguments` };
    return { sub, query: positional[0], namespace, k, runId: positional[1] };
  }
  if (positional.length > 1) return { error: `belay memory stats takes zero or one argument, a run id; got ${positional.length}` };
  return { sub, runId: positional[0] };
}

// B2: "score, near_duplicate, id, namespace, worker_id, type, text" plus scanned/model/dim; an empty
// results with a note prints the note.
function renderSearchText(r) {
  if (!r.results.length) {
    const note = r.note ? `${r.note}\n` : '(no results)\n';
    return `${note}scanned: ${r.scanned}  model: ${r.model || '-'}  dim: ${r.dim || '-'}\n`;
  }
  const cols = ['score', 'near_duplicate', 'id', 'namespace', 'worker_id', 'type', 'text'];
  const cell = (row, c) => {
    if (c === 'score') return row.score.toFixed(4);
    if (c === 'text') return String(row.text == null ? '' : row.text).replace(/\s+/g, ' ').slice(0, 80);
    return row[c] === null || row[c] === undefined ? '-' : String(row[c]);
  };
  const rows = r.results.map(row => cols.map(c => cell(row, c)));
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map(row => row[i].length)));
  const line = vals => vals.map((v, i) => v.padEnd(widths[i])).join('  ');
  const lines = [line(cols), ...rows.map(line), '', `scanned: ${r.scanned}  model: ${r.model}  dim: ${r.dim}`, ''];
  return lines.join('\n');
}

function renderStatsText(s) {
  const o = s.owner || {};
  return [
    `entries: ${s.n}  namespaces: ${s.namespaces}  workers: ${s.workers}  expired: ${s.expired}`,
    `owner: alive=${o.alive} pid=${o.pid == null ? '-' : o.pid} established_by=${o.established_by}`,
    '',
  ].join('\n');
}

async function resolveRunId(core, argRunId) {
  if (argRunId) return { runId: argRunId, runIdSource: 'argument' };
  const { runs } = await core.run.list({});
  if (!runs.length) return { runId: null, runIdSource: 'none' };
  const chosen = runs.find(r => r.alive) || runs[0];
  return { runId: chosen.id, runIdSource: 'run.list' };
}

async function run(ctx) {
  const parsed = parseArgs(ctx.argv);
  if (parsed.error) return usageError(parsed.error);

  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);

  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: parsed.runId || 'cli', pid: process.pid } });
  try {
    const { runId, runIdSource } = await resolveRunId(core, parsed.runId);
    if (parsed.sub === 'stats') {
      const stats = await core.memory.stats({});
      // The reviewer's should-fix finding: `ownerFact()` (src/core/engine.cjs, not owned by this step)
      // writes "this process holds the lock (in-process)" for the process that IS the owner. This CLI
      // process never elects (mode R), so whenever a live owner answers `memory.stats` over the pipe,
      // that wording reaches a process it was never true for. Relabel it here, in the owned file, since
      // engine.cjs is out of scope and the words this CLI prints must be honest about what it observed.
      if (stats.owner && stats.owner.established_by === 'this process holds the lock (in-process)') {
        stats.owner = { ...stats.owner, established_by: `owner pid ${stats.owner.pid} answered this request over the pipe (this CLI process is not the owner)` };
      }
      return { code: 0, text: renderStatsText(stats), json: stats };
    }
    // B2: namespace defaults exactly as the core would default it (run/<run_id>), for the chosen run.
    const namespace = parsed.namespace || (runId ? `run/${runId}` : undefined);
    const args = { query: parsed.query };
    if (namespace) args.namespace = namespace;
    if (parsed.k != null) args.k = parsed.k;
    const result = await core.memory.search(args);
    const json = { run_id: runId, run_id_source: runIdSource, ...result };
    return { code: 0, text: renderSearchText(result), json };
  } catch (e) {
    const code = e.code || 'E_INTERNAL';
    if (parsed.sub === 'search' && code === 'E_NO_EMBEDDER') {
      const reason = 'memory search needs a live owner to embed the query; none answered, and a read never starts one';
      return { code: 1, text: `belay memory search: ${e.message}\n${reason}\n`, json: { error: { code, message: e.message }, reason } };
    }
    return { code: 1, text: `belay memory: ${e.message}\n`, json: { error: { code, message: e.message } } };
  } finally {
    await core.close();
  }
}

module.exports = { run };
