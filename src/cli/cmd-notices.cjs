'use strict';
// cmd-notices.cjs — ADR 0036 decision 5, build step U1. Mode R: run.list, worker.list, task.list and
// permission.list, all store reads through the core's copy-then-read path, plus one stat of each
// running Claude Code worker's stream.jsonl (its mtime, never its content): no stream is read, no
// process is started, no model is involved. Every event is a fact derived from
// rows (invariant 4), cites the ids it concerns and the row it came from, and carries a timestamp.
//
//   permission_pending  a pending permission request of the run
//   worker_dead         a worker row in `dead`, with death_established_by
//   worker_stopped      a worker row in `stopped`
//   worker_stalled      a worker mid-turn whose last event is older than the stall threshold, with its pid check
//   review_verdict      a verdict check on a review task's results (ADR 0025)
//   run_paused          the run row's paused_at while the run has not ended
//   run_ended           the run row's ended_at
//   memory_wrapup       a wrap-up memory_event of the run (ADR 0043 decision 2): one per task and one per run, once
//                       each because the store refuses a second (run, key)
//   scrub_alarm         the run-close scrub made more hold marks than is normal (scrub_alarm_holds): look before the archive reviewer runs
//   scrub_owed          items the run-close scrub did not reach (a crash, a timeout, a cost over the cap or the item cap); the next scrub takes them first
//   stage_overrun       a run-close scrub or archive review that spent its cost cap: nothing was applied, the next attempt takes half the items, and the line names the lever to raise
//   scrub_failed        a run-close scrub or archive review that failed, with its code
//   notes_unembedded    notes stored without a vector (on_embedder_failure keyword), in any project namespace: a count from
//                       the rows, whatever the run. Only `belay memory embed` embeds them. Its ts is the newest such note's
//                       creation time.

const fs = require('node:fs');
const C = require('./config.cjs');
const P = require('./panel-common.cjs');
const { openCore } = require('../core/index.cjs');

const USAGE = 'usage: belay notices [run-id] [--since <ms|iso>] [--stall-ms <n>] [--data <dir>] [--json]\n';
const DEFAULT_STALL_MS = 300000; // ADR 0036 decision 5: five minutes, operator 2026-10-04
const STALL_STATES = ['starting', 'running'];

function usageError(message) {
  return { code: 2, text: `belay notices: ${message}\n\n${USAGE}`, json: { error: message } };
}

// An epoch millisecond integer or an ISO 8601 timestamp, as `belay diff --since` takes it.
function parseSince(raw) {
  if (/^\d+$/.test(raw)) return Number(raw);
  const t = Date.parse(raw);
  return Number.isFinite(t) && /^\d{4}-\d{2}-\d{2}/.test(raw) ? t : null;
}

function parseArgs(argv) {
  let since = null, stallMs = DEFAULT_STALL_MS;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--since') {
      const raw = argv[i += 1];
      const t = raw === undefined ? null : parseSince(raw);
      if (t === null) return { error: `--since needs an epoch millisecond integer or an ISO 8601 timestamp; got ${raw}` };
      since = t; continue;
    }
    if (a === '--stall-ms') {
      const raw = argv[i += 1]; const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) return { error: `--stall-ms needs a positive integer number of milliseconds; got ${raw}` };
      stallMs = n; continue;
    }
    if (typeof a === 'string' && a.startsWith('-')) return { error: `unknown option ${a}` };
    rest.push(a);
  }
  if (rest.length > 1) return { error: `belay notices takes zero or one argument, a run id; got ${rest.length}` };
  if (rest.length === 1 && rest[0] === '') return { error: 'the run id is an empty string' };
  return { runId: rest[0], since, stallMs };
}

const num = (x) => (x == null ? null : Number(x));

// ---- events --------------------------------------------------------------------------------------

function permissionEvents(requests, runId) {
  return requests.map((r) => ({
    kind: 'permission_pending', ts: num(r.requested_at), run_id: runId, worker_id: r.worker_id ?? null, request_id: r.id,
    tool: r.tool ?? null, adapter_alive: r.adapter_alive ?? null, age_ms: r.age_ms ?? null,
    source: `permission row seq ${r.seq}`,
  }));
}

