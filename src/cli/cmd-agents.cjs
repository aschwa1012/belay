'use strict';
// cmd-agents.cjs — ADR 0036 decisions 5a and 5b, build step U1. Mode R: run.list, worker.list and
// task.list (store reads through the core's copy-then-read path), plus a bounded read of the tail of
// each agent's own stream. One row for the orchestrator and one per worker of the run, then the run
// cost meter as the footer.
//
// Context in use is the last assistant message's usage in the agent's stream: input_tokens +
// cache_read_input_tokens + cache_creation_input_tokens. The window is the latest `result` line's
// modelUsage.<model>.contextWindow. Both are the substrate's own figures; nothing is hard-coded and
// nothing is self-reported. No window yet: the tokens are shown and the window is `window unknown`.
//
// Cost. A `result` line's total_cost_usd is CUMULATIVE for the session, not per turn. Evidence, from
// the recorded streams of long-lived `-p --input-format stream-json` processes
//: total_cost_usd
// runs 0.0050, 0.1747, 0.3102, 0.4487, ... 1.4325, rising every turn, while `usage.output_tokens` is
// the per-turn figure (25 each) and modelUsage.<model>.outputTokens, which is cumulative, runs 4, 29,
// 54, 79 ... 2044 and equals the running sum of those per-turn figures; modelUsage.<model>.costUSD
// equals total_cost_usd on every line. The meter therefore reads the LATEST result line and never sums
// across them. A restarted orchestrator process starts its own count, so after a restart the figure is
// that process's alone until `run.end` writes the run row's orch_cost_usd, which wins when set.

const fs = require('node:fs');
const C = require('./config.cjs');
const P = require('./panel-common.cjs');
const { openCore } = require('../core/index.cjs');
const { WORKER_STATES } = require('../core/schema.cjs');
const D = require('./agents-derive.cjs');
const { stallAge } = require('./cmd-notices.cjs');
const TU = require('./transcript-usage.cjs');

const USAGE = 'usage: belay agents [run-id] [--dir <orchestrator_dir>] [--data <dir>] [--json]\n';
const TAIL_BYTES = 256 * 1024; // the first window; widened by 4x only while no assistant line of the agent's own is in it
const TAIL_MAX_BYTES = 8 * 1024 * 1024;

function usageError(message) {
  return { code: 2, text: `belay agents: ${message}\n\n${USAGE}`, json: { error: message } };
}

function parseArgs(argv) {
  let dir = null;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') {
      const raw = argv[i += 1];
      if (raw === undefined || raw.startsWith('-')) return { error: '--dir needs a directory' };
      dir = raw; continue;
    }
    if (typeof a === 'string' && a.startsWith('-')) return { error: `unknown option ${a}` };
    rest.push(a);
  }
  if (rest.length > 1) return { error: `belay agents takes zero or one argument, a run id; got ${rest.length}` };
  if (rest.length === 1 && rest[0] === '') return { error: 'the run id is an empty string' };
  return { runId: rest[0], dir };
}

const nn = (x) => (x === undefined ? null : x);

// ---- the stream tail -----------------------------------------------------------------------------

function readWindow(file, size, n) {
  const buf = Buffer.alloc(n);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, n, size - n); } finally { fs.closeSync(fd); }
  return buf;
}

