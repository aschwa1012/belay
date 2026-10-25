'use strict';
// memory-render.cjs — argument parsing and text rendering for the `belay memory` verbs (ADR 0040 §5, ADR 0043 §3).
// Pure functions: nothing here opens a store, reads a file or prints. cmd-memory.cjs owns the calls.
//
// Every value a row holds reaches the terminal through panel-common's sanitiser (P.clean): a title or a text is
// model-written, and an escape sequence in it (a screen clear, an OSC 8 link) would otherwise act on the terminal.

const P = require('./panel-common.cjs');

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
  '--out': { key: 'out', type: 'one' },
  '--namespace-map': { key: 'namespaceMaps', type: 'many' },
  '--no-embed': { key: 'noEmbed', type: 'bool' },
  '--all': { key: 'all', type: 'bool' },
  '--reason': { key: 'reason', type: 'one' },
  '--ids': { key: 'ids', type: 'one' },
  '--older-than': { key: 'olderThan', type: 'one' },
  '--confirm': { key: 'confirm', type: 'bool' },
  '--project': { key: 'project', type: 'one' },
  '--run': { key: 'run', type: 'one' },
  '--worktree': { key: 'worktree', type: 'one' },
  '--start': { key: 'start', type: 'bool' },
  '--goal': { key: 'goal', type: 'one' },
  '--summary': { key: 'summary', type: 'one' },
  '--evidence': { key: 'evidence', type: 'one' },
  '--dry-run': { key: 'dryRun', type: 'bool' },
  '--reembed': { key: 'reembed', type: 'bool' },
  '--template': { key: 'template', type: 'one' },
  '--candidates': { key: 'candidates', type: 'bool' },
  '--approve': { key: 'approve', type: 'bool' },
  '--reject': { key: 'reject', type: 'bool' },
  '--awaiting': { key: 'awaiting', type: 'bool' },
  '--if-awaiting': { key: 'ifAwaiting', type: 'bool' },
  '--archive': { key: 'archive', type: 'bool' },
  '--release': { key: 'release', type: 'bool' },
  '--reoffer': { key: 'reoffer', type: 'bool' },
  '--replaced-by': { key: 'replacedBy', type: 'one' },
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
  export: { flags: ['--namespace', '--since', '--out', '--all'], positional: [0, 1], usage: 'belay memory export [run-id] [--namespace ns]... [--since <ms|iso>] [--out <file>] [--all]' },
  embed: { flags: ['--project', '--dry-run', '--reembed', '--template'], positional: [0, 0], usage: 'belay memory embed [--project <p>] [--dry-run] | belay memory embed --reembed --template v2 [--project <p>] [--dry-run]' },
  import: { flags: ['--namespace-map', '--namespace', '--no-embed'], positional: [1, 1], usage: 'belay memory import <file> [--namespace-map from=to]... [--namespace ns] [--no-embed]' },
  proposals: { flags: ['--project', '--all'], positional: [0, 0], usage: 'belay memory proposals [--project p] [--all]' },
  restore: { flags: ['--reason', '--candidates'], positional: [1, 1], usage: 'belay memory restore <id> --reason <text>   |   belay memory restore <id> --candidates' },
  scrub: { flags: ['--run', '--worktree', '--goal', '--summary'], positional: [0, 0], usage: 'belay memory scrub [--run <id>] [--worktree <dir>] [--goal <text>] [--summary <text>]' },
  review: { flags: ['--run', '--project', '--worktree', '--all', '--start'], positional: [0, 0], usage: 'belay memory review [--project <p>] [--all] [--run <id>] [--worktree <dir>] [--start]' },
  resolve: { flags: ['--evidence'], positional: [2, 3], usage: 'belay memory resolve <id> new   |   belay memory resolve <id> repeats <of>   |   belay memory resolve <id> supersedes <of> --evidence <text>' },
  promote: { flags: ['--approve', '--reject', '--reason'], positional: [1, 1], usage: 'belay memory promote <note-id> (--approve | --reject) [--reason <text>]' },
  held: { flags: ['--project', '--awaiting', '--archive', '--release', '--reoffer', '--reason', '--if-awaiting'], positional: [0, 2], usage: 'belay memory held [--project p] [--awaiting]   |   belay memory held settle <note-id> (--archive | --release | --reoffer) --reason <text> [--if-awaiting]' },
  report: { flags: ['--reason', '--replaced-by'], positional: [1, 1], usage: 'belay memory report <note-id> --reason <text> [--replaced-by <note-id>]' },
  archive: { flags: ['--ids', '--older-than', '--confirm', '--project'], positional: [1, 1], usage: 'belay memory archive purge (--ids a,b | --older-than <days>) --confirm [--project p]' },
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

