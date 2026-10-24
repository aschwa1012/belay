'use strict';
// cmd-receipts.cjs — build step S4c.
// CLI slice, mode R. The contract is in src/cli/belay.cjs: run(ctx) -> { code, text, json }, never
// printing, never calling process.exit. Reads run.list, worker.list and task.list only: no embedder, no
// git, no process, and no file but a worker's own compactions.jsonl when it has one. A column that is absent or null is null in JSON and "not recorded" in text,
// never 0. Every string a row supplies passes through clean() before it reaches the text output.

const C = require('./config.cjs');
const { openCore } = require('../core/index.cjs');
const { WORKER_STATES } = require('../core/schema.cjs');
const CP = require('../run/compaction.cjs'); // fs and path only: summarize() reads a worker's compactions.jsonl

const USAGE = 'usage: belay receipts [run-id] [--data <dir>] [--json]\n';
const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens'];
const SUM_FIELDS = [...TOKEN_FIELDS, 'cost_usd', 'tool_calls'];
const WIDTH = 120;

function usageError(message) {
  return { code: 2, text: `belay receipts: ${message}\n\n${USAGE}`, json: { error: message } };
}

function parseArgs(argv) {
  const rest = [];
  for (const a of argv) {
    if (typeof a === 'string' && a.startsWith('-')) return { error: `unknown option ${a}` };
    rest.push(a);
  }
  if (rest.length > 1) return { error: `belay receipts takes zero or one argument, a run id; got ${rest.length}` };
  if (rest.length === 1 && rest[0] === '') return { error: 'the run id is an empty string' };
  return { runId: rest[0] };
}

const nn = (x) => (x === undefined ? null : x);

function wall(startedAt, endedAt) {
  const live = endedAt == null;
  if (live || startedAt == null) return { wall_ms: null, live };
  return { wall_ms: Number(endedAt) - Number(startedAt), live: false };
}

function checkView(c) {
  return { kind: c.kind, executable: nn(c.executable), passed: nn(c.passed), ms: nn(c.ms) };
}

function taskView(t) {
  const checks = t.results && Array.isArray(t.results.checks) ? t.results.checks : [];
  return { id: t.id, state: t.state, checks: checks.map(checkView) };
}

function handoffView(h) {
  if (!h) return null;
  const r = h.result && typeof h.result === 'object' ? h.result : null;
  return {
    by: nn(h.by), lease_id: nn(h.lease_id), at: nn(h.at),
    verdict: r && r.verdict !== undefined ? r.verdict : null,
    summary: r && r.summary !== undefined ? r.summary : null,
    result: nn(h.result),
  };
}

function orchestratorView(r) {
  return {
    model: nn(r.orch_model), turns: nn(r.orch_turns),
    input_tokens: nn(r.orch_input_tokens), output_tokens: nn(r.orch_output_tokens),
    cache_read_tokens: nn(r.orch_cache_read_tokens), cache_creation_tokens: nn(r.orch_cache_creation_tokens),
    cost_usd: nn(r.orch_cost_usd), tool_calls: null,
    ...wall(r.started_at, r.ended_at),
  };
}

// A plain file read; no key at all for a worker that never compacted, so every other receipt is as it was.
function compactionsOf(dataDir, id) {
  const c = dataDir ? CP.summarize(dataDir, id) : null;
  return c ? { compactions: c } : {};
}

function workerView(w, tasksById, dataDir) {
  const t = w.task_id ? tasksById.get(w.task_id) : null;
  const task = t ? { ...taskView(t), handoff: handoffView(t.handoff) } : null;
  return {
    id: w.id, substrate: nn(w.substrate), state: nn(w.state), model: nn(w.model), turns: nn(w.turns),
    input_tokens: nn(w.input_tokens), output_tokens: nn(w.output_tokens),
    cache_read_tokens: nn(w.cache_read_tokens), cache_creation_tokens: nn(w.cache_creation_tokens),
    cost_usd: nn(w.cost_usd), tool_calls: nn(w.tool_calls),
    ...wall(w.started_at, w.exited_at),
    exit_code: nn(w.exit_code), base_sha: nn(w.base_sha), head_sha: nn(w.head_sha), task,
    ...(compactionsOf(dataDir, w.id)), // ADR 0007 decision 7: only a worker with compactions carries the key
  };
}

// Sums skip null terms; a field no agent recorded totals null, never 0. `not_recorded` counts, per
// field, the agents that carried null for it. The orchestrator has no tool-call column at all, so it is
// left out of both the sum and the count for tool_calls (Amendment 1, SF4).
function totalsOf(orchestrator, workers) {
  const agents = orchestrator ? [orchestrator, ...workers] : workers;
  const totals = { agents: agents.length, not_recorded: {} };
  for (const f of SUM_FIELDS) {
    const pool = f === 'tool_calls' ? workers : agents;
    let sum = null;
    let missing = 0;
    for (const a of pool) {
      if (a[f] == null) { missing += 1; continue; }
      sum = (sum === null ? 0 : sum) + Number(a[f]);
    }
    totals[f] = sum;
    totals.not_recorded[f] = missing;
  }
  return totals;
}