// The row's last_event_at can lag a Claude Code stream by up to about a minute (the adapter rewrites it
// mid-turn only when its last row write is that old, src/run/worker.cjs), so the age is taken from the
// newer of the row and the stream file's mtime, as `status` does (src/core/status.cjs). A stat, not a read.
function stallAge(w, dataDir, now) {
  const rowAge = w.last_event_age_ms != null ? Number(w.last_event_age_ms) : null;
  let streamAge = null;
  if (w.substrate === 'claude-code' && dataDir && !/[\\/]/.test(String(w.id)) && w.id !== '..' && w.id !== '.') {
    try { streamAge = Math.max(0, now - fs.statSync(`${dataDir}/workers/${w.id}/stream.jsonl`).mtimeMs); } catch { /* no stream yet */ }
  }
  if (streamAge != null && (rowAge == null || streamAge < rowAge)) return { age: Math.round(streamAge), source: 'stream mtime' };
  return { age: rowAge, source: 'row' };
}

function workerEvents(workers, runId, stallMs, dataDir = null) {
  const out = [];
  const now = Date.now();
  for (const w of workers) {
    const src = `worker row seq ${w.seq}`;
    if (w.state === 'dead' || w.state === 'stopped') {
      out.push({
        kind: w.state === 'dead' ? 'worker_dead' : 'worker_stopped', ts: num(w.exited_at ?? w.written_at), run_id: runId, worker_id: w.id,
        exit_code: w.exit_code ?? null, exit_signal: w.exit_signal ?? null, death_established_by: w.death_established_by ?? null, source: src,
      });
    } else if (STALL_STATES.includes(w.state) && w.mid_turn) {
      const { age, source } = stallAge(w, dataDir, now);
      if (age != null && age > stallMs) {
        out.push({
          kind: 'worker_stalled', ts: source === 'row' ? num(w.last_event_at) : Math.round(now - age), run_id: runId, worker_id: w.id, state: w.state,
          last_event_age_ms: age, last_event_age_source: source, stall_ms: stallMs, pid: w.pid ?? null, pid_alive: w.pid_alive ?? null, source: src,
        });
      }
    }
  }
  return out;
}

// The verdict check of a review task's results (src/core/verdict.cjs): `detail` carries the verdict,
// who judged it and when the handoff landed. A check that was not executable says why instead.
function verdictEvents(tasks, runId) {
  const out = [];
  for (const t of tasks) {
    const checks = t.results && Array.isArray(t.results.checks) ? t.results.checks : [];
    for (const c of checks) {
      if (!c || c.kind !== 'verdict') continue;
      const d = c.detail && typeof c.detail === 'object' ? c.detail : {};
      out.push({
        kind: 'review_verdict', ts: num(d.handoff_at ?? (t.handoff && t.handoff.at)), run_id: runId, task_id: t.id,
        executable: c.executable ?? null, passed: c.passed ?? null, verdict: d.verdict ?? null, judged_by: d.judged_by ?? null,
        reason: c.executable === false ? (d.reason ?? null) : null, depends_on: Array.isArray(d.depends_on) ? d.depends_on : null,
        source: `task ${t.id} results, verdict check`,
      });
    }
  }
  return out;
}

function runEvents(run) {
  const out = [];
  if (run.paused_at != null && run.ended_at == null) {
    const embedder = /embedder-failure [(]/.test(run.paused_by || '');
    out.push({ kind: 'run_paused', ts: num(run.paused_at), run_id: run.id, paused_by: run.paused_by ?? null, ...(embedder ? { embedder_failure: true } : {}), source: `run row seq ${run.seq}` });
  }
  if (run.ended_at != null) {
    out.push({ kind: 'run_ended', ts: num(run.ended_at), run_id: run.id, exit_reason: run.exit_reason ?? null, source: `run row seq ${run.seq}` });
  }
  return out;
}

// ADR 0043 decision 2. One notice per wrap-up event, keyed by the event's key: the store's partial unique
// index already allows one per (run, key), and the key set here keeps a hand-planted duplicate from showing twice.
function wrapupEvents(events, runId) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    if (e.kind !== 'wrapup') continue;
    const key = e.key ?? e.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: 'memory_wrapup', ts: num(e.written_at), run_id: runId, task_id: e.task_id ?? null, key: e.key ?? null,
      ok: !!e.ok, code: e.code ?? null, text: e.message ?? null, bytes: num(e.bytes), row_ids: e.row_ids ?? null,
      source: `memory_event ${e.id}`,
    });
  }
  return out;
}

