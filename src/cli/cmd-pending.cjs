'use strict';
// cmd-pending.cjs — build step 6d, design item 5, ADR
// 0020 decision 4. CLI slice, mode R: `belay pending [--all]`, the shape of cmd-workers.cjs. The
// contract is in src/cli/belay.cjs: run(ctx) -> { code, text, json }, never printing, never calling
// process.exit.

const C = require('./config.cjs');
const { openCore } = require('../core/index.cjs');
const { PERMISSION_STATES } = require('../core/schema.cjs');

function usageError(message) {
  return {
    code: 2,
    text: `belay pending: ${message}\n\nusage: belay pending [--all] [--data <dir>] [--json]\n`,
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
  if (rest.length) return { error: `belay pending takes no positional arguments; got ${rest.length}` };
  return { all };
}

// A merge request (belay's own, for a merge into the user's branch) is read whole: its input is JSON the operator must be able to read.
function mergeOf(r) {
  if (r.kind !== 'merge') return null;
  try {
    const q = JSON.parse(r.input);
    return { kind: 'merge', into: q.into, into_head: q.into_head, base: q.base, tasks: (q.tasks || []).map((t) => ({ id: t.id, sha: t.sha ? String(t.sha).slice(0, 12) : null })), evaluate: q.evaluate, checks: (q.checks || []).map((c) => ({ argv: c.argv, cwd: c.cwd })) };
  } catch { return null; }
}

function mergeLines(r) {
  const m = r.merge;
  if (!m) return [];
  return [`${r.id}  merge request, run ${r.run_id}`, `  kind: merge`, `  into: ${m.into}`, `  head before: ${m.into_head || `(new branch, from ${m.base})`}`,
    `  tasks: ${m.tasks.map((t) => `${t.id}@${t.sha}`).join(', ')}`,
    `  checks: ${m.evaluate ? (m.checks.length ? '' : 'none declared') : 'none (evaluate is false)'}`,
    ...m.checks.map((c) => `    ${c.argv.join(' ')}${c.cwd ? `  (cwd ${c.cwd})` : ''}`)];
}

function digestOf(input, r) {
  if (r && r.kind === 'merge') { const m = mergeOf(r); if (m) return `merge into ${m.into}`; }
  const s = String(input == null ? '' : input);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

const BASE_COLUMNS = ['id', 'worker_id', 'run_id', 'tool', 'digest', 'age_ms', 'adapter_pid', 'adapter_alive'];
const ALL_COLUMNS = [...BASE_COLUMNS, 'state', 'verdict_by', 'reason'];

function renderText(requests, all) {
  if (!requests.length) return '(no pending requests)\n';
  const columns = all ? ALL_COLUMNS : BASE_COLUMNS;
  const cell = (r, c) => (r[c] === null || r[c] === undefined ? '' : String(r[c]));
  const widths = columns.map((c) => Math.max(c.length, ...requests.map((r) => cell(r, c).length)));
  const line = (vals) => vals.map((v, i) => String(v).padEnd(widths[i])).join('  ');
  const lines = [line(columns)];
  for (const r of requests) lines.push(line(columns.map((c) => cell(r, c))));
  for (const r of requests) lines.push(...mergeLines(r));
  lines.push('');
  return lines.join('\n');
}

async function run(ctx) {
  const parsed = parseArgs(ctx.argv);
  if (parsed.error) return usageError(parsed.error);

  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);

  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: 'cli', pid: process.pid } });
  try {
    const states = parsed.all ? PERMISSION_STATES : ['pending'];
    const { requests } = await core.permission.list({ states });
    const rendered = requests.map((r) => ({ ...r, digest: digestOf(r.input, r), ...(r.kind === 'merge' ? { merge: mergeOf(r) } : {}) }));
    const owner = core.ownerInfo();
    const receipt = { states, requests: rendered, count: rendered.length, owner };
    return { code: 0, text: renderText(rendered, parsed.all), json: receipt };
  } catch (e) {
    const detail = { code: e.code || 'E_INTERNAL', message: e.message };
    return { code: 1, text: `belay pending: ${e.message}\n`, json: { error: detail } };
  } finally {
    await core.close();
  }
}

module.exports = { run, renderText, mergeOf };