// ---- text ----------------------------------------------------------------------------------------

// The one sanitiser: control characters (U+0000-U+001F, U+007F, U+2028, U+2029) become spaces, and the
// string is capped. Nothing a row holds can start a line of its own in the text output.
// C0, DEL, C1 (U+0080-U+009F: U+009B is an 8-bit CSI, U+0085 a NEL), the line and paragraph separators
// and the bidi controls that reorder how a line displays.
// Also the Arabic letter mark and the zero-width characters (review 3, SF12).
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028\\u2029\\u2060\\u202a-\\u202e\\u2066-\\u2069\\ufeff]', 'g');
// The cap counts code points, so a cut never splits a surrogate pair. Whitespace runs collapse to one
// space, because two spaces separate fields in the text: a value cannot print a field of its own (SF11).
function clean(x, cap = 80) {
  const s = String(x).replace(CONTROL, ' ').replace(/\s{2,}/g, ' ');
  if (s.length <= cap) return s;
  const cps = Array.from(s);
  return cps.length > cap ? cps.slice(0, cap).join('') : s;
}
const v = (x, cap) => (x === null || x === undefined ? 'not recorded' : clean(x, cap));
const iso = (ms) => (ms == null ? 'not recorded' : new Date(Number(ms)).toISOString());
const wallText = (a) => (a.live ? 'live' : (a.wall_ms === null ? 'not recorded' : `${a.wall_ms}ms`));

// At most 4 decimals, trailing zeros trimmed; a value that rounds to zero prints 0.0000.
function money(x) {
  if (x === null || x === undefined) return 'not recorded';
  const n = Number(x);
  if (!Number.isFinite(n)) return clean(x);
  let t = n.toFixed(4);
  if (Number(t) !== 0) t = t.replace(/0+$/, '').replace(/\.$/, '');
  return `$${t}`;
}

function tokensLine(a) {
  return `  in ${v(a.input_tokens)}  out ${v(a.output_tokens)}  cache-read ${v(a.cache_read_tokens)}  cache-create ${v(a.cache_creation_tokens)}`;
}

function checksText(checks) {
  if (!checks.length) return 'none';
  return checks.map(c => `${v(c.kind)}:${c.executable === false ? 'n/e' : (c.passed ? 'pass' : 'fail')} ${v(c.ms)}ms`).join(', ');
}

function wrap(prefix, text, width = WIDTH) {
  const room = width - prefix.length;
  const cps = Array.from(text);
  const out = [];
  for (let i = 0; i < cps.length; i += room) out.push(prefix + cps.slice(i, i + room).join(''));
  return out.length ? out : [prefix];
}

// A line longer than WIDTH is broken, never cut: at a two-space or comma boundary where one exists,
// and continuation lines are indented four spaces. A run with no boundary is broken at the width.
function brk(line) {
  if (Array.from(line).length <= WIDTH) return [line];
  const tokens = line.split(/(?<=  |, )/);
  const out = [];
  let cur = '';
  const room = () => (out.length ? WIDTH - 4 : WIDTH);
  const flush = () => { if (cur) { out.push((out.length ? '    ' : '') + cur.replace(/\s+$/, '')); cur = ''; } };
  for (const t of tokens) {
    if (Array.from(cur + t.replace(/\s+$/, '')).length > room()) flush();
    cur += t;
    while (Array.from(cur).length > room()) {
      const cps = Array.from(cur);
      const head = cps.slice(0, room()).join('');
      out.push((out.length ? '    ' : '') + head);
      cur = cps.slice(room()).join('');
    }
  }
  flush();
  return out;
}

function handoffLines(h) {
  const head = `  handoff ${h.verdict == null ? 'not recorded' : `"${clean(h.verdict)}"`}  by ${v(h.by)}  at ${h.at == null ? 'not recorded' : iso(h.at)}`;
  const lines = [head];
  if (h.summary != null) lines.push(...wrap('    summary ', clean(h.summary, 200)));
  return lines;
}