// The last usable assistant line and the last result line, found by walking the tail backwards. The
// window starts at TAIL_BYTES and grows fourfold, never past TAIL_MAX_BYTES, only while no assistant
// line is in it and the file has more behind it; its first line is dropped when it is cut mid-line.
// Once the last assistant line is found the window stops growing: a result line behind it is not
// looked for (a live orchestrator is one long turn whose only result line is at the very end, so the
// window is reported unknown rather than read for). The same walk also finds the agent's latest own line whose
// usage.cache_creation split is non-zero (`split`, the prompt-cache lifetime, agents-derive.cjs) and the
// last event of its own (`tail_event`, for the display state). A subagent's lines (`parent_tool_use_id` set) and
// a synthetic message are not the agent's own context. `result_ts_ms` is the timestamp of the nearest
// line before the result that carries one: a result line has no timestamp of its own, so this is a
// lower bound on when the turn ended, and says so. A read error other than a missing file is returned
// as `error`, never thrown: one unreadable stream must not fail the table.
function scanTail(file) {
  const blank = { exists: false, bytes: null, bytes_read: 0, assistant: null, first_assistant: null, split: null, tail_event: null, mtime_ms: null, result: null, result_ts_ms: null, error: null };
  let size, mtime = null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { ...blank, exists: true, error: 'not a regular file' };
    size = st.size;
    mtime = st.mtimeMs;
  } catch (e) {
    if (e.code === 'ENOENT') return blank;
    return { ...blank, error: e.code || e.message };
  }
  let want = TAIL_BYTES;
  for (;;) {
    const n = Math.min(size, want, TAIL_MAX_BYTES);
    let lines = [];
    try { lines = n ? readWindow(file, size, n).toString('utf8').split('\n') : []; } catch (e) {
      return { ...blank, exists: true, bytes: size, error: e.code || e.message };
    }
    if (n < size) lines.shift();
    // `first` is the earliest line of the same API message as `assistant` (one message spans several
    // lines, one per content block); `sameDone` is set at the first own line of another message.
    let assistant = null, result = null, resultAt = -1, split = null, first = null, sameDone = false;
    for (let i = lines.length - 1; i >= 0 && !(assistant && result && split && sameDone); i -= 1) {
      const l = lines[i];
      const hasA = l.includes('"type":"assistant"');
      const isA = hasA && (!assistant || !sameDone || (!split && l.includes('"ephemeral_')));
      const isR = !result && l.includes('"type":"result"');
      if (!isA && !isR) continue;
      let o;
      try { o = JSON.parse(l); } catch { continue; }
      if (isR && o.type === 'result') { result = o; resultAt = i; }
      else if (isA && o.type === 'assistant' && !o.parent_tool_use_id && o.message && o.message.usage && o.message.model !== '<synthetic>') {
        if (!assistant) { assistant = o; first = o; sameDone = !o.message.id; }
        else if (!sameDone) { if (o.message.id === assistant.message.id) first = o; else sameDone = true; }
        const sp = split ? null : D.splitOf(o);
        if (sp) split = { ...sp, line: o };
      }
    }
    if (assistant || n >= size || n >= TAIL_MAX_BYTES) {
      let ts = null;
      for (let i = resultAt - 1; resultAt >= 0 && i >= 0 && ts === null; i -= 1) {
        const m = /"timestamp":"([^"]+)"/.exec(lines[i]);
        if (m && Number.isFinite(Date.parse(m[1]))) ts = Date.parse(m[1]);
      }
      return { exists: true, bytes: size, bytes_read: n, assistant, first_assistant: first, split, tail_event: D.tailEvent(lines), mtime_ms: mtime, result, result_ts_ms: ts, error: null };
    }
    want *= 4;
  }
}

// context fields from a scan. The window comes from the modelUsage entry of the model the last
// assistant message ran on; with no such entry it is taken only when the result names exactly one model.
function contextOf(scan) {
  const out = { model_seen: null, context_tokens: null, context_window: null, context_pct: null };
  if (scan.assistant) {
    const u = scan.assistant.message.usage;
    out.model_seen = nn(scan.assistant.message.model);
    out.context_tokens = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
  }
  const mu = scan.result && scan.result.modelUsage && typeof scan.result.modelUsage === 'object' ? scan.result.modelUsage : null;
  if (mu) {
    const keys = Object.keys(mu);
    const key = out.model_seen && mu[out.model_seen] ? out.model_seen : (keys.length === 1 ? keys[0] : null);
    const w = key ? Number(mu[key].contextWindow) : NaN;
    if (Number.isFinite(w) && w > 0) out.context_window = w;
    if (!out.model_seen && key) out.model_seen = key;
  }
  if (out.context_tokens != null && out.context_window != null) out.context_pct = Math.round((out.context_tokens / out.context_window) * 1000) / 10;
  return out;
}

// ---- rows ----------------------------------------------------------------------------------------

const ORCH_ROW_COST = 'run row orch_cost_usd, written by run.end';
const ORCH_STREAM_COST = 'latest stream result line total_cost_usd, cumulative for the orchestrator process';

