'use strict';
// cmd-workers.cjs — build step 4a, design item 4. CLI
// slice, mode R. The contract is in src/cli/belay.cjs: run(ctx) -> { code, text, json }, never
// printing, never calling process.exit.
//
// command table §3 names this row `workers`, not `agents`: worker rows plus pid checks, never
// `claude agents` (a machine-wide registry that would show the operator's unrelated sessions).

const C = require('./config.cjs');
const { openCore } = require('../core/index.cjs');

function usageError(message) {
  return {
    code: 2,
    text: `belay workers: ${message}\n\nusage: belay workers [run-id] [--all] [--data <dir>] [--json]\n`,
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
  if (rest.length > 1) return { error: `belay workers takes zero or one argument, a run id; got ${rest.length}` };
  return { all, runId: rest[0] };
}

const COLUMNS = [
  'id', 'substrate', 'pid', 'state', 'pid_alive', 'mid_turn', 'turns',
  'last_event_age_ms', 'input_tokens', 'output_tokens', 'cost_usd', 'death_established_by',
];

function renderText(workers) {
  if (!workers.length) return '(no workers)\n';
  const cell = (w, c) => (w[c] === null || w[c] === undefined ? '' : String(w[c]));
  const widths = COLUMNS.map(c => Math.max(c.length, ...workers.map(w => cell(w, c).length)));
  const line = vals => vals.map((v, i) => String(v).padEnd(widths[i])).join('  ');
  const lines = [line(COLUMNS)];
  for (const w of workers) lines.push(line(COLUMNS.map(c => cell(w, c))));
  lines.push('');
  return lines.join('\n');
}

async function run(ctx) {
  const parsed = parseArgs(ctx.argv);
  if (parsed.error) return usageError(parsed.error);

  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);

  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: parsed.runId || 'cli', pid: process.pid } });
  try {
    let runId = parsed.runId;
    let runIdSource = parsed.runId ? 'argument' : null;
    if (!runId) {
      const { runs } = await core.run.list({});
      if (runs.length) {
        // Fix round: prefer the run flagged alive over the newest written row, same rule as
        // cmd-status.cjs — see the comment there.
        const chosen = runs.find(r => r.alive) || runs[0];
        runId = chosen.id; runIdSource = 'run.list';
      } else runIdSource = 'none';
    }
    const { workers: everyWorker } = await core.worker.list({});
    const workers = parsed.all ? everyWorker : (runId ? everyWorker.filter(w => w.run_id === runId) : []);
    const owner = core.ownerInfo();
    const receipt = {
      run_id: parsed.all ? null : (runId || null),
      run_id_source: parsed.all ? 'all' : runIdSource,
      workers, owner,
    };
    return { code: 0, text: renderText(workers), json: receipt };
  } catch (e) {
    const detail = { code: e.code || 'E_INTERNAL', message: e.message };
    return { code: 1, text: `belay workers: ${e.message}\n`, json: { error: detail } };
  } finally {
    await core.close();
  }
}

module.exports = { run };