function renderText(rc) {
  if (!rc.run) return '(no runs)\n';
  const r = rc.run;
  const state = r.ended_at != null ? `ended ${iso(r.ended_at)}` : (r.alive ? 'alive' : 'not alive, no end recorded');
  const o = rc.orchestrator;
  const lines = [
    `run ${v(rc.run_id)} (chosen by ${rc.run_id_source})`,
    `  started ${iso(r.started_at)}  ${state}  exit_reason ${v(r.exit_reason)}`,
    ...(r.paused_at != null && r.ended_at == null ? [`  PAUSED${/embedder-failure [(]/.test(r.paused_by || '') ? ' for an embedder failure' : ''} ${iso(r.paused_at)} by ${v(r.paused_by)}`] : []),
    `orchestrator  model ${v(o.model)}  turns ${v(o.turns)}  wall ${wallText(o)}  cost ${money(o.cost_usd)}  (orchestrator tool calls: no column)`,
    tokensLine(o),
  ];
  for (const w of rc.workers) {
    lines.push(`worker ${v(w.id)}  ${w.substrate == null ? '' : clean(w.substrate)}  state ${v(w.state)}  exit ${v(w.exit_code)}`);
    lines.push(`  model ${v(w.model)}  turns ${v(w.turns)}  wall ${wallText(w)}  cost ${money(w.cost_usd)}  tools ${v(w.tool_calls)}`);
    lines.push(tokensLine(w));
    if (w.compactions) lines.push(`  compactions ${w.compactions.count} (harness ${w.compactions.harness}, auto ${w.compactions.auto})  last ${v(w.compactions.last_pre_tokens)} -> ${v(w.compactions.last_post_tokens)} tokens  max hook ${w.compactions.max_hook_bytes} B`);
    lines.push(`  base ${v(w.base_sha)}  head ${v(w.head_sha)}`);
    if (w.task) {
      lines.push(`  task ${v(w.task.id)} (${v(w.task.state)})`);
      lines.push(`  checks ${checksText(w.task.checks)}`);
      if (w.task.handoff) lines.push(...handoffLines(w.task.handoff)); else lines.push('  handoff none');
    } else lines.push('  task none');
  }
  if (!rc.workers.length) lines.push('(no workers)');
  for (const t of rc.unassigned_tasks) lines.push(`unassigned task ${v(t.id)} (${v(t.state)})  checks ${checksText(t.checks)}`);
  const t = rc.totals;
  const miss = SUM_FIELDS.filter(f => t.not_recorded[f] > 0).map(f => `${f} ${t.not_recorded[f]}`).join(', ');
  lines.push(`totals over ${t.agents} agents  cost ${money(t.cost_usd)}  tools ${v(t.tool_calls)}`);
  lines.push(`  in ${v(t.input_tokens)}  out ${v(t.output_tokens)}  cache-read ${v(t.cache_read_tokens)}  cache-create ${v(t.cache_creation_tokens)}`);
  if (miss) lines.push(`  not recorded: ${miss}`);
  lines.push('');
  return lines.flatMap(brk).join('\n');
}

// ---- command -------------------------------------------------------------------------------------

async function run(ctx) {
  const parsed = parseArgs(ctx.argv);
  if (parsed.error) return usageError(parsed.error);

  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);

  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: parsed.runId || 'cli', pid: process.pid } });
  try {
    const { runs } = await core.run.list({});
    let chosen = null;
    let source;
    if (parsed.runId) {
      chosen = runs.find(r => r.id === parsed.runId) || null;
      source = 'argument';
      if (!chosen) {
        const message = `no run row exists for ${parsed.runId}`;
        return { code: 1, text: `belay receipts: ${clean(message)}\n`, json: { error: { code: 'E_NOT_FOUND', message, run_id: parsed.runId } } };
      }
    } else if (runs.length) {
      chosen = runs.find(r => r.alive) || runs[0];
      source = 'run.list';
    } else source = 'none';

    const owner = core.ownerInfo();
    if (!chosen) {
      const empty = { run_id: null, run_id_source: source, run: null, orchestrator: null, workers: [], unassigned_tasks: [], totals: totalsOf(null, []), owner };
      return { code: 0, text: renderText(empty), json: empty };
    }
    // worker.list hides `forgotten` rows unless asked; the money was spent whatever was forgotten after.
    // One call naming every state (the schema's own set, so a future state is tracked): one snapshot.
    const { workers: everyWorker } = await core.worker.list({ states: WORKER_STATES });
    const { tasks: everyTask } = await core.task.list({});
    const tasks = everyTask.filter(t => t.run_id === chosen.id);
    const tasksById = new Map(tasks.map(t => [t.id, t]));
    const workers = everyWorker.filter(w => w.run_id === chosen.id).map(w => workerView(w, tasksById, dataDir));
    const assigned = new Set(workers.filter(w => w.task).map(w => w.task.id));
    const orchestrator = orchestratorView(chosen);
    const receipt = {
      run_id: chosen.id, run_id_source: source,
      run: { started_at: nn(chosen.started_at), ended_at: nn(chosen.ended_at), exit_reason: nn(chosen.exit_reason), alive: !!chosen.alive, paused_at: nn(chosen.paused_at), paused_by: nn(chosen.paused_by) },
      orchestrator, workers,
      unassigned_tasks: tasks.filter(t => !assigned.has(t.id)).map(taskView),
      totals: totalsOf(orchestrator, workers), owner,
    };
    return { code: 0, text: renderText(receipt), json: receipt };
  } catch (e) {
    const detail = { code: e.code || 'E_INTERNAL', message: e.message };
    return { code: 1, text: `belay receipts: ${clean(e.message, 200)}\n`, json: { error: detail } };
  } finally {
    await core.close();
  }
}

module.exports = { run };