// run.end can write orch_cost_usd 0 with orch_turns 0 when the orchestrator was stopped mid-turn with no
// result line (src/run/orchestrator-usage.cjs): zero turns is a cost that was never recorded.
function orchestratorRow(run, streamPath, now = Date.now()) {
  const scan = scanTail(streamPath);
  const ctx = contextOf(scan);
  const total = scan.result && typeof scan.result.total_cost_usd === 'number' ? scan.result.total_cost_usd : null;
  const rowCost = run.orch_cost_usd != null && !(run.orch_turns != null && Number(run.orch_turns) === 0) ? Number(run.orch_cost_usd) : null;
  const state = run.ended_at != null ? 'ended' : (run.paused_at != null ? 'paused' : (run.alive ? 'alive' : 'not alive'));
  return {
    id: 'orchestrator', role: 'orchestrator', role_source: 'run row', substrate: 'claude-code',
    model: run.orch_model != null ? run.orch_model : ctx.model_seen, model_seen: ctx.model_seen, effort: nn(run.orch_effort_requested), effort_is: 'requested',
    state, context_tokens: ctx.context_tokens, context_window: ctx.context_window, context_pct: ctx.context_pct,
    window_source: ctx.context_window != null ? 'own result line' : null,
    cost_usd: rowCost != null ? rowCost : total,
    cost_source: rowCost != null ? ORCH_ROW_COST : (total != null ? ORCH_STREAM_COST : null),
    pid: nn(run.orchestrator_pid), permission_mode: null, claude_code_version: null, // the run row records neither
    ...D.orchestratorDisplay(run, scan, now), task: null, cache: D.cacheOf(scan, now),
    stream_path: streamPath, stream_exists: scan.exists, stream_error: scan.error, result_ts_ms: scan.result_ts_ms,
  };
}

// An interactive orchestrator writes no stream: its usage is read from its session transcript (transcript-usage.cjs).
// Only when its stream gave nothing. The dollar figure is an estimate from that transcript and exists only for a
// model with a rate; otherwise the tokens are shown and the cost stays null with the reason in cost_source.
function fillFromTranscript(orch, orchDir, run, opts = {}) {
  if (orch.context_tokens != null || orch.cost_usd != null) return;
  const { file, refused } = TU.sessionFileOf(orchDir, run, opts);
  if (!file) { if (refused.length) orch.cost_note = `session transcript not read: ${refused[0]}`; return; }
  const u = TU.readUsage(file, undefined, opts);
  if (u.refused) { orch.cost_note = `session transcript not read: ${u.refused}`; return; }
  orch.transcript_path = file;
  if (!u.exists || !u.messages) return;
  orch.transcript_usage = { tokens: u.tokens, messages: u.messages };
  // The same rule as a worker's stream (D.cacheOf), over the transcript: its latest message and latest cache-write split.
  const fl = u.last_first_line;
  orch.cache = D.cacheOf({ exists: true, bytes_read: u.bytes_read, first_assistant: fl, assistant: fl, split: u.split }, Number.isFinite(opts.now) ? opts.now : Date.now());
  orch.cache.ttl_established_by = u.split
    ? `${orch.cache.ttl_established_by} of the session transcript ${file}`
    : `no assistant line of the session transcript ${file} has a non-zero message.usage.cache_creation split; the lifetime is not assumed`;
  orch.context_tokens = u.context_tokens;
  if (u.model_seen) { orch.model_seen = u.model_seen; if (orch.model == null) orch.model = u.model_seen; }
  if (u.cost_usd != null) {
    orch.cost_usd = u.cost_usd; orch.cost_source = 'estimate from the session transcript belay launched; /clear starts a new one that is not followed'; orch.cost_basis = 'transcript, API rates';
    if (u.cache_write_assumed_5m) orch.cost_note = `${u.cache_write_assumed_5m} message(s) gave no 5m/1h cache-write split: all priced at the 5m rate`;
  } else orch.cost_note = `no rate for ${u.unpriced_models.join(', ') || 'this model'}: tokens only (from the session belay launched; /clear starts a new one that is not followed)`;
}

// An orchestrator with tokens and no result line of its own (the run is live: one turn, no result yet)
// takes the window from the latest result line of another agent of the run that ran the SAME model.
// Never from a different model, and never estimated: otherwise the window stays unknown.
function borrowWindow(orch, workers) {
  if (orch.context_tokens == null || orch.context_window != null || !orch.model_seen) return;
  const donors = workers.filter((w) => w.context_window != null && w.model_seen === orch.model_seen);
  if (!donors.length) return;
  const donor = donors.reduce((best, w) => ((w.result_ts_ms ?? -1) > (best.result_ts_ms ?? -1) ? w : best));
  orch.context_window = donor.context_window;
  orch.context_pct = Math.round((orch.context_tokens / orch.context_window) * 1000) / 10;
  orch.window_source = `result line of worker ${donor.id} (same model)`;
}

// A worker's role is what its row or task tells: a worker holding a review task (acceptance.verdict
// true, ADR 0025) is a reviewer; the row has no role column, so every other worker is null.
function roleOf(task) {
  if (task && task.acceptance && task.acceptance.verdict === true) return { role: 'reviewer', role_source: `task ${task.id} acceptance.verdict` };
  return { role: null, role_source: null };
}

