'use strict';
// cmd-tasks.cjs — build step 4b, design item 1, amended by
// the brief's B1: the table shows the core's own fields and does no CLI arithmetic. Mode R: read state
// without writing anything, and never `mkdir owner.lock`. The contract is in src/cli/belay.cjs:
// run(ctx) -> { code, text, json }, never printing, never calling process.exit.
//
// task.list's row already carries lease, holder_pid_alive, last_checkpoint_id and last_checkpoint_at
// (api.md §3, src/core/methods-task.cjs's view()); a task's current row carries no creation time, so
// there is no age to compute here either. Every column is a fact the core established.

const C = require('./config.cjs');
const { openCore } = require('../core/index.cjs');

function usageError(message) {
  return {
    code: 2,
    text: `belay tasks: ${message}\n\nusage: belay tasks [run-id] [--all] [--data <dir>] [--json]\n`,
    json: { error: message },
  };
}

function parseArgs(argv) {
  let all = false;
  const rest = [];
  for (const a of argv) {
    if (a === '--all') { all = true; continue; }
    if (typeof a === 'string' && a.startsWith('-')) return { error: `unknown option ${a}` };
    rest.push(a);
  }
  if (rest.length > 1) return { error: `belay tasks takes zero or one argument, a run id; got ${rest.length}` };
  return { all, runId: rest[0] };
}

const COLUMNS = [
  'id', 'state', 'spec', 'lease_id', 'holder', 'holder_role', 'lease_expires_at', 'lease_expired',
  'holder_pid_alive', 'last_checkpoint_id', 'last_checkpoint_at', 'depends_on',
];

// The first 60 characters of the spec, one line: newlines collapse to spaces before the cut, so a
// multi-line spec never breaks the table.
function specOf(t) {
  const s = String(t.spec == null ? '' : t.spec).replace(/\s+/g, ' ').trim();
  return s.length > 60 ? s.slice(0, 60) : s;
}

function cell(t, c) {
  if (c === 'spec') return specOf(t);
  if (c === 'lease_id') return t.lease ? t.lease.id : null;
  if (c === 'holder') return t.lease ? t.lease.holder : null;
  if (c === 'holder_role') return t.lease ? t.lease.holder_role : null;
  if (c === 'lease_expires_at') return t.lease ? t.lease.expires_at : null;
  if (c === 'lease_expired') return t.lease ? t.lease.expired : null;
  const v = t[c];
  if (Array.isArray(v)) return v.length ? v.join(',') : null;
  return v === undefined ? null : v;
}

function fmt(v) { return v === null || v === undefined ? '-' : String(v); }

function renderText(tasks) {
  if (!tasks.length) return '(no tasks)\n';
  const rows = tasks.map(t => COLUMNS.map(c => fmt(cell(t, c))));
  const widths = COLUMNS.map((c, i) => Math.max(c.length, ...rows.map(r => r[i].length)));
  const line = vals => vals.map((v, i) => v.padEnd(widths[i])).join('  ');
  const lines = [line(COLUMNS), ...rows.map(line), ''];
  return lines.join('\n');
}

async function run(ctx) {
  const parsed = parseArgs(ctx.argv);
  if (parsed.error) return usageError(parsed.error);

  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);

  // Mode R: never created. The run selection is exactly cmd-status.cjs's and cmd-workers.cjs's own
  // (build step 4a): the argument if given, else run.list()'s alive-preferring choice.
  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: parsed.runId || 'cli', pid: process.pid } });
  try {
    let runId = parsed.runId;
    let runIdSource = parsed.runId ? 'argument' : null;
    if (!runId) {
      const { runs } = await core.run.list({});
      if (runs.length) {
        const chosen = runs.find(r => r.alive) || runs[0];
        runId = chosen.id; runIdSource = 'run.list';
      } else runIdSource = 'none';
    }
    const { tasks: everyTask } = await core.task.list({});
    const tasks = parsed.all ? everyTask : (runId ? everyTask.filter(t => t.run_id === runId) : []);
    const receipt = {
      run_id: parsed.all ? null : (runId || null),
      run_id_source: parsed.all ? 'all' : runIdSource,
      tasks,
    };
    return { code: 0, text: renderText(tasks), json: receipt };
  } catch (e) {
    const detail = { code: e.code || 'E_INTERNAL', message: e.message };
    return { code: 1, text: `belay tasks: ${e.message}\n`, json: { error: detail } };
  } finally {
    await core.close();
  }
}

module.exports = { run };