// The run-close stages' receipts (the scrubber and the archive reviewer): the alarm, the owed items and a failed stage. A stage that
// worked is a receipt in `belay memory proposals` and the store, not a notice.
const STAGE_KINDS = ['scrub_alarm', 'scrub_owed', 'scrub_job', 'review_stage', 'stage_overrun'];
function stageEvents(events, runId) {
  // An owed receipt is shown only while an id it names is still owed: the last owed receipt for the id, with no later ok scrub_job.
  const stillOwed = new Map();
  events.forEach((e, i) => {
    const ids = Array.isArray(e.row_ids) ? e.row_ids : [];
    if (e.kind === 'scrub_owed') ids.forEach((id) => stillOwed.set(id, i));
    else if (e.kind === 'scrub_job' && e.ok) ids.forEach((id) => stillOwed.delete(id));
  });
  const out = [];
  events.forEach((e, i) => {
    const ok = !!e.ok;
    if (e.kind === 'scrub_owed' && !(Array.isArray(e.row_ids) && e.row_ids.some((id) => stillOwed.get(id) === i))) return;
    const kind = e.kind === 'scrub_alarm' ? 'scrub_alarm' : e.kind === 'scrub_owed' ? 'scrub_owed' : e.kind === 'stage_overrun' ? 'stage_overrun' : !ok ? 'scrub_failed' : null;
    if (!kind) return;
    out.push({ kind, ts: num(e.written_at), run_id: runId, stage: e.kind, ok, code: e.code ?? null, text: e.message ?? null, row_ids: e.row_ids ?? null, source: `memory_event ${e.id}` });
  });
  return out;
}

// The standing count of notes with no vector, one event while there are any (memory.unembedded, a plain read).
function unembeddedEvents(u, runId) {
  if (!u || !(u.total > 0)) return [];
  return [{ kind: 'notes_unembedded', ts: num(u.newest_at), run_id: runId, count: u.total, by_project: u.by_project || {}, command: 'belay memory embed', source: 'memory_entries rows of type note with no vector' }];
}

// Oldest first; an event with no timestamp sorts last, and `--since` keeps it, since nothing proves it is old.
function ordered(events, since) {
  const kept = since == null ? events : events.filter((e) => e.ts == null || e.ts >= since);
  return kept.map((e, i) => [e, i]).sort(([a, i], [b, j]) => {
    if (a.ts == null && b.ts == null) return i - j;
    if (a.ts == null) return 1;
    if (b.ts == null) return -1;
    return a.ts - b.ts || i - j;
  }).map(([e]) => e);
}

// ---- text ----------------------------------------------------------------------------------------