// A worker's stream is a fact of the data dir layout (api.md §1), as `belay logs` reads it. An id that
// could leave the workers directory is never turned into a path.
function streamPathOf(dataDir, id) {
  const sid = String(id);
  return /[\\/]/.test(sid) || sid === '..' || sid === '.' ? null : `${dataDir}/workers/${sid}/stream.jsonl`;
}

function workerRow(w, tasksById, dataDir, { now, pending, leaseTaskOf = new Map() }) {
  const claude = w.substrate === 'claude-code';
  const streamPath = streamPathOf(dataDir, w.id);
  // A Codex stream is not Claude Code's: what it carries is not parsed here, so its context is not recorded.
  const scan = claude && streamPath ? scanTail(streamPath) : { exists: false, result: null, result_ts_ms: null, error: null, skipped: claude ? 'no stream path for this worker id' : 'a Codex stream is not Claude Code\'s and is not parsed' };
  const ctx = contextOf(scan);
  const rowCost = w.cost_usd != null ? Number(w.cost_usd) : null;
  return {
    id: w.id, ...roleOf(w.task_id ? tasksById.get(w.task_id) : null), substrate: nn(w.substrate),
    task: D.currentTask(w, tasksById, leaseTaskOf),
    pid: nn(w.pid), permission_mode: nn(w.permission_mode_effective), permission_mode_is: 'effective', claude_code_version: nn(w.claude_code_version),
    model: w.model != null ? w.model : ctx.model_seen, model_seen: ctx.model_seen, effort: nn(w.effort_requested), effort_is: 'requested',
    state: nn(w.state), context_tokens: ctx.context_tokens, context_window: ctx.context_window, context_pct: ctx.context_pct,
    window_source: ctx.context_window != null ? 'own result line' : null,
    cost_usd: rowCost, cost_source: rowCost != null ? 'worker row cost_usd' : null,
    ...D.workerDisplay(w, { pending: pending.has(w.id), stall: stallAge(w, dataDir, now) }), cache: D.cacheOf(scan, now),
    stream_path: streamPath, stream_exists: !!scan.exists, stream_error: scan.error, result_ts_ms: scan.result_ts_ms,
  };
}

// A worker's current task is the one whose unreleased lease it holds; the newest grant wins.
function leaseTasksOf(tasks) {
  const out = new Map();
  for (const t of tasks) {
    const l = t.lease;
    if (!l || l.holder_role !== 'worker' || !l.holder) continue;
    const cur = out.get(l.holder);
    if (!cur || Number(l.granted_at) > Number(cur.lease.granted_at)) out.set(l.holder, t);
  }
  return out;
}

function footerOf(agents) {
  const costed = agents.filter((a) => a.cost_usd != null);
  const stamped = agents.map((a) => a.result_ts_ms).filter((t) => t != null);
  return {
    agents: agents.length,
    total_cost_usd: costed.length ? costed.reduce((s, a) => s + a.cost_usd, 0) : null,
    cost_not_recorded: agents.length - costed.length,
    as_of_ms: stamped.length ? Math.max(...stamped) : null,
    as_of_source: 'timestamp of the last stream line before the newest result line counted; a result line carries none of its own',
    highest_context_pct: agents.reduce((m, a) => (a.context_pct != null && (m == null || a.context_pct > m) ? a.context_pct : m), null),
  };
}

// ---- text ----------------------------------------------------------------------------------------

const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function contextText(a) {
  if (a.stream_error) return `context not recorded (stream error ${P.v(a.stream_error, 40)})`;
  if (a.context_tokens == null) return 'context not recorded';
  if (a.context_window == null) return `context ${grouped(a.context_tokens)} tokens (window unknown)`;
  return `context ${grouped(a.context_tokens)} of ${grouped(a.context_window)} tokens (${a.context_pct}%${a.window_source && a.window_source !== 'own result line' ? `, window from ${P.v(a.window_source, 60)}` : ''})`;
}

