'use strict';
// memory-render.cjs — argument parsing and text rendering for the `belay memory` verbs (ADR 0040 §5).
// Pure functions: nothing here opens a store, reads a file or prints. cmd-memory.cjs owns the calls.

const MODES = ['semantic', 'keyword', 'hybrid'];
const STATUSES = ['unverified', 'verified', 'refuted'];
const SCOPES = ['task', 'worker', 'run', 'namespace'];

// One row per flag: how many values it takes ('bool' none, 'one' a value, 'many' repeatable) and the
// key it fills. A verb lists the flags it accepts; any other flag is a usage error naming the verb.
const FLAGS = {
  '--mode': { key: 'mode', type: 'one' },
  '--index': { key: 'index', type: 'bool' },
  '--type': { key: 'types', type: 'many' },
  '--status': { key: 'status', type: 'one' },
  '--task': { key: 'task', type: 'one' },
  '--worker': { key: 'worker', type: 'one' },
  '--since': { key: 'since', type: 'one' },
  '--namespace': { key: 'namespaces', type: 'many' },
  '-k': { key: 'k', type: 'one' },
  '--limit': { key: 'limit', type: 'one' },
  '--offset': { key: 'offset', type: 'one' },
  '--before': { key: 'before', type: 'one' },
  '--after': { key: 'after', type: 'one' },
  '--scope': { key: 'scope', type: 'one' },
  '--receipt': { key: 'receipt', type: 'one' },
};

const FILTER_FLAGS = ['--type', '--status', '--task', '--worker', '--since', '--namespace'];

// positional: [min, max] counts.
const VERBS = {
  search: { flags: ['--mode', '--index', '-k', ...FILTER_FLAGS], positional: [1, 2], usage: 'belay memory search <query> [run-id] [--mode semantic|keyword|hybrid] [--index] [--type t]... [--status s] [--task id] [--worker id] [--since <ms|iso>] [--namespace ns]... [-k n]' },
  list: { flags: ['--index', '--limit', '--offset', ...FILTER_FLAGS], positional: [0, 1], usage: 'belay memory list [run-id] [--index] [--type t]... [--status s] [--task id] [--worker id] [--since <ms|iso>] [--namespace ns]... [--limit n] [--offset n]' },
  show: { flags: [], positional: [1, 50], usage: 'belay memory show <id>...' },
  timeline: { flags: ['--before', '--after', '--scope'], positional: [1, 1], usage: 'belay memory timeline <id> [--before n] [--after n] [--scope task|worker|run|namespace]' },
  verify: { flags: ['--status', '--receipt'], positional: [1, 1], usage: 'belay memory verify <id> --status verified|refuted|unverified --receipt <r>' },
  stats: { flags: [], positional: [0, 1], usage: 'belay memory stats [run-id]' },
};

function usageText() {
  const lines = Object.values(VERBS).map((v, i) => `${i ? '       ' : 'usage: '}${v.usage}`);
  return `${lines.join('\n')}\n       (every verb takes [--data <dir>] [--json])\n`;
}

const looksIso = v => v.indexOf('-', 1) !== -1 || v.includes('T');

// An integer epoch millisecond value, or an ISO 8601 timestamp Date.parse accepts; undefined otherwise.
function parseSince(v) {
  if (/^\d+$/.test(v)) { const n = Number(v); if (Number.isSafeInteger(n)) return n; }
  if (!looksIso(v)) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

function wholeNumber(name, v, min) {
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) < min) return { error: `${name} must be an integer of at least ${min}; got ${v}` };
  return { value: Number(v) };
}

