'use strict';
// cmd-usage.cjs — `belay usage [run-id] [--by task|worker|model|turn] [--json]` (ADR 0041 section 6).
// Mode R: it reads the per-turn usage ledger through usage.list and starts no process. A store written
// before the ledger existed has no usage table; the core says so (table_absent) and this prints it, rather
// than a zero that would read as "cost nothing".
//
// Dollars are only comparable when every turn's cost has one meaning. A Codex turn reports no dollars
// (cost_basis 'none', cost_usd null), so a group that mixes the two is marked "partial" and its total is
// the priced turns only. A null cost prints as "-", never 0.
//
// Exit codes: 0 when the ledger was read (empty or not), 1 when the core refused, 2 for a usage error.

const C = require('./config.cjs');
const { openCore } = require('../core/index.cjs');

const BY = ['task', 'worker', 'model', 'turn'];
const USAGE = 'usage: belay usage [run-id] [--by task|worker|model|turn] [--data <dir>] [--json]\n';

function usageError(message) {
  return { code: 2, text: `belay usage: ${message}\n\n${USAGE}`, json: { error: message } };
}

function parseArgs(argv) {
  const rest = [];
  let by;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--by') {
      by = argv[i += 1];
      if (by === undefined) return { error: '--by needs a value' };
      if (!BY.includes(by)) return { error: `--by must be one of ${BY.join(', ')}; got ${by}` };
    } else if (typeof a === 'string' && a.startsWith('-') && a.length > 1) {
      return { error: `unknown option ${a}` };
    } else rest.push(a);
  }
  if (rest.length > 1) return { error: `belay usage takes zero or one argument, a run id; got ${rest.length}` };
  if (rest.length === 1 && rest[0] === '') return { error: 'the run id is an empty string' };
  return { runId: rest[0], by };
}

const dash = v => (v === null || v === undefined || v === '' ? '-' : String(v));
const dollars = v => (typeof v === 'number' ? `$${v.toFixed(4)}` : '-');

function table(cols, rows) {
  const cells = rows.map(r => cols.map(c => c.cell(r)));
  const widths = cols.map((c, i) => Math.max(c.head.length, ...cells.map(row => row[i].length)));
  const line = vals => vals.map((v, i) => (cols[i].right ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join('  ').trimEnd();
  return [line(cols.map(c => c.head)), ...cells.map(line)];
}

const num = f => ({ head: f.replace(/_tokens$/, '').replace('_', ' '), right: true, cell: r => String(r[f] == null ? 0 : r[f]) });

function groupText(by, result) {
  const cols = [
    { head: by, cell: r => dash(r.key) }, { head: 'turns', right: true, cell: r => String(r.turns) },
    num('input_tokens'), num('output_tokens'), num('cache_read_tokens'), num('cache_creation_tokens'),
    { head: 'cost', right: true, cell: r => `${dollars(r.cost_usd)}${r.cost_basis_mixed ? ' partial' : ''}` },
  ];
  return table(cols, [...result.groups, { ...result.totals, key: 'total' }]);
}

function rowText(result) {
  const cols = [
    { head: 'worker_id', cell: r => dash(r.worker_id) }, { head: 'task_id', cell: r => dash(r.task_id) },
    { head: 'turn', right: true, cell: r => dash(r.turn) }, { head: 'model', cell: r => dash(r.model) },
    num('input_tokens'), num('output_tokens'), num('cache_read_tokens'), num('cache_creation_tokens'),
    { head: 'cost', right: true, cell: r => dollars(r.cost_usd) }, { head: 'basis', cell: r => dash(r.cost_basis) },
  ];
  const t = { ...result.totals, key: 'total' };
  const total = { worker_id: 'total', turn: t.turns, ...t, cost_basis: t.cost_basis_mixed ? 'partial' : '' };
  return table(cols, [...result.rows, total]);
}

function render(runId, by, result) {
  const head = `run: ${dash(runId)}${by ? `  by: ${by}` : ''}`;
  if (result.table_absent) return `${head}\nno usage table in this store: no ledger has been written here\n`;
  const empty = by ? !result.groups.length : !result.rows.length;
  if (empty) return `${head}\n(no usage rows)\n`;
  const lines = by ? groupText(by, result) : rowText(result);
  const mixed = result.totals.cost_basis_mixed ? ['partial: some turns reported no dollars (Codex); their cost is missing from the total, not zero'] : [];
  return `${[head, ...lines, ...mixed].join('\n')}\n`;
}

async function run(ctx) {
  const parsed = parseArgs(ctx.argv);
  if (parsed.error) return usageError(parsed.error);
  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);
  const open = process.env.BELAY_TEST_MODE === '1' && typeof ctx.openCore === 'function' ? ctx.openCore : openCore;
  const core = await open({ dataDir, caller: { role: 'operator', run_id: 'cli', pid: process.pid } });
  try {
    let runId = parsed.runId;
    let source = runId ? 'argument' : 'none';
    if (!runId) {
      const { runs } = await core.run.list({});
      const chosen = runs.find(r => r.alive) || runs[0];
      if (chosen) { runId = chosen.id; source = 'run.list'; }
    }
    const args = {};
    if (runId) args.run_id = runId;
    if (parsed.by) args.group_by = parsed.by;
    const result = await core.usage.list(args);
    return { code: 0, text: render(runId, parsed.by, result), json: { run_id: runId || null, run_id_source: source, ...result } };
  } catch (e) {
    const code = e.code || 'E_INTERNAL';
    const detail = e.detail === undefined ? {} : { detail: e.detail };
    return { code: 1, text: `belay usage: ${e.message} (${code})\n`, json: { error: { code, message: e.message, ...detail } } };
  } finally {
    await core.close();
  }
}

module.exports = { run, parseArgs };