// archive purge: exactly one selector, and --confirm. The sub-subcommand is the positional (checked by the caller).
function checkPurge(opts) {
  if ((opts.ids === undefined) === (opts.olderThan === undefined)) return { error: 'belay memory archive purge takes --ids a,b or --older-than <days>, one of them' };
  if (opts.ids !== undefined) {
    opts.idList = opts.ids.split(',').map(s => s.trim()).filter(Boolean);
    if (!opts.idList.length) return { error: '--ids needs at least one note id' };
  } else {
    const days = Number(opts.olderThan);
    if (!/^\d+(\.\d+)?$/.test(opts.olderThan) || !Number.isFinite(days)) return { error: `--older-than must be a number of days; got ${opts.olderThan}` };
    opts.days = days;
  }
  if (!opts.confirm) return { error: 'belay memory archive purge removes rows for good: pass --confirm' };
  return {};
}

// resolve <id> new | repeats <of> | supersedes <of> --evidence <text>: the shape memory.noteResolve takes, checked before any store is opened.
function checkResolve(opts, positional) {
  const [, how, of] = positional;
  if (!['new', 'repeats', 'supersedes', 'refines'].includes(how)) return { error: `belay memory resolve takes new, repeats <of>, refines <of> or supersedes <of>; got ${how}` };
  if (how === 'new' && of !== undefined) return { error: 'belay memory resolve <id> new takes no other note id' };
  if (how !== 'new' && of === undefined) return { error: `belay memory resolve <id> ${how} needs the id of the live note it ${how}` };
  if (how === 'supersedes' && !(typeof opts.evidence === 'string' && opts.evidence.trim())) return { error: 'belay memory resolve <id> supersedes needs --evidence <text>: what you saw that makes the older note wrong' };
  if (how !== 'supersedes' && how !== 'refines' && opts.evidence !== undefined) return { error: `belay memory resolve <id> ${how} takes no --evidence (only supersedes and refines do)` };
  return {};
}

// held (the listing) or held settle <note-id> (--archive | --release | --reoffer) --reason <text>: checked before any store is opened.
function checkHeld(opts, positional) {
  const actions = ['archive', 'release', 'reoffer'].filter((a) => opts[a]);
  if (positional[0] === undefined) {
    if (opts.ifAwaiting) return { error: 'belay memory held lists the held notes; --if-awaiting belongs to belay memory held settle <note-id>' };
    if (actions.length || opts.reason !== undefined) return { error: 'belay memory held lists the held notes; --archive, --release, --reoffer and --reason belong to belay memory held settle <note-id>' };
    return {};
  }
  if (positional[0] !== 'settle') return { error: `belay memory held takes no argument but settle <note-id>; got ${positional[0]}` };
  if (positional[1] === undefined) return { error: 'belay memory held settle needs the note id' };
  if (opts.awaiting) return { error: 'belay memory held settle takes no --awaiting' };
  if (actions.length !== 1) return { error: 'belay memory held settle needs exactly one of --archive, --release or --reoffer' };
  if (!(typeof opts.reason === 'string' && opts.reason.trim())) return { error: 'belay memory held settle needs --reason <text>: it is recorded' };
  opts.action = actions[0];
  return {};
}