function checkOpts(sub, opts) {
  if (opts.mode !== undefined && !MODES.includes(opts.mode)) return { error: `--mode must be one of ${MODES.join(', ')}; got ${opts.mode}` };
  if (opts.status !== undefined && !STATUSES.includes(opts.status)) return { error: `--status must be one of ${STATUSES.join(', ')}; got ${opts.status}` };
  if (opts.scope !== undefined && !SCOPES.includes(opts.scope)) return { error: `--scope must be one of ${SCOPES.join(', ')}; got ${opts.scope}` };
  if (opts.since !== undefined) {
    const ms = parseSince(opts.since);
    if (ms === undefined) return { error: `--since must be an integer epoch millisecond value or an ISO 8601 timestamp; got ${opts.since}` };
    opts.since_ms = ms;
  }
  const nums = [['k', '-k', 1], ['limit', '--limit', 1], ['offset', '--offset', 0], ['before', '--before', 0], ['after', '--after', 0]];
  for (const [key, name, min] of nums) {
    if (opts[key] === undefined) continue;
    const r = wholeNumber(name, opts[key], min);
    if (r.error) return r;
    opts[key] = r.value;
  }
  if (sub === 'verify') {
    if (opts.status === undefined) return { error: 'belay memory verify needs --status verified|refuted|unverified' };
    if (opts.receipt === undefined && opts.status !== 'unverified') return { error: 'belay memory verify needs --receipt <r>: a status without evidence is refused' };
  }
  return {};
}

// argv (after the command name) → { sub, positional, opts } or { error }.
function parseArgs(argv) {
  if (!argv.length) return { error: `belay memory needs a subcommand: ${Object.keys(VERBS).join(', ')}` };
  const sub = argv[0];
  const verb = VERBS[sub];
  if (!verb) return { error: `unknown memory subcommand ${sub}; expected ${Object.keys(VERBS).join(', ')}` };
  const opts = {};
  const positional = [];
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (typeof a === 'string' && a.startsWith('-') && a.length > 1) {
      const flag = FLAGS[a];
      if (!flag || !verb.flags.includes(a)) return { error: `unknown option ${a} for belay memory ${sub}` };
      if (flag.type === 'bool') { opts[flag.key] = true; continue; }
      const v = rest[i += 1];
      if (v === undefined) return { error: `${a} needs a value` };
      if (flag.type === 'many') (opts[flag.key] = opts[flag.key] || []).push(v);
      else opts[flag.key] = v;
      continue;
    }
    positional.push(a);
  }
  const [min, max] = verb.positional;
  if (positional.length < min || positional.length > max) {
    return { error: `belay memory ${sub} takes ${min === max ? min : `${min} to ${max}`} positional argument${max === 1 ? '' : 's'}; got ${positional.length}` };
  }
  const checked = checkOpts(sub, opts);
  if (checked.error) return checked;
  return { sub, positional, opts };
}

// The filter object of ADR 0040 §2: only the keys that were given.
function filterOf(opts) {
  const f = {};
  if (opts.types) f.types = opts.types;
  if (opts.status) f.statuses = [opts.status];
  if (opts.task) f.task_id = opts.task;
  if (opts.worker) f.worker_id = opts.worker;
  if (opts.since_ms !== undefined) f.since_ms = opts.since_ms;
  return f;
}

const one = s => String(s == null ? '' : s).replace(/\s+/g, ' ');
const dash = v => (v === null || v === undefined || v === '' ? '-' : String(v));

function table(cols, rows) {
  const cells = rows.map(r => cols.map(c => c.cell(r)));
  const widths = cols.map((c, i) => Math.max(c.head.length, ...cells.map(row => row[i].length)));
  const line = vals => vals.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  return [line(cols.map(c => c.head)), ...cells.map(line)];
}

const COL = {
  score: { head: 'score', cell: r => (typeof r.score === 'number' ? r.score.toFixed(4) : '-') },
  dup: { head: 'near_duplicate', cell: r => dash(r.near_duplicate) },
  status: { head: 'status', cell: r => dash(r.status || 'unverified') },
  id: { head: 'id', cell: r => dash(r.id) },
  namespace: { head: 'namespace', cell: r => dash(r.namespace) },
  worker: { head: 'worker_id', cell: r => dash(r.worker_id) },
  task: { head: 'task_id', cell: r => dash(r.task_id) },
  type: { head: 'type', cell: r => dash(r.type) },
  created: { head: 'created_at', cell: r => dash(r.created_at) },
  title: { head: 'title', cell: r => one(r.title == null ? r.text : r.title).slice(0, 80) || '-' },
  text: { head: 'text', cell: r => one(r.text).slice(0, 80) },
};

function rowCols(view, scored) {
  const lead = scored ? [COL.score, COL.dup] : [];
  return view === 'index'
    ? [...lead, COL.status, COL.id, COL.namespace, COL.worker, COL.task, COL.type, COL.title]
    : [...lead, COL.status, COL.id, COL.namespace, COL.worker, COL.type, COL.text];
}