function summaryOf(e) {
  const id = (label, x) => `${label} ${P.v(x, 60)}`;
  switch (e.kind) {
    case 'permission_pending':
      return `${id('request', e.request_id)} ${id('worker', e.worker_id)} tool ${P.v(e.tool, 40)} adapter_alive ${P.v(e.adapter_alive)} age ${P.v(e.age_ms)}ms`;
    case 'worker_dead':
    case 'worker_stopped':
      return `${id('worker', e.worker_id)} exit ${P.v(e.exit_code)}${e.exit_signal ? ` signal ${P.v(e.exit_signal, 20)}` : ''} established by ${P.v(e.death_established_by, 160)}`;
    case 'worker_stalled':
      return `${id('worker', e.worker_id)} ${P.v(e.state, 12)} mid-turn, last event ${e.last_event_age_ms}ms ago by ${P.v(e.last_event_age_source, 20)} (over ${e.stall_ms}ms), pid ${P.v(e.pid)} pid_alive ${P.v(e.pid_alive)}`;
    case 'review_verdict':
      return `${id('task', e.task_id)} verdict ${P.v(e.verdict, 20)} passed ${P.v(e.passed)} executable ${P.v(e.executable)} judged by ${P.v(e.judged_by, 60)}${e.reason ? ` reason ${P.v(e.reason, 120)}` : ''}`;
    case 'memory_wrapup':
      return `${id('key', e.key)} ${e.ok ? P.v(e.text, 600) : `failed ${P.v(e.code, 40)}`}`;
    case 'scrub_alarm':
    case 'scrub_owed':
    case 'scrub_failed':
    case 'stage_overrun':
      return `${e.stage} ${e.code ? `failed ${P.v(e.code, 40)}: ` : ''}${P.v(e.text, 300)}${Array.isArray(e.row_ids) && e.row_ids.length ? ` (notes: ${e.row_ids.slice(0, 5).map((x) => P.v(x, 40)).join(', ')}${e.row_ids.length > 5 ? `, and ${e.row_ids.length - 5} more` : ''})` : ''}`;
    case 'notes_unembedded':
      return P.unembeddedText({ total: e.count, by_project: e.by_project });
    case 'run_paused':
      return `${id('run', e.run_id)} paused by ${P.v(e.paused_by, e.embedder_failure ? 160 : 60)}${e.embedder_failure ? ` (an embedder failure, on_embedder_failure required: belay settings memory.on_embedder_failure keyword|off saves a choice for later runs, belay resume ${e.run_id} --embedder keyword|off resumes with one, or leave it paused)` : ''}`;
    default:
      return `${id('run', e.run_id)} ended, exit_reason ${P.v(e.exit_reason, 60)}`;
  }
}

function renderText(events) {
  if (!events.length) return '(no notices)\n';
  const lines = events.flatMap((e) => P.wrapLine(`${P.iso(e.ts)}  ${e.kind.padEnd(18)}  `, `${summaryOf(e)} [${P.clean(e.source, 80)}]`));
  lines.push('');
  return lines.join('\n');
}

// ---- command -------------------------------------------------------------------------------------

async function run(ctx) {
  const parsed = parseArgs(ctx.argv);
  if (parsed.error) return usageError(parsed.error);

  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);

  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: parsed.runId || 'cli', pid: process.pid } });
  try {
    const { chosen, source } = await P.chooseRun(core, parsed.runId);
    const unembedded = await core.memory.unembedded({});
    if (!chosen) {
      if (!parsed.runId) {
        const events = ordered(unembeddedEvents(unembedded, null), parsed.since);
        const empty = { run_id: null, run_id_source: source, since: parsed.since, stall_ms: parsed.stallMs, events, count: events.length };
        return { code: 0, text: renderText(events), json: empty };
      }
      const message = `no run row exists for ${parsed.runId}`;
      return { code: 1, text: `belay notices: ${P.clean(message)}\n`, json: { error: { code: 'E_NOT_FOUND', message, run_id: parsed.runId } } };
    }
    const { requests } = await core.permission.list({ run_id: chosen.id, states: ['pending'] });
    const { workers } = await core.worker.list({});
    const { tasks } = await core.task.list({});
    const { events: ledger } = await core.memory.events({ run_id: chosen.id, kinds: ['wrapup', ...STAGE_KINDS] });
    const events = ordered([
      ...permissionEvents(requests, chosen.id),
      ...workerEvents(workers.filter((w) => w.run_id === chosen.id), chosen.id, parsed.stallMs, dataDir),
      ...verdictEvents(tasks.filter((t) => t.run_id === chosen.id), chosen.id),
      ...wrapupEvents(ledger, chosen.id),
      ...stageEvents(ledger, chosen.id),
      ...unembeddedEvents(unembedded, chosen.id),
      ...runEvents(chosen),
    ], parsed.since);
    const receipt = {
      run_id: chosen.id, run_id_source: source, since: parsed.since, stall_ms: parsed.stallMs,
      events, count: events.length, owner: core.ownerInfo(),
    };
    return { code: 0, text: renderText(events), json: receipt };
  } catch (e) {
    return { code: 1, text: `belay notices: ${P.clean(e.message, 200)}\n`, json: { error: { code: e.code || 'E_INTERNAL', message: e.message } } };
  } finally {
    await core.close();
  }
}

module.exports = { run, stageEvents, wrapupEvents, verdictEvents, runEvents, ordered, workerEvents, stallAge, renderText };