// report <note-id> --reason <text> [--replaced-by <note-id>]: a note is reported with a reason, which is recorded.
function checkReport(opts) {
  if (!(typeof opts.reason === 'string' && opts.reason.trim())) return { error: 'belay memory report needs --reason <text>: it is recorded on the note and shown to the archive review' };
  if (opts.replacedBy !== undefined && !opts.replacedBy.trim()) return { error: '--replaced-by needs a note id' };
  return {};
}

function checkOpts(sub, opts, positional = []) {
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
  if (opts.project !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(opts.project)) return { error: `--project must be a project name (lower-case letters, digits, dot, dash, underscore; at most 64); got ${opts.project}` };
  if (opts.out !== undefined && !opts.out) return { error: '--out needs a file name' };
  if (sub === 'import') {
    const maps = new Map();
    for (const m of opts.namespaceMaps || []) {
      const eq = m.indexOf('=');
      if (eq < 1 || eq === m.length - 1) return { error: `--namespace-map must be from=to with both sides non-empty; got ${m}` };
      const from = m.slice(0, eq);
      if (maps.has(from)) return { error: `--namespace-map names ${from} twice` };
      maps.set(from, m.slice(eq + 1));
    }
    opts.nsMap = maps;
    if (opts.namespaces && opts.namespaces.length > 1) return { error: 'belay memory import takes one --namespace, the default for rows that carry none' };
  }
  if (sub === 'restore' && !opts.candidates && !opts.reason) return { error: 'belay memory restore needs --reason <text> (or --candidates to list the archived duplicates of a note)' };
  if (sub === 'report') return checkReport(opts);
  if (sub === 'resolve') return checkResolve(opts, positional);
  if (sub === 'held') return checkHeld(opts, positional);
  if (sub === 'promote' && !!opts.approve === !!opts.reject) return { error: 'belay memory promote needs exactly one of --approve or --reject' };
  if (sub === 'archive') return checkPurge(opts);
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
  const checked = checkOpts(sub, opts, positional);
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

const CAP = 1e6; // the sanitiser's code-point cap; the table cuts its own cells
const one = s => P.clean(s == null ? '' : s, CAP).replace(/\s+/g, ' ');
const dash = v => (v === null || v === undefined || v === '' ? '-' : P.clean(v, CAP));
// A text shown whole keeps its lines and their leading indentation; each line is sanitised on its own.
const block = s => String(s == null ? '' : s).split(/\r\n|\r|\n/).map((l) => {
  const lead = /^ */.exec(l)[0];
  return lead + P.clean(l.slice(lead.length), CAP);
}).join('\n');

function table(cols, rows) {
  const cells = rows.map(r => cols.map(c => c.cell(r)));
  const widths = cols.map((c, i) => Math.max(c.head.length, ...cells.map(row => row[i].length)));
  const line = vals => vals.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  return [line(cols.map(c => c.head)), ...cells.map(line)];
}

const COL = {
  score: { head: 'score', cell: r => (typeof r.score === 'number' ? r.score.toFixed(4) : '-') },
  dup: { head: 'near_duplicate', cell: r => dash(r.near_duplicate) },
  status: { head: 'status', cell: r => dash(r.status || 'unverified') + (r.held ? ` held:${r.held.kind || '?'}` : '') },
  id: { head: 'id', cell: r => dash(r.id) },
  namespace: { head: 'namespace', cell: r => dash(r.namespace) },
  worker: { head: 'worker_id', cell: r => dash(r.worker_id) },
  task: { head: 'task_id', cell: r => dash(r.task_id) },
  type: { head: 'type', cell: r => dash(r.type) + (r.body && typeof r.body.kind === 'string' ? `/${r.body.kind}` : '') },
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

// The line above a search's results when a mode did not run, naming what ran and what failed: "keyword matches only" is true
// only when the keyword half did run.
function searchBanner(r) {
  const failed = r.modes_failed || [];
  if (!failed.length) return null;
  const ran = Array.isArray(r.modes_run) ? r.modes_run : null;
  const named = failed.map(f => `${f.mode} (${f.code})`).join(' and ');
  if (ran !== null && ran.length === 0) {
    return `*** NO SEARCH MODE RAN (${named} failed): nothing was searched, so an empty list says nothing about whether such a memory exists ***`;
  }
  if (ran === null || ran.includes('keyword')) {
    return failed.some(f => f.mode === 'semantic') ? '*** SEMANTIC SEARCH DID NOT RUN: these are keyword matches only, and an empty list does not mean there is no such memory ***' : null;
  }
  return `*** ${named} failed; only ${ran.join(', ')} ran, so an empty list does not mean there is no such memory ***`;
}

// The warning, when there is one, is the first line of the text, as it is the first key of the JSON.
function renderSearchText(r, view) {
  const out = [];
  if (r.warning) out.push(r.warning); // the warning stays the first line
  const banner = searchBanner(r);
  if (banner) out.push(banner);
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
      `source: ${dash(row.source)}  written_by: ${row.written_by == null ? 'unknown' : row.written_by}  created_at: ${dash(row.created_at)}`, '', block(row.text), '');
  }
  if ((r.missing || []).length) out.push(`missing: ${r.missing.map(dash).join(', ')}`);
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

// The namespace a row lands in: an exact match in the map, else the longest mapped prefix (`from/`), else
// the row's own. Pure, so the table of cases is testable without a store.
function mapNamespace(ns, map) {
  if (map.has(ns)) return map.get(ns);
  let best = null;
  for (const from of map.keys()) if (ns.startsWith(`${from}/`) && (best === null || from.length > best.length)) best = from;
  return best === null ? ns : `${map.get(best)}${ns.slice(best.length)}`;
}

function renderImportText(r) {
  const ignored = r.status_ignored ? `  status ignored on ${r.status_ignored} row${r.status_ignored === 1 ? '' : 's'} (imported rows are unverified)` : '';
  const out = [`file: ${r.file}  sha256: ${r.sha256.slice(0, 12)}  lines: ${r.lines}`,
    `inserted: ${r.inserted}  updated: ${r.updated}${r.unchanged ? `  unchanged: ${r.unchanged}` : ''}  refused: ${r.refused.length}${ignored}`];
  const sk = r.skipped || {};
  if (sk.refuted || sk.superseded) out.push(`skipped (not live in the file): refuted ${sk.refuted || 0}, superseded ${sk.superseded || 0}`);
  for (const x of r.refused) out.push(`refused line ${x.line}: ${x.code}${x.message ? ` (${P.clean(x.message, 300)})` : ''}`);
  return `${out.join('\n')}\n`;
}

function renderStatsText(s) {
  const o = s.owner || {};
  const pairs = obj => Object.entries(obj).map(([k, v]) => `${P.clean(k, 80)}=${v}`).join(' ') || '-';
  const lines = [`entries: ${s.n}  namespaces: ${s.namespaces}  workers: ${s.workers}  expired: ${s.expired}`];
  if (s.by_type) lines.push(`by_type: ${pairs(s.by_type)}`);
  if (s.by_status) lines.push(`by_status: ${pairs(s.by_status)}`);
  if (s.unembedded !== undefined) lines.push(`unembedded: ${s.unembedded}`);
  if (s.fts) lines.push(`fts: present=${s.fts.present} version=${dash(s.fts.version)} rows=${dash(s.fts.rows)}`);
  lines.push(`owner: alive=${o.alive} pid=${o.pid == null ? '-' : o.pid} established_by=${o.established_by}`, '');
  return lines.join('\n');
}

module.exports = {
  MODES, STATUSES, SCOPES, VERBS, parseArgs, clean: (s) => P.clean(s, 2000), parseSince, filterOf, usageText,
  mapNamespace, renderSearchText, renderListText, renderShowText, renderTimelineText, renderVerifyText, renderStatsText,
  renderImportText,
};