// The warning, when there is one, is the first line of the text, as it is the first key of the JSON.
function renderSearchText(r, view) {
  const out = [];
  if (r.warning) out.push(r.warning);
  const results = r.results || [];
  if (!results.length) out.push(r.note ? r.note : '(no results)');
  else out.push(...table(rowCols(view, true), results), '');
  const tail = [`scanned: ${dash(r.scanned)}`, `model: ${dash(r.model)}`, `dim: ${dash(r.dim)}`];
  if (Array.isArray(r.modes_run)) tail.push(`modes_run: ${r.modes_run.join(',') || '-'}`);
  if (typeof r.absence_established === 'boolean') tail.push(`absence_established: ${r.absence_established}`);
  out.push(tail.join('  '));
  for (const f of r.modes_failed || []) out.push(`failed: ${f.mode} ${f.code}${f.message ? ` (${f.message})` : ''}`);
  return `${out.join('\n')}\n`;
}

function renderListText(r, view) {
  const rows = r.rows || [];
  if (!rows.length) return '(no rows)\n';
  return `${table(rowCols(view, false), rows).join('\n')}\n`;
}

// A full row per block: header fields, then the text as stored.
function renderShowText(r) {
  const out = [];
  for (const row of r.rows || []) {
    if (row.found === false) { out.push(`${row.id}  (not found)`, ''); continue; }
    out.push(`id: ${row.id}`, `title: ${dash(row.title)}`,
      `status: ${dash(row.status || 'unverified')}${row.status_receipt ? ` (receipt ${row.status_receipt})` : ''}`,
      `namespace: ${dash(row.namespace)}  type: ${dash(row.type)}  worker_id: ${dash(row.worker_id)}  task_id: ${dash(row.task_id)}  run_id: ${dash(row.run_id)}`,
      `source: ${dash(row.source)}  created_at: ${dash(row.created_at)}`, '', String(row.text == null ? '' : row.text), '');
  }
  if ((r.missing || []).length) out.push(`missing: ${r.missing.join(', ')}`);
  return `${out.join('\n')}\n`;
}

function renderTimelineText(r) {
  const cols = [COL.id, COL.status, COL.type, COL.worker, COL.task, COL.created, COL.title];
  const a = r.anchor || {};
  const mark = { ...a, title: `> ${one(a.title == null ? a.text : a.title).slice(0, 78)}` };
  const out = [`anchor: ${dash(a.id)}  scope: ${dash(r.scope)}  scope_key: ${dash(r.scope_key)}`, ''];
  out.push(...table(cols, [...(r.before || []), mark, ...(r.after || [])]));
  return `${out.join('\n')}\n`;
}

function renderVerifyText(r) {
  const was = r.previous_status ? ` (was ${r.previous_status})` : '';
  return `${r.id}: ${r.status}${was}  receipt: ${dash(r.status_receipt)}  by: ${dash(r.status_by)}\n`;
}

function renderStatsText(s) {
  const o = s.owner || {};
  const pairs = obj => Object.entries(obj).map(([k, v]) => `${k}=${v}`).join(' ') || '-';
  const lines = [`entries: ${s.n}  namespaces: ${s.namespaces}  workers: ${s.workers}  expired: ${s.expired}`];
  if (s.by_type) lines.push(`by_type: ${pairs(s.by_type)}`);
  if (s.by_status) lines.push(`by_status: ${pairs(s.by_status)}`);
  if (s.unembedded !== undefined) lines.push(`unembedded: ${s.unembedded}`);
  if (s.fts) lines.push(`fts: present=${s.fts.present} version=${dash(s.fts.version)} rows=${dash(s.fts.rows)}`);
  lines.push(`owner: alive=${o.alive} pid=${o.pid == null ? '-' : o.pid} established_by=${o.established_by}`, '');
  return lines.join('\n');
}

module.exports = {
  MODES, STATUSES, SCOPES, VERBS, parseArgs, parseSince, filterOf, usageText,
  renderSearchText, renderListText, renderShowText, renderTimelineText, renderVerifyText, renderStatsText,
};
