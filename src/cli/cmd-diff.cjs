'use strict';
// cmd-diff.cjs — build step 4c, design item 4. Mode R:
// read state without writing anything, never `mkdir owner.lock`. core.store.diff() does the work; this
// file only resolves the run and the mark, and renders the result.

const C = require('./config.cjs');
const { openCore } = require('../core/index.cjs');

const ORCH_TABLES = ['run', 'worker', 'task', 'lease', 'checkpoint'];

function usageError(message) {
  return {
    code: 2,
    text: `belay diff: ${message}\n\nusage: belay diff [run-id] [--since <ts>] [--all] [--data <dir>] [--json]\n`,
    json: { error: message },
  };
}

function parseArgs(argv) {
  let since = null, all = false;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') { all = true; continue; }
    if (a === '--since') { since = argv[i += 1]; if (since === undefined) return { error: '--since needs a value' }; continue; }
    if (typeof a === 'string' && a.startsWith('-')) return { error: `unknown option ${a}` };
    rest.push(a);
  }
  if (rest.length > 1) return { error: `belay diff takes zero or one argument, a run id; got ${rest.length}` };
  return { runId: rest[0], since, all };
}

// A '-' anywhere but as a leading sign, or a 'T', is what marks a string as meant to be an ISO 8601
// timestamp rather than a number Date.parse would otherwise parse leniently (Date.parse('-5') and
// Date.parse('1.5') both return a real, silent 2001 timestamp).
function looksIso(v) { return v.indexOf('-', 1) !== -1 || v.includes('T'); }

// Exactly one of a non-negative integer of digits (epoch milliseconds) or an ISO 8601 timestamp
// Date.parse accepts. Returns undefined on anything else — 1.5, -5, 1e22, a bare word — so the caller
// turns that into a usage error rather than a silent or wrongly-typed mark.
function parseSince(v) {
  if (/^\d+$/.test(v)) { const n = Number(v); if (Number.isFinite(n) && Number.isInteger(n)) return n; }
  if (!looksIso(v)) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

function descriptorOf(table, row) {
  if (table === 'run') return `epoch ${row.epoch}`;
  if (table === 'lease') return `holder ${row.holder}`;
  if (table === 'checkpoint') return `source ${row.source}`;
  return `state ${row.state}`; // worker, task
}

function orchLines(table, tables) {
  const rowsOut = [
    ...tables[table].added.map(r => ({ ...r, _cls: 'added' })),
    ...tables[table].updated.map(r => ({ ...r, _cls: 'updated' })),
  ].sort((a, b) => a.seq - b.seq);
  return rowsOut.map(r => {
    const supersedes = r.supersedes_seq != null ? ` supersedes seq ${r.supersedes_seq}` : '';
    return `${r._cls} seq ${r.seq} id ${r.id} ${descriptorOf(table, r)} written_at ${r.written_at} by ${r.written_by}${supersedes}`;
  });
}

function memLines(tables) {
  const rowsOut = [
    ...tables.memory.added.map(r => ({ ...r, _cls: 'added' })),
    ...tables.memory.updated.map(r => ({ ...r, _cls: 'updated' })),
    ...tables.memory.superseded.map(r => ({ ...r, _cls: 'superseded' })),
    ...tables.memory.expired.map(r => ({ ...r, _cls: 'expired' })),
  ];
  return rowsOut.map(r => {
    const text60 = String(r.text == null ? '' : r.text).replace(/\s+/g, ' ').slice(0, 60);
    return `${r._cls} ${r.id} ${r.namespace} ${r.worker_id} ${text60}`;
  });
}

function renderText(result, sinceMs) {
  const total = Object.values(result.counts).reduce((s, c) => s + Object.values(c).reduce((a, b) => a + b, 0), 0);
  if (total === 0) return `(no changes since ${sinceMs})\n`;
  const lines = [];
  for (const t of ORCH_TABLES) {
    const c = result.counts[t];
    lines.push(`${t}: ${c.added} added, ${c.updated} updated`);
    lines.push(...orchLines(t, result.tables));
  }
  const mc = result.counts.memory;
  lines.push(`memory: ${mc.added} added, ${mc.updated} updated, ${mc.superseded} superseded, ${mc.expired} expired`);
  lines.push(...memLines(result.tables));
  lines.push('');
  return lines.join('\n');
}

async function run(ctx) {
  const parsed = parseArgs(ctx.argv);
  if (parsed.error) return usageError(parsed.error);
  let sinceMs = null;
  if (parsed.since != null) {
    sinceMs = parseSince(parsed.since);
    if (sinceMs === undefined) return usageError(`--since must be an integer epoch millisecond value or an ISO 8601 timestamp; got ${parsed.since}`);
  }

  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);

  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: parsed.runId || 'cli', pid: process.pid } });
  try {
    const { runs } = await core.run.list({});
    let runId = null, runIdSource, sinceSource;

    if (parsed.all) {
      runIdSource = 'all';
      if (sinceMs == null) { sinceMs = 0; sinceSource = 'epoch'; } else sinceSource = 'argument';
    } else {
      let chosen = null;
      if (parsed.runId) {
        runId = parsed.runId; runIdSource = 'argument';
        chosen = runs.find(r => r.id === parsed.runId) || null;
      } else if (runs.length) {
        chosen = runs.find(r => r.alive) || runs[0];
        runId = chosen.id; runIdSource = 'run.list';
      } else {
        runIdSource = 'none';
      }
      if (sinceMs == null) {
        if (chosen) { sinceMs = chosen.started_at; sinceSource = 'run started_at'; }
        else { sinceMs = 0; sinceSource = 'epoch'; }
      } else sinceSource = 'argument';
    }

    const result = await core.store.diff(parsed.all ? { since_ms: sinceMs } : { since_ms: sinceMs, run_id: runId });
    const receipt = { ...result, run_id_source: runIdSource, since_source: sinceSource };
    return { code: 0, text: renderText(result, sinceMs), json: receipt };
  } catch (e) {
    const detail = { code: e.code || 'E_INTERNAL', message: e.message };
    return { code: 1, text: `belay diff: ${e.message}\n`, json: { error: detail } };
  } finally {
    await core.close();
  }
}

module.exports = { run };