function renderText(rc) {
  const lines = [];
  for (const a of rc.agents) {
    const task = a.task ? `${P.v(a.task.id, 40)}${a.task.title ? ` ${P.v(a.task.title, 40)}` : ''}` : '-';
    const head = `${P.v(a.id, 40)}  role ${P.v(a.role, 20)}  model ${P.v(a.model, 40)}  effort ${P.v(a.effort, 10)}  state ${P.v(a.state, 12)}  display ${P.v(a.display_state, 12)}`;
    lines.push(...P.wrapLine('', head));
    lines.push(...P.wrapLine('  ', `task ${task}  cache ${D.cacheText(a.cache)}`));
    const cost = a.cost_usd == null ? (a.cost_note ? `cost not priced (${P.v(a.cost_note, 80)})` : 'cost not recorded') : `cost ${P.money(a.cost_usd)} (${a.cost_source})`;
    lines.push(...P.wrapLine('  ', `${contextText(a)}  ${cost}`));
  }
  if (!rc.agents.length) return '(no agents)\n';
  const f = rc.footer;
  const total = f.total_cost_usd == null ? 'not recorded' : P.money(f.total_cost_usd);
  lines.push(`run cost ${total} over ${f.agents} agents, ${f.cost_not_recorded} with cost not recorded, as of ${P.iso(f.as_of_ms)}`);
  lines.push('');
  return lines.join('\n');
}

// ---- command -------------------------------------------------------------------------------------

async function run(ctx) {
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now(); // injectable for tests
  const parsed = parseArgs(ctx.argv);
  if (parsed.error) return usageError(parsed.error);

  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);

  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: parsed.runId || 'cli', pid: process.pid } });
  try {
    return await core.readBatch(async () => { // one store copy for every read below
      const { chosen, source } = await P.chooseRun(core, parsed.runId);
      if (!chosen) {
        const message = parsed.runId ? `no run row exists for ${parsed.runId}` : 'no run rows exist';
        if (!parsed.runId) {
          const empty = { run_id: null, run_id_source: source, mode: null, mode_source: 'no run', started_at_ms: null, paused_at_ms: null, ended_at_ms: null, tasks: { done: 0, total: 0 }, max_fix_rounds: null, agents: [], footer: footerOf([]) };
          return { code: 0, text: renderText(empty), json: empty };
        }
        return { code: 1, text: `belay agents: ${P.clean(message)}\n`, json: { error: { code: 'E_NOT_FOUND', message, run_id: parsed.runId } } };
      }
      const { workers: everyWorker } = await core.worker.list({ states: WORKER_STATES }); // `forgotten` rows keep their cost_usd: the money was spent
      const { tasks: everyTask } = await core.task.list({});
      const { requests: pendingReqs } = await core.permission.list({ run_id: chosen.id, states: ['pending'] });
      const pending = new Set(pendingReqs.map((r) => r.worker_id));
      const tasksById = new Map(everyTask.filter((t) => t.run_id === chosen.id).map((t) => [t.id, t]));
      const leaseTaskOf = leaseTasksOf([...tasksById.values()]);
      const { dir: orchDir, stream_path: orchStream } = P.orchestratorStreamPath(chosen.id, parsed.dir, ctx.cwd);
      const workers = everyWorker.filter((w) => w.run_id === chosen.id).map((w) => workerRow(w, tasksById, dataDir, { now, pending, leaseTaskOf }));
      const orchestrator = orchestratorRow(chosen, orchStream, now);
      fillFromTranscript(orchestrator, orchDir, chosen, { now });
      borrowWindow(orchestrator, workers);
      const agents = [orchestrator, ...workers];
      const runTasks = [...tasksById.values()];
      const receipt = {
        run_id: chosen.id, run_id_source: source, ...D.modeOf(orchDir, chosen, orchestrator.stream_exists ? D.streamStart(orchStream) : null),
        started_at_ms: nn(chosen.started_at), paused_at_ms: nn(chosen.paused_at), ended_at_ms: nn(chosen.ended_at),
        tasks: { done: runTasks.filter((t) => t.state === 'done').length, total: runTasks.length },
        max_fix_rounds: nn(chosen.max_fix_rounds), // the run row records the limit, not the rounds used
        memory_notice: require('../core/memory-notice.cjs').noticeForRun(chosen, null), // this run's own notice (or null): the panel shows it, never the config's
        agents, footer: footerOf(agents), owner: core.ownerInfo(),
      };
      return { code: 0, text: renderText(receipt), json: receipt };
    });
  } catch (e) {
    return { code: 1, text: `belay agents: ${P.clean(e.message, 200)}\n`, json: { error: { code: e.code || 'E_INTERNAL', message: e.message } } };
  } finally {
    await core.close();
  }
}

module.exports = { run, fillFromTranscript, leaseTasksOf, renderText, scanTail, contextOf, orchestratorRow, workerRow, TAIL_MAX_BYTES };
